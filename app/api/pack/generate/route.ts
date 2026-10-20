/**
 * POST /api/pack/generate
 *
 * Главный оркестратор «Generate Pack»:
 *   1. Тянет архив (winners / fake_winners / losers) — анализ массива
 *   2. Тянет библиотеку ФОРМУЛИРОВОК продукта (уникальные дословные тексты, коды MH483920 / BA102938)
 *   3. Тянет approved competitor_concepts
 *   4. Claude генерит 20 слотов с distribution 55/25/20
 *      (или 0/80/20 в cold start если нет винеров)
 *   5. Новые тексты (new_formulations) → formulations с новыми кодами, ссылки NEW:n в слотах заменяются кодами
 *   6. Сохраняет session с pack_metadata
 *
 * Не запускает generate-briefs сразу — это делает фронт через POST /api/ai/generate-briefs
 * когда пользователь готов к финальному «жать кнопку».
 */
import Anthropic from "@anthropic-ai/sdk";
import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";
import { parseAdNameWithMapping, type AdNameMapping } from "@/lib/naming";
import { getAiContext, getBusiness } from "@/lib/brief";
import { getSettings } from "@/lib/settings";
import type { Format, AdFlow, PackMetadata, PackSlot, PackSlotCategory } from "@/lib/types";
import { matchesProduct, isProduct, productMeta, type Product } from "@/lib/product";
import { loadLatestReport, loadReportById, reportRef, reportContextBlock, reportAgeDays, type ReportRow } from "@/lib/report-context";
import { AXES, AXIS_LABEL, ensureFormulation, loadFormulations, type Axis, type Formulation, type FormulationProduct } from "@/lib/formulations";
import { loadEngineData } from "@/lib/pack-data";
import { designPack, DEFAULT_BLOCKED_CONCEPTS } from "@/lib/pack-engine";

// Текст ответа Claude: у моделей 5-го поколения первый блок content может быть не text (напр. thinking/summary),
// поэтому склеиваем все text-блоки и падаем с понятной ошибкой, если текста нет.
function claudeText(msg: { content: Array<{ type: string; text?: string }>; stop_reason?: string | null }): string {
  const text = msg.content.filter(b => b.type === "text").map(b => b.text ?? "").join("");
  if (!text.trim()) throw new Error(`Модель не вернула текст (stop_reason=${msg.stop_reason ?? "?"}, блоков: ${msg.content.map(b => b.type).join(",") || "0"})`);
  return text;
}


export const maxDuration = 300;

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const PACK_SIZE_DEFAULT = 20;
// Распределение 55/25/20 — winner_family получает округлённый остаток
// чтобы сумма всегда совпадала с packSize.
function buildDist(packSize: number, coldStart: boolean): Record<PackSlotCategory, number> {
  if (coldStart) {
    const comp = Math.max(1, Math.round(packSize * 0.20));
    return { winner_family: 0, winner_mix: 0, discovery: packSize - comp, competitor: comp, transfer: 0 };
  }
  const winnerMix = Math.round(packSize * 0.25);
  const discovery = Math.round(packSize * 0.25);
  const competitor = Math.round(packSize * 0.20);
  const winnerFamily = Math.max(0, packSize - winnerMix - discovery - competitor);
  return { winner_family: winnerFamily, winner_mix: winnerMix, discovery, competitor, transfer: 0 };
}

interface RequestBody {
  flow?:    AdFlow;      // устарело: потоков нет, пак строится на всём массиве
  format:   Format;
  conceptCode?: string | null; // (режим claude) V-код концепции — весь пак в этой концепции
  product?: string;            // buchhalter | medadmin — архив, бивариат и отчёт-гейт берутся по этому продукту
  packSize?: number;
  override?: boolean;   // обойти гейт проверки отчёта (warning/fail)
  // ── режим движка (по умолчанию, 08.10.2026): детерминированный дизайн эксперимента
  mode?: "engine" | "claude";
  reportId?: string;                 // отчёт-основа (по умолчанию последний по продукту)
  slots?: PackSlot[];                // готовые слоты из предпросмотра /api/pack/propose (после правок человека)
  exploreConcepts?: string[]; autoExplore?: number; blockedConcepts?: string[]; actorPool?: string[] | null;
  actorKind?: "ai" | "real" | null; transfer?: boolean;
  shares?: { scale: number; family: number; explore: number; transfer: number };
}

interface ConceptRow { code: string; name: string; category: string | null; description: string | null; when_works: string | null; example: string | null; ours_note: string | null }

interface CodeRow { code: string | null; name: string; description?: string | null; adCount?: number }

// Любое исключение — JSON с текстом ошибки (а не пустой 500), чтобы конструктор показал причину.
export async function POST(req: NextRequest) {
  try {
    return await generatePack(req);
  } catch (e) {
    const msg = e instanceof Error ? `${e.message}${e.stack ? "\n" + e.stack.split("\n").slice(1, 4).join("\n") : ""}` : String(e);
    console.error("[pack/generate]", msg);
    return NextResponse.json({ error: `Генерация пака упала: ${msg.slice(0, 1500)}` }, { status: 500 });
  }
}

async function generatePack(req: NextRequest) {
  const body = (await req.json()) as RequestBody;
  const { format } = body;
  const conceptCode = body.conceptCode?.trim() || null;
  const product: Product = isProduct(body.product) ? body.product : "all";
  const flow: AdFlow = "com"; // служебное значение для колонки сессии; на данные не влияет
  const packSize = Math.max(3, Math.min(50, Number(body.packSize) || PACK_SIZE_DEFAULT));
  if (!format) {
    return NextResponse.json({ error: "format обязателен" }, { status: 400 });
  }

  const supabase = createServiceClient();

  // ── Основа пака — отчёт продукта (указанный или последний: meta → all → любой). Без отчёта пак не строим:
  // виннеры/лузеры, сигналы и рекомендации берутся из него, а не из живого view.
  const report: ReportRow | null = body.reportId ? await loadReportById(supabase, body.reportId) : await loadLatestReport(supabase, product);
  if (!report) {
    return NextResponse.json({
      error: `Нет отчёта по продукту «${productMeta(product).label}». Сначала собери отчёт на вкладке «Отчёт» — конструктор строится на нём.`,
      gate: "no_report",
    }, { status: 409 });
  }
  // ── Гейт проверки: не строим пак на отчёте, которому проверка не доверяет ──
  // overall=ok → пускаем; warning → нужно подтверждение (override); fail → блок (override).
  if (!body.override) {
    const v = report.verifications;
    const overall = v?.overall;
    if (overall === "fail" || overall === "warning") {
      const issues = (v?.checks ?? [])
        .flatMap(c => (c.issues ?? []).map(i => ({ model: c.model, severity: i.severity, area: i.area, detail: i.detail })))
        .slice(0, 12);
      return NextResponse.json({
        error: overall === "fail"
          ? "Проверка отчёта НЕ пройдена — генерация заблокирована. Перегенерируй отчёт или подтверди принудительно."
          : "Проверка отчёта с сомнениями — подтверди генерацию.",
        gate: overall, overall, issues, report: reportRef(report),
      }, { status: 409 });
    }
  }

  const settings = await getSettings();
  // Новые формулировки создаются под конкретный продукт — пак «оба продукта» не собираем.
  if (product === "all") {
    return NextResponse.json({ error: "Выбери продукт (Бухгалтер или Медадмин) в сайдбаре — формулировки и коды привязаны к продукту." }, { status: 400 });
  }
  const formProduct: FormulationProduct = product;

  // ── Режим движка (по умолчанию): слоты из предпросмотра или дизайн эксперимента здесь же; Claude не участвует.
  if ((body.mode ?? "engine") === "engine") {
    const data = await loadEngineData(supabase, formProduct);
    const rows = (report.snapshot?.rows ?? []).map(r => ({ ad_name: r.ad_name, auto_status: r.auto_status, spend: Number(r.spend ?? 0), cpl: r.cpl, cpql: r.cpql, leads: Number(r.leads ?? 0) }));
    const constraints = { exploreConcepts: body.exploreConcepts ?? [], blockedConcepts: body.blockedConcepts ?? DEFAULT_BLOCKED_CONCEPTS, actorPool: body.actorPool ?? null, autoExplore: body.autoExplore ?? 2 };
    const designed = body.slots?.length ? null : designPack({
      format, packSize, rows, lifetimeRows: data.lifetimeRows, medium: data.medium, mapping: data.mapping, formulations: data.formulations, concepts: data.concepts, actors: data.actors, usage: data.usage,
      exploreConcepts: constraints.exploreConcepts, autoExplore: constraints.autoExplore, blockedConcepts: constraints.blockedConcepts, actorPool: constraints.actorPool, actorKind: body.actorKind ?? null, transfer: body.transfer ?? true, shares: body.shares,
    });
    const known = new Set(data.formulations.map(f => f.code));
    const conceptCodes = new Set(data.concepts.map(c => c.code.toUpperCase()));
    const actorCodes = new Set(data.actors.map(a => a.code.toUpperCase()));
    // Валидация слотов из предпросмотра: только реальные коды; обязательны хук, боди и энгл. Персона необязательна
    // (null, если нет прямого обращения) — требование персоны 16.10.2026 молча выкинуло 15 слотов из 20.
    const slotsIn: PackSlot[] = (designed?.slots ?? body.slots ?? []).map((s, i) => ({
      slotId: i + 1, category: s.category, rationale: s.rationale ?? "", basedOnAd: s.basedOnAd, variedParam: s.variedParam, fromWinners: s.fromWinners, helpsCodes: s.helpsCodes, change: s.change ?? null,
      codes: {
        persona: s.codes.persona && known.has(s.codes.persona) ? s.codes.persona : null, hook: s.codes.hook && known.has(s.codes.hook) ? s.codes.hook : null,
        body: s.codes.body && known.has(s.codes.body) ? s.codes.body : null, angle: s.codes.angle && known.has(s.codes.angle) ? s.codes.angle : null,
        concept: s.codes.concept && conceptCodes.has(s.codes.concept.toUpperCase()) ? s.codes.concept.toUpperCase() : null,
        actor: s.codes.actor && actorCodes.has(s.codes.actor.toUpperCase()) ? s.codes.actor.toUpperCase() : null,
      },
    }));
    const complete = slotsIn.filter(s => s.codes.hook && s.codes.body && s.codes.angle);
    const droppedSlots = slotsIn.filter(s => !complete.includes(s)).map(s => `#${s.slotId}: нет ${[!s.codes.hook && "хука", !s.codes.body && "боди", !s.codes.angle && "энгла"].filter(Boolean).join(", ")}`);
    if (!complete.length) return NextResponse.json({ error: "Движок не собрал ни одного полного слота: в отчёте нет виннеров с полным набором формулировок. Разметь крео виннеров на /mapping или выбери другой отчёт." }, { status: 422 });
    // Принятый пак должен совпадать с предпросмотром: если часть слотов отброшена, не сохраняем молча — отдаём причину
    if (droppedSlots.length) return NextResponse.json({ error: `Пак не сохранён: ${droppedSlots.length} из ${slotsIn.length} слотов без обязательной формулировки (${droppedSlots.slice(0, 5).join("; ")}${droppedSlots.length > 5 ? "; …" : ""}). Пересобери пак.` }, { status: 422 });
    const slotsE = complete.map((s, i) => ({ ...s, slotId: i + 1 }));
    const matrix = designed?.matrix ?? [];
    const notes = designed?.notes ?? [];
    const dist: Record<PackSlotCategory, number> = {
      winner_family: slotsE.filter(s => s.category === "winner_family").length, winner_mix: slotsE.filter(s => s.category === "winner_mix").length,
      discovery: slotsE.filter(s => s.category === "discovery").length, competitor: slotsE.filter(s => s.category === "competitor").length,
      transfer: slotsE.filter(s => s.category === "transfer").length,
    };
    const winnersN = rows.filter(r => r.auto_status === "winner").length;
    const packMetadata: PackMetadata = {
      slots: slotsE, distribution: dist, cold_start: winnersN === 0, format, concept: null, product, report: reportRef(report), flow,
      experiment: { matrix, notes, mode: "engine" }, constraints,
      data_snapshot: { winners: winnersN, fake_winners: rows.filter(r => r.auto_status === "fake_winner").length, losers: rows.filter(r => r.auto_status === "loser").length, approved_competitors: 0 },
    };
    const today = new Date().toISOString().slice(0, 10);
    const exploreTag = constraints.exploreConcepts.length ? ` · разведка ${constraints.exploreConcepts.join("+")}` : "";
    const { data: session, error: sessErr } = await supabase.from("constructor_sessions").insert({
      name: `Pack ${today} · ${productMeta(product).label} · ${format} · эксперимент ${slotsE.length}${exploreTag}`,
      flow, format, total_combinations: slotsE.length, pack_size: slotsE.length, pack_metadata: packMetadata, generated_at: new Date().toISOString(), status: "draft",
      selected_personas: [], selected_hooks: [], selected_bodies: [], selected_angles: [],
    }).select("id").single();
    if (sessErr) return NextResponse.json({ error: `DB insert error: ${sessErr.message}` }, { status: 500 });
    return NextResponse.json({ ok: true, sessionId: session?.id, packMetadata, report: { ...reportRef(report), ageDays: reportAgeDays(report), fromSnapshot: true }, mode: "engine", dropped: slotsIn.length - complete.length });
  }

  // ── 1. Библиотека формулировок продукта (уникальные дословные тексты) + использование ──
  const [forms, mappingRes] = await Promise.all([
    loadFormulations(supabase, { product: formProduct }),
    supabase.from("ad_name_mapping").select("ad_name, persona_code, hook_code, body_code, angle_code, format, flow, concept_code, actor_code"),
  ]);
  const usage: Record<string, number> = {};
  for (const r of mappingRes.data ?? []) for (const c of [r.persona_code, r.hook_code, r.body_code, r.angle_code, r.actor_code]) if (c) usage[c] = (usage[c] ?? 0) + 1;
  // Ось «актёр»: кто в кадре (реальные по имени, ИИ-персонажи WOM/MAN). Для видео обязателен в каждом слоте.
  const { data: actorRows } = await supabase.from("actors").select("code, name, kind, gender, description").order("kind").order("code");
  type ActorRow = { code: string; name: string; kind: string; gender: string | null; description: string | null };
  const actors = ((actorRows ?? []) as ActorRow[]).map(a => ({ ...a, adCount: usage[a.code] ?? 0 })).sort((a, b) => b.adCount - a.adCount);
  const byAxis = (axis: Axis): CodeRow[] => forms.filter(f => f.axis === axis)
    .map(f => ({ code: f.code, name: f.text, adCount: usage[f.code] ?? 0 }))
    .sort((a, b) => (b.adCount ?? 0) - (a.adCount ?? 0));
  const personas = byAxis("persona"), hooks = byAxis("hook"), bodies = byAxis("body"), angles = byAxis("angle");
  const mapping: AdNameMapping[] = (mappingRes.data ?? []).map(r => ({
    adName: r.ad_name, personaCode: r.persona_code, hookCode: r.hook_code,
    bodyCode: r.body_code, angleCode: r.angle_code, format: r.format, flow: r.flow, conceptCode: r.concept_code ?? null, actorCode: r.actor_code ?? null,
  }));

  // ── 2. Архив креативов — строки ОТЧЁТА (snapshot: виннеры/fake/лузеры за его период и продукт).
  // Старые отчёты без snapshot → живой view по продукту (fallback).
  type PerfRow = { ad_name: string; campaign_name?: string | null; adset_name?: string | null; auto_status: string; risk_signals: unknown; spend: number; cpl: number | null; cpql: number | null; cr_lead_to_qual: number | null; roas: number | null; leads: number; qual_leads: number; flow?: string | null };
  let all: PerfRow[];
  const fromSnapshot = !!report.snapshot?.rows?.length;
  if (fromSnapshot) {
    all = (report.snapshot!.rows).map(r => ({ ...r, flow: null }));
  } else {
    const { data: perfData } = await supabase
      .from("creative_performance")
      .select("ad_name, campaign_name, adset_name, auto_status, risk_signals, spend, cpl, cpql, cr_lead_to_qual, roas, leads, qual_leads, flow")
      .eq("platform", "meta");
    all = ((perfData ?? []) as PerfRow[]).filter(r => matchesProduct(r, product));
  }
  const withCodes = all.map(r => ({
    row: r,
    parts: parseAdNameWithMapping(String(r.ad_name ?? ""), mapping),
  }));

  const winners     = withCodes.filter(x => x.row.auto_status === "winner");
  const fakeWinners = withCodes.filter(x => x.row.auto_status === "fake_winner");
  const losers      = withCodes.filter(x => x.row.auto_status === "loser");
  const approvedCompetitors = await loadApprovedCompetitors(supabase);

  // ── 3. Cold start guard ──────────────────────────────────────────────────────
  const coldStart = winners.length === 0;
  if (coldStart && approvedCompetitors.length === 0) {
    return NextResponse.json({
      error: "Нет данных: ни одного винера в архиве и ни одного одобренного концепта конкурентов. " +
             "Загрузи концепты в /competitors (status=approved) или дождись пока появятся винеры.",
    }, { status: 400 });
  }
  let dist: Record<PackSlotCategory, number> = buildDist(packSize, coldStart);
  // Edge case: винеры есть, но нет одобренных конкурентов → competitor-слоты бесполезны,
  // перераспределяем их в discovery (тот же дух «новые гипотезы»).
  if (approvedCompetitors.length === 0 && !coldStart) {
    dist = { ...dist, discovery: dist.discovery + dist.competitor, competitor: 0 };
  }

  // ── 4. Бивариативный сигнал (HELPS / HURTS коды для discovery-слотов) ──────
  const quick = computeQuickBivariate(withCodes);
  const fromReport: BivariateSignal[] = [
    ...(report.visual.helps ?? []).map(h => ({ code: h.code, paramType: h.paramType as BivariateSignal["paramType"], verdict: "HELPS" as const, ratio: h.ratio })),
    ...(report.visual.hurts ?? []).map(h => ({ code: h.code, paramType: h.paramType as BivariateSignal["paramType"], verdict: "HURTS" as const, ratio: h.ratio })),
  ];
  const seenCodes = new Set(fromReport.map(b => b.code));
  const bivariate: BivariateSignal[] = [...fromReport, ...quick.filter(b => !seenCodes.has(b.code))];

  // ── 4b. Концепция видео (если выбрана) — описание в промпт, код во все слоты ──
  let concept: ConceptRow | null = null;
  if (conceptCode) {
    const { data: c } = await supabase.from("concepts")
      .select("code, name, category, description, when_works, example, ours_note").eq("code", conceptCode).maybeSingle();
    if (!c) return NextResponse.json({ error: `Концепция ${conceptCode} не найдена в библиотеке` }, { status: 400 });
    concept = c as ConceptRow;
  }

  // ── 5. Claude промпт → 20 слотов JSON ──────────────────────────────────────
  const claudeJson = await askClaudeForSlots({
    flow, format, concept, product, report, dist, coldStart, packSize,
    personas, hooks, bodies, angles, actors,
    winners, fakeWinners, losers, approvedCompetitors,
    bivariate, settings: { cplTarget: settings.cplTarget, cpqlTarget: settings.cpqlTarget },
  });

  // ── 6. Новые дословные тексты → формулировки с кодами; ссылки NEW:n в слотах → коды ─────
  const { refToCode, createdCodes } = await persistNewFormulations(supabase, formProduct, claudeJson.new_formulations ?? []);
  const known = new Set(forms.map(f => f.code));
  const resolveCode = (axis: Axis, v: unknown): string | null => {
    if (typeof v !== "string" || !v.trim()) return null;
    const t = v.trim();
    if (refToCode[t]) return refToCode[t];
    const up = t.toUpperCase();
    if (known.has(up) || createdCodes.includes(up)) return up;
    // Код не из библиотеки — выдумка модели, не пропускаем (параметр должен быть реальной формулировкой)
    return forms.find(f => f.axis === axis && f.text === t)?.code ?? null;
  };

  // ── 7. Финальный pack_metadata ─────────────────────────────────────────────
  const actorCodes = new Set(actors.map(a => a.code.toUpperCase()));
  const resolveActor = (v: unknown): string | null => {
    const t = typeof v === "string" ? v.trim().toUpperCase() : "";
    return t && actorCodes.has(t) ? t : null;
  };
  const slotsAll: PackSlot[] = (claudeJson.slots ?? []).map((s: Record<string, unknown>, i: number) => {
    const raw = (s.codes ?? {}) as Record<string, unknown>;
    const codes: PackSlot["codes"] = {
      persona: resolveCode("persona", raw.persona), hook: resolveCode("hook", raw.hook),
      body: resolveCode("body", raw.body), angle: resolveCode("angle", raw.angle), concept: concept?.code ?? null,
      actor: resolveActor(raw.actor),
    };
    const newCodes = AXES.map(a => codes[a]).filter((c): c is string => !!c && createdCodes.includes(c));
    return {
    slotId:           Number(s.slot_id ?? i + 1),
    category:         s.category as PackSlotCategory,
    codes,
    rationale:        String(s.rationale ?? ""),
    basedOnAd:        s.based_on_ad as string | undefined,
    variedParam:      s.varied_param as PackSlot["variedParam"],
    fromWinners:      s.from_winners as string[] | undefined,
    helpsCodes:       s.helps_codes as string[] | undefined,
    sourceConceptId:  s.source_concept_id as string | undefined,
    newCodesCreated:  newCodes.length ? newCodes : undefined,
  }; });
  // Каждый параметр обязателен: слот без персоны/хука/боди/энгла (или без актёра для видео) в пак не идёт.
  const needActor = format !== "static";
  const incomplete = slotsAll.filter(sl => !sl.codes.hook || !sl.codes.body || !sl.codes.angle || (needActor && !sl.codes.actor)); // персона необязательна
  const slots = slotsAll.filter(sl => !incomplete.includes(sl)).map((sl, i) => ({ ...sl, slotId: i + 1 }));
  if (slots.length === 0) {
    return NextResponse.json({ error: `Модель не собрала ни одного полного слота (персона + хук + боди + энгл${needActor ? " + актёр" : ""}). Повтори генерацию.` }, { status: 502 });
  }

  const packMetadata: PackMetadata = {
    slots,
    distribution: dist,
    cold_start: coldStart,
    format,
    concept: concept ? { code: concept.code, name: concept.name } : null,
    product,
    report: reportRef(report),
    flow,
    data_snapshot: {
      winners: winners.length,
      fake_winners: fakeWinners.length,
      losers: losers.length,
      approved_competitors: approvedCompetitors.length,
    },
  };

  // ── 8. Сохраняем session ───────────────────────────────────────────────────
  const today = new Date().toISOString().slice(0, 10);
  const sessionName = `Pack ${today} · ${productMeta(product).label} · ${format}${concept ? ` · ${concept.code} ${concept.name}` : ""}`;

  const uniqueCodes = (key: keyof PackSlot["codes"]) =>
    Array.from(new Set(slots.map(s => s.codes[key]).filter((c): c is string => !!c)));

  const { data: session, error: sessErr } = await supabase
    .from("constructor_sessions")
    .insert({
      name: sessionName,
      flow,
      format,
      total_combinations: packSize,
      pack_size: packSize,
      pack_metadata: packMetadata,
      generated_at: new Date().toISOString(),
      status: "draft",
      // selected_* поля оставляем пустыми (старая ручная семантика не нужна)
      selected_personas: [],
      selected_hooks:    [],
      selected_bodies:   [],
      selected_angles:   [],
    })
    .select("id")
    .single();

  if (sessErr) {
    return NextResponse.json({ error: `DB insert error: ${sessErr.message}` }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    sessionId: session?.id,
    packMetadata,
    report: { ...reportRef(report), ageDays: reportAgeDays(report), fromSnapshot },
    newFormulations: createdCodes,
    droppedIncomplete: incomplete.length,   // слоты без какого-то параметра — отброшены
    cold_start: coldStart,
    used_uniqueCodes: {
      personas: uniqueCodes("persona"),
      hooks:    uniqueCodes("hook"),
      bodies:   uniqueCodes("body"),
      angles:   uniqueCodes("angle"),
    },
  });
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function loadApprovedCompetitors(supabase: ReturnType<typeof createServiceClient>) {
  const { data } = await supabase
    .from("competitor_concepts")
    .select("id, source, raw_data, status, ad_name, ad_text, ad_offer, ad_psychology")
    .eq("status", "approved")
    .limit(30);
  return data ?? [];
}

interface BivariateSignal {
  code: string;
  paramType: "persona" | "hook" | "body" | "angle" | "concept" | "actor";
  verdict: "HELPS" | "HURTS" | "NEUTRAL" | "INSUFFICIENT";
  ratio: number | null;
}

type WithCodes = {
  row: { ad_name: string; auto_status: string; spend: number; leads: number; cpl: number | null };
  parts: { personaCode: string | null; hookCode: string | null; bodyCode: string | null; angleCode: string | null };
};

function computeQuickBivariate(rows: WithCodes[]): BivariateSignal[] {
  const results: BivariateSignal[] = [];
  const params: Array<{ type: BivariateSignal["paramType"]; key: keyof WithCodes["parts"] }> = [
    { type: "persona", key: "personaCode" },
    { type: "hook",    key: "hookCode" },
    { type: "body",    key: "bodyCode" },
    { type: "angle",   key: "angleCode" },
  ];
  for (const { type, key } of params) {
    const codes = Array.from(new Set(rows.map(r => r.parts[key]).filter((c): c is string => !!c)));
    for (const code of codes) {
      const withAds = rows.filter(r => r.parts[key] === code);
      const without = rows.filter(r => r.parts[key] !== code);
      const wSpend = withAds.reduce((s, r) => s + Number(r.row.spend ?? 0), 0);
      const wLeads = withAds.reduce((s, r) => s + Number(r.row.leads ?? 0), 0);
      const oSpend = without.reduce((s, r) => s + Number(r.row.spend ?? 0), 0);
      const oLeads = without.reduce((s, r) => s + Number(r.row.leads ?? 0), 0);
      const wCpl = wLeads > 0 ? wSpend / wLeads : null;
      const oCpl = oLeads > 0 ? oSpend / oLeads : null;
      const ratio = wCpl != null && oCpl != null ? wCpl / oCpl : null;
      const verdict: BivariateSignal["verdict"] =
        ratio == null || wLeads < 3 || oLeads < 3 ? "INSUFFICIENT" :
        ratio < 0.75 ? "HELPS" : ratio > 1.33 ? "HURTS" : "NEUTRAL";
      results.push({ code, paramType: type, verdict, ratio: ratio != null ? Math.round(ratio * 1000) / 1000 : null });
    }
  }
  return results;
}

// ── Claude prompt ────────────────────────────────────────────────────────────

interface AskInput {
  flow: AdFlow;
  format: Format;
  concept: ConceptRow | null;
  product: Product;
  report: ReportRow;
  dist: Record<PackSlotCategory, number>;
  coldStart: boolean;
  packSize: number;
  personas: CodeRow[];
  hooks:    CodeRow[];
  bodies:   CodeRow[];
  angles:   CodeRow[];
  actors:   Array<{ code: string; name: string; kind: string; gender: string | null; description: string | null; adCount: number }>;
  winners:     WithCodes[];
  fakeWinners: WithCodes[];
  losers:      WithCodes[];
  approvedCompetitors: Array<{ id: string; source?: string; ad_name?: string | null; ad_text?: string | null; ad_offer?: string | null; ad_psychology?: string | null }>;
  bivariate: BivariateSignal[];
  settings: { cplTarget: number; cpqlTarget: number };
}

interface ClaudeResponse {
  slots: Array<Record<string, unknown>>;
  // Новые дословные тексты: модель НЕ придумывает коды — ставит ссылку NEW:n, код выдаёт система
  new_formulations?: Array<{ ref: string; axis: Axis | string; text: string }>;
}

async function askClaudeForSlots(inp: AskInput): Promise<ClaudeResponse> {
  const briefDesc = `${getBusiness().name}\n\n${getAiContext()}`;

  // Библиотека в промпт: формулировки с использованием первыми, не больше 120 на ось (иначе промпт раздувается)
  const codesBlock = (rows: CodeRow[]) =>
    rows.length === 0 ? "  (нет)" : rows.slice(0, 120).map(r => `  ${r.code} [${r.adCount ?? 0} крео]: «${r.name.replace(/\s+/g, " ").slice(0, 220)}»`).join("\n")
      + (rows.length > 120 ? `\n  … ещё ${rows.length - 120} формулировок без использования не показаны` : "");

  const winnersBlock = inp.winners.slice(0, 15).map(w =>
    `  ${w.row.ad_name} · CPL €${Number(w.row.cpl).toFixed(1)} · spend €${Number(w.row.spend).toFixed(0)} · коды: P=${w.parts.personaCode ?? "?"} H=${w.parts.hookCode ?? "?"} B=${w.parts.bodyCode ?? "?"} A=${w.parts.angleCode ?? "?"}`
  ).join("\n");

  const fakeBlock = inp.fakeWinners.slice(0, 15).map(w =>
    `  ${w.row.ad_name} · CPL €${Number(w.row.cpl).toFixed(1)} · spend €${Number(w.row.spend).toFixed(0)} · коды: P=${w.parts.personaCode ?? "?"} H=${w.parts.hookCode ?? "?"} B=${w.parts.bodyCode ?? "?"} A=${w.parts.angleCode ?? "?"}`
  ).join("\n");

  const losersBlock = inp.losers.slice(0, 10).map(w =>
    `  ${w.row.ad_name} · CPL €${Number(w.row.cpl ?? 0).toFixed(1)} · коды: P=${w.parts.personaCode ?? "?"} H=${w.parts.hookCode ?? "?"} B=${w.parts.bodyCode ?? "?"} A=${w.parts.angleCode ?? "?"}`
  ).join("\n");

  const bivariateBlock = inp.bivariate
    .filter(b => b.verdict === "HELPS" || b.verdict === "HURTS")
    .sort((a, b) => Math.abs((a.ratio ?? 1) - 1) > Math.abs((b.ratio ?? 1) - 1) ? -1 : 1)
    .slice(0, 20)
    .map(b => `  ${b.code} (${b.paramType}) → ${b.verdict} (ratio ${b.ratio})`)
    .join("\n");

  const competitorsBlock = inp.approvedCompetitors.slice(0, 15).map((c, i) =>
    `  [comp-${i + 1}] id=${c.id} · "${(c.ad_name ?? "").slice(0, 50)}"\n    text: ${(c.ad_text ?? "").slice(0, 150)}\n    offer: ${(c.ad_offer ?? "").slice(0, 100)}\n    psychology: ${(c.ad_psychology ?? "").slice(0, 100)}`
  ).join("\n");

  const prompt = `Ты — стратег рекламных креативов Meta Ads.

${briefDesc}

Цели: CPL ≤ €${inp.settings.cplTarget}, CPQL ≤ €${inp.settings.cpqlTarget}.
Продукт: ${inp.product === "all" ? "оба (Бухгалтер + Медадмин) — архив смешанный" : inp.product === "buchhalter" ? "курс «Бухгалтер в Германии» — архив, винеры и бивариат только по нему" : "курс «Медадмин / Praxismanager» — архив, винеры и бивариат только по нему"}
Формат производства: ${inp.format.toUpperCase()}
${inp.concept ? `Концепция видео (type of video) для ВСЕГО пака: ${inp.concept.code} — ${inp.concept.name}${inp.concept.category ? ` (${inp.concept.category})` : ""}
  Что это: ${inp.concept.description ?? "—"}
  Когда работает: ${inp.concept.when_works ?? "—"}
  Пример: ${inp.concept.example ?? "—"}
  Наш опыт: ${inp.concept.ours_note ?? "ещё не запускали"}
  Все комбинации P/H/B/A подбирай так, чтобы они естественно раскрывались в этой концепции; в codes каждого слота ставь "concept": "${inp.concept.code}".` : "Концепция видео не задана — комбинации свободные."}

## ОСНОВА ПАКА — ПОСЛЕДНИЙ ОТЧЁТ ПО ПРОДУКТУ
Пак строится на этом отчёте: его виннеры/лузеры (архив ниже — из него), его HELPS/HURTS и его рекомендации.
Если рекомендации отчёта называют конкретные направления, форматы, коды или крео для размножения — они приоритетнее общих правил.
${reportContextBlock(inp.report, "full")}

ЗАДАЧА: сформировать ровно ${inp.packSize} креативов в следующем распределении:
  • winner_family — ${inp.dist.winner_family} креативов: «семьи» вокруг винеров, варьируется ровно 1 параметр
  • winner_mix    — ${inp.dist.winner_mix} креативов: свободная смесь P/H/B/A из винеров (новые комбинации)
  • discovery     — ${inp.dist.discovery} креативов: непротестированные комбинации из HELPS-кодов
  • competitor    — ${inp.dist.competitor} креативов: на основе одобренных концептов конкурентов
${inp.coldStart ? "\n⚠️  COLD START: винеров нет, размножать нечего. Только discovery + competitor.\n  Discovery строим из brief context + ai_context. Бивариата нет — комбинируй здраво.\n" : ""}

## БИБЛИОТЕКА ФОРМУЛИРОВОК
Каждый код = ОДНА уникальная ДОСЛОВНАЯ формулировка (текст в кавычках — ровно то, что звучит/написано в креативе). Это не категории: любой другой текст — другая формулировка. Код в слоте означает «в креативе будет именно этот текст».
Персоны (дословное обращение к аудитории; может отсутствовать → null):
${codesBlock(inp.personas)}
Хуки:
${codesBlock(inp.hooks)}
Боди:
${codesBlock(inp.bodies)}
Энглы:
${codesBlock(inp.angles)}

## АКТЁРЫ (кто в кадре; код как есть — не формулировка)
${inp.actors.length ? inp.actors.slice(0, 60).map(a => `  ${a.code} [${a.kind === "real" ? "реальный" : "ИИ"}${a.gender ? `, ${a.gender}` : ""}, ${a.adCount} крео]: ${a.name}${a.description ? ` — ${a.description.replace(/\s+/g, " ").slice(0, 120)}` : ""}`).join("\n") : "  (нет)"}
${inp.format !== "static" ? "Для видео актёр ОБЯЗАТЕЛЕН в каждом слоте. Крео производятся ИИ (Higgsfield): ставь ИИ-персонажей (WOM/MAN); реальных людей — ТОЛЬКО для формата HUMAN. Предпочитай актёров с крео у виннеров." : "Для статики актёр не нужен (null)."}

## АРХИВ
ВИННЕРЫ (${inp.winners.length}):
${winnersBlock || "  (нет)"}

FAKE WINNERS (${inp.fakeWinners.length}) — НЕ КОПИРУЕМ как винеров:
${fakeBlock || "  (нет)"}

ЛУЗЕРЫ (${inp.losers.length}) — комбинации с этими кодами избегаем:
${losersBlock || "  (нет)"}

## БИВАРИАТИВНЫЙ АНАЛИЗ
${bivariateBlock || "  (недостаточно данных)"}

## ОДОБРЕННЫЕ КОНЦЕПТЫ КОНКУРЕНТОВ (${inp.approvedCompetitors.length})
${competitorsBlock || "  (нет одобренных)"}

## ПРАВИЛА
1. winner_family: бери винер из списка, варьируй ровно один параметр (persona/hook/body/angle).
   Замена — существующая формулировка с HELPS-вердиктом или не встречавшаяся в винерах, либо НОВАЯ формулировка (см. п.4). НЕ ставь HURTS-коды.
   Остальные три кода — ТЕ ЖЕ, что у винера: так крео переиспользует дословные формулировки и параметр становится измеримым.
2. winner_mix: коды формулировок из винеров в новых комбинациях (не повторяющих существующий винер). Все коды — из библиотеки.
3. discovery: HELPS-формулировки из бивариата + комбинации, которых НЕ было в архиве. Коды — из библиотеки или новые (п.4).
4. НОВАЯ формулировка (competitor-слоты, discovery): ты НЕ придумываешь код. В codes ставь ссылку "NEW:1", "NEW:2", …
   и опиши её в new_formulations: { "ref": "NEW:1", "axis": "hook", "text": "<дословный текст, который прозвучит/будет написан в креативе>" }.
   Текст — готовая реплика/надпись на языке аудитории (русский, немецкие термины как есть), не описание и не категория.
   Один и тот же NEW:n можно поставить в несколько слотов — тогда формулировка переиспользуется (это хорошо для измеримости).
   Указывай source_concept_id для competitor-слотов.
5. Все ${inp.packSize} слотов — РАЗНЫЕ комбинации кодов.
6. ЗАПРЕЩЕНО повторять комбинацию, которая уже есть в винерах или лузерах.
7. Любой код в codes обязан быть либо кодом из библиотеки выше, либо ссылкой NEW:n. Выдуманные коды отбрасываются.
8. В КАЖДОМ слоте заполнены ВСЕ параметры: persona, hook, body, angle${inp.format !== "static" ? ", actor" : ""}. Персона = дословная фраза-обращение к аудитории — если подходящей нет в библиотеке, создай NEW:n с текстом обращения. Слот с пропущенным параметром будет отброшен.

## ФОРМАТ ОТВЕТА — СТРОГО JSON, без markdown:
{
  "slots": [
    {
      "slot_id": 1,
      "category": "winner_family",
      "codes": { "persona": "MP483920", "hook": "MH120394", "body": "MB558201", "angle": "NEW:1", "actor": "ANNA" },
      "rationale": "Семья от 19.08_med_ST_10: меняем только энгл на новую формулировку с конкретной зарплатой",
      "based_on_ad": "19.08_med_ST_10",
      "varied_param": "angle"
    },
    {
      "slot_id": 17,
      "category": "competitor",
      "codes": { "persona": "NEW:3", "hook": "NEW:2", "body": "MB558201", "angle": "MA903311", "actor": "WOM1950" },
      "rationale": "Из концепта comp-3: провокационный хук",
      "source_concept_id": "<uuid из competitors>"
    }
  ],
  "new_formulations": [
    { "ref": "NEW:1", "axis": "angle", "text": "От N € в месяц. N месяцев онлайн. Оплата по частям." },
    { "ref": "NEW:2", "axis": "hook", "text": "Одна смена научила меня одному" },
    { "ref": "NEW:3", "axis": "persona", "text": "Ты переехала и работаешь не по профессии?" }
  ]
}`;

  const msg = await anthropic.messages.create({
    model: "claude-fable-5-1",
    max_tokens: 8000,
    messages: [{ role: "user", content: prompt }],
  });

  const text = claudeText(msg);
  // Extract JSON — Claude may wrap in code block
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error(`Claude вернул не-JSON: ${text.slice(0, 500)}`);
  try {
    return JSON.parse(jsonMatch[0]) as ClaudeResponse;
  } catch (e) {
    throw new Error(`JSON parse fail: ${(e as Error).message}\n---\n${jsonMatch[0].slice(0, 1500)}`);
  }
}

// ── Новые дословные формулировки из ответа модели → formulations (код выдаёт система) ──
async function persistNewFormulations(
  supabase: ReturnType<typeof createServiceClient>,
  product: FormulationProduct,
  items: NonNullable<ClaudeResponse["new_formulations"]>,
): Promise<{ refToCode: Record<string, string>; createdCodes: string[] }> {
  const refToCode: Record<string, string> = {};
  const createdCodes: string[] = [];
  for (const it of items) {
    const axis = (AXES as string[]).includes(String(it.axis)) ? (it.axis as Axis) : null;
    if (!axis || typeof it.text !== "string" || !it.text.trim() || !it.ref) continue;
    const { formulation, created } = await ensureFormulation(supabase, { axis, product, text: it.text, source: "brief", note: `из конструктора пака (${AXIS_LABEL[axis]})` });
    refToCode[String(it.ref).trim()] = formulation.code;
    if (created) createdCodes.push(formulation.code);
  }
  return { refToCode, createdCodes };
}

export type { Formulation };
