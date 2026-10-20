/**
 * /api/analytics/report — единый отчёт по массиву креативов.
 *
 * POST { platform, dateFrom?, dateTo? } — собирает канонические агрегаты. Без дат — lifetime по
 *   view creative_performance (как раньше). С датами — срез за окно (lib/window-rows: дневные строки
 *   Meta / Google API / TikTok API + лиды Elly за окно), бивариат и комбо считаются по строкам окна
 *   (lib/bivariate, lib/combinations); age/ROAS/risk_signals в окне недоступны → статусов fake_winner нет. (НЕ пересчитывает их сам, а дёргает
 *   существующие роуты analytics + creative_performance + конкуренты), строит детерминированный
 *   visual/kpi и один Opus-проход для текстового нарратива, сохраняет снапшот в analysis_reports.
 * GET ?flow= — последний снапшот по flow + краткая история.
 *
 * Принцип: визуал = детерминированные числа (надёжно, переиспользуемо производством),
 * нарратив = человекочитаемый разбор + рекомендации к производству (55/25/20).
 */
import Anthropic from "@anthropic-ai/sdk";
import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";
import { getSettings } from "@/lib/settings";
import { getAiContext, getBusiness } from "@/lib/brief";
import { collectWindowRows, WindowError, type WindowPlatform } from "@/lib/window-rows";
import { computeBivariate } from "@/lib/bivariate";
import { loadLabelMap } from "@/lib/formulations";
import { verifyWithGemini, verifyWithCodex } from "@/lib/verify";
import { computeCombinations } from "@/lib/combinations";
import { fetchAll } from "@/lib/paged";
import { matchesProduct, isProduct, productMeta, type Product } from "@/lib/product";
import type {
  ReportKpi, ReportVisual, ReportSignal, ReportHookSignal, ReportFamily, ReportCombo, ReportCompetitor,
  ReportVerification, ReportVerifications,
} from "@/lib/types";

export const maxDuration = 800; // окно дат ходит в Plurio (~90с) + Opus + две проверки; Pro + fluid → до 800с

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── типы ответов соседних роутов (минимально нужные поля) ──────────────────────
interface BivResult { code: string; paramType: string; label: string | null; ratio: number | null; verdict: string; withCount?: number; withAds?: string[]; withCpl?: number | null; withoutCpl?: number | null; withHookRate?: number | null; withHoldRate?: number | null; hookRatio?: number | null; hookVerdict?: string }
interface BivFamily { varyingParam: string; sharedPersona?: string; sharedHook?: string; sharedBody?: string; sharedAngle?: string; bestCpl: number | null; worstCpl: number | null }
interface ComboStat { codeA: string; codeB: string; winners: number; cpl: number | null; spend: number }
interface PerfRow {
  ad_name: string; campaign_name?: string | null; adset_name?: string | null; flow: string; auto_status: string; risk_signals: unknown;
  spend: number; impressions: number; cpl: number | null; cpql: number | null;
  leads: number; qual_leads: number; cr_lead_to_qual: number | null; roas: number | null;
  age_days: number | null; lifespan_days: number | null;
}

function baseUrlFrom(req: NextRequest): string {
  const host = req.headers.get("host") ?? "localhost:3000";
  const proto = req.headers.get("x-forwarded-proto") ?? (host.includes("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const r = await fetch(url, { method: "GET" });
    if (!r.ok) return null;
    return await r.json() as T;
  } catch { return null; }
}

const num = (v: unknown) => (typeof v === "number" ? v : Number(v) || 0);

// Все агрегаты считает КОД (не LLM): суммы спенда/лидов по статусам.
// Эти итоги отдаются и нарративу, и проверяющим как авторитетные — чтобы модель
// цитировала точные числа, а не складывала сама (LLM ненадёжны в арифметике).
function statusTotals(perf: PerfRow[]) {
  const g = (st: string) => {
    const rows = perf.filter(r => r.auto_status === st);
    return {
      n: rows.length,
      spend: rows.reduce((a, r) => a + num(r.spend), 0),
      leads: rows.reduce((a, r) => a + num(r.leads), 0),
      qual: rows.reduce((a, r) => a + num(r.qual_leads), 0),
    };
  };
  return { winner: g("winner"), fake: g("fake_winner"), loser: g("loser"), testing: g("testing") };
}

function totalsBlock(perf: PerfRow[]): string {
  const t = statusTotals(perf);
  const r = (x: { n: number; spend: number; leads: number; qual: number }) =>
    `${x.n} шт · спенд €${x.spend.toFixed(0)} · лиды ${x.leads} · qual ${x.qual}`;
  return `## ТОЧНЫЕ ИТОГИ (посчитаны кодом — ЦИТИРУЙ КАК ЕСТЬ; НЕ складывай и НЕ усредняй числа сам)
Виннеры: ${r(t.winner)}
Fake-winners: ${r(t.fake)}
Лузеры: ${r(t.loser)}
В тесте: ${r(t.testing)}`;
}

// ── GET: последний снапшот + история ──────────────────────────────────────────
export async function GET(req: NextRequest) {
  const supabase = createServiceClient();
  const id = req.nextUrl.searchParams.get("id");
  // канал отчёта: meta | google | tiktok | all (общий по всем каналам)
  const platform = req.nextUrl.searchParams.get("platform") ?? "all";
  // продукт отчёта: buchhalter | medadmin | all (оба)
  const pq = req.nextUrl.searchParams.get("product");
  const product: Product = isProduct(pq) ? pq : "all";

  // ?id= — конкретный снапшот из истории; иначе последний по каналу и продукту
  const latestQuery = id
    ? supabase.from("analysis_reports").select("*").eq("id", id).maybeSingle()
    : supabase.from("analysis_reports").select("*").eq("platform", platform).eq("product", product)
        .order("created_at", { ascending: false }).limit(1).maybeSingle();
  const { data: latest } = await latestQuery;

  const { data: history } = await supabase
    .from("analysis_reports")
    .select("id, created_at, flow, platform, product, kpi, date_from, date_to")
    .eq("platform", platform).eq("product", product)
    .order("created_at", { ascending: false })
    .limit(20);

  return NextResponse.json({ ok: true, latest: latest ?? null, history: history ?? [] });
}

// ── POST: сгенерировать отчёт ──────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({})) as { flow?: string; platform?: string; dateFrom?: string; dateTo?: string; product?: string };
  const flow = "all";
  const platform = body.platform && ["meta", "google", "tiktok", "all"].includes(body.platform) ? body.platform : "all";
  // Продукт: Бухгалтер / Медадмин / оба — по маркерам имени объявления и кампании (lib/product.ts)
  const product: Product = isProduct(body.product) ? body.product : "all";
  // Период: обе даты → окно; иначе lifetime
  const isDate = (v?: string) => !!v && /^\d{4}-\d{2}-\d{2}$/.test(v);
  const dateFrom = isDate(body.dateFrom) ? body.dateFrom! : null;
  const dateTo   = isDate(body.dateTo)   ? body.dateTo!   : null;
  if ((dateFrom && !dateTo) || (!dateFrom && dateTo)) return NextResponse.json({ error: "Нужны обе даты: dateFrom и dateTo (YYYY-MM-DD)" }, { status: 400 });
  if (dateFrom && dateTo && dateFrom > dateTo) return NextResponse.json({ error: "dateFrom позже dateTo" }, { status: 400 });
  const period = dateFrom && dateTo ? { from: dateFrom, to: dateTo } : null;
  const supabase = createServiceClient();
  const settings = await getSettings();
  const business = getBusiness();
  const base = baseUrlFrom(req);

  // 1. Канонические агрегаты (соседние роуты) + производительность по flow + конкуренты
  // Лимит высокий: KPI/счётчики статусов считаем по ВСЕМ креативам (грань view — имя,
  // ~сотни-тысяча строк). В промпт Opus уходят только срезы (winners.slice и т.п.),
  // поэтому размер промпта не зависит от лимита.
  // PostgREST режет ответ на 1000 строках даже при .limit(5000) — до 30.09.2026 lifetime-отчёт
  // видел только топ-1000 крео по спенду (KPI «1000 объявлений»). Читаем страницами.
  const perfQuery = fetchAll<PerfRow>((f, t) => {
    let q = supabase
      .from("creative_performance")
      .select("ad_name, campaign_name, adset_name, flow, auto_status, risk_signals, spend, impressions, cpl, cpql, leads, qual_leads, cr_lead_to_qual, roas, age_days, lifespan_days")
      .order("spend", { ascending: false }).order("ad_id");
    if (platform !== "all") q = q.eq("platform", platform);
    return q.range(f, t) as unknown as PromiseLike<{ data: PerfRow[] | null; error: { message: string } | null }>;
  });
  const qsParts = [platform !== "all" ? `platform=${platform}` : null, product !== "all" ? `product=${product}` : null].filter(Boolean);
  const pq = qsParts.length ? `?${qsParts.join("&")}` : "";

  let biv: { results: BivResult[]; families: BivFamily[] } | null;
  let health: { status: string } | null;
  let combosResp: { combinations: Record<string, ComboStat[]> } | null;
  let perf: PerfRow[];
  const competitorsResp = await supabase.from("competitor_concepts")
    .select("title, concept_type, raw_data").eq("status", "approved").limit(40);

  if (period) {
    // ── Режим окна: строки за период + расчёт бивариата/комбо по ним ──
    let win;
    try {
      win = await collectWindowRows(supabase, platform as WindowPlatform, period.from, period.to);
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: e instanceof WindowError ? e.status : 500 });
    }
    const winRows = win.rows.filter(r => matchesProduct(r, product));
    perf = winRows.map(r => ({
      ad_name: r.adName, flow: r.flow ?? "all", auto_status: r.status, risk_signals: [],
      spend: r.spend, impressions: r.impressions, cpl: r.cpl, cpql: r.cpql,
      leads: r.leads, qual_leads: r.qualLeads,
      cr_lead_to_qual: r.leads > 0 ? (r.qualLeads / r.leads) * 100 : null,
      roas: null, age_days: null, lifespan_days: null,
    })).sort((a, b) => b.spend - a.spend);
    if (perf.length === 0) {
      return NextResponse.json({ error: `За период ${period.from} – ${period.to} нет строк по каналу ${platform}${product !== "all" ? ` и продукту ${productMeta(product).label}` : ""}. Проверь синк Meta за эти даты.` }, { status: 400 });
    }
    const labelMap = await loadLabelMap(supabase); // подписи кодов = дословные формулировки
    const bv = computeBivariate(winRows.map(r => ({
      adName: r.adName, spend: r.spend, leads: r.leads, impressions: r.impressions,
      video3s: r.videoPlays ?? 0, videoThru: r.videoThruplay ?? 0, autoStatus: r.status,
    })), win.mapping, labelMap);
    biv = { results: bv.results, families: bv.families.map(f => ({ ...f, sharedPersona: f.sharedPersona ?? undefined, sharedHook: f.sharedHook ?? undefined, sharedBody: f.sharedBody ?? undefined, sharedAngle: f.sharedAngle ?? undefined })) };
    combosResp = { combinations: computeCombinations(winRows.map(r => ({
      adName: r.adName, spend: r.spend, leads: r.leads, qualLeads: r.qualLeads, autoStatus: r.status,
    })), win.mapping) };
    // здоровье пака за окно: доля виннеров среди решённых (виннеры+лузеры)
    const w = perf.filter(r => r.auto_status === "winner").length, l = perf.filter(r => r.auto_status === "loser").length;
    health = { status: w + l === 0 ? "unknown" : w / (w + l) >= 0.3 ? "healthy" : w > 0 ? "warning" : "dying" };
  } else {
    const [b, h, c, perfResp] = await Promise.all([
      fetchJson<{ results: BivResult[]; families: BivFamily[] }>(`${base}/api/analytics/bivariate${pq}`),
      fetchJson<{ status: string }>(`${base}/api/analytics/pack-health${pq}`),
      fetchJson<{ combinations: Record<string, ComboStat[]> }>(`${base}/api/analytics/combinations${pq}`),
      perfQuery,
    ]);
    biv = b; health = h; combosResp = c;
    if (perfResp.error) return NextResponse.json({ error: perfResp.error }, { status: 500 });
    perf = perfResp.data.filter(r => matchesProduct(r, product));
    if (perf.length === 0) {
      return NextResponse.json({ error: product === "all" ? "Нет данных из Meta/PBI. Запусти синхронизацию." : `Нет креативов продукта «${productMeta(product).label}» по каналу ${platform}.` }, { status: 400 });
    }
  }

  // 2. KPI (детерминированно, по всем строкам flow)
  const winners     = perf.filter(r => r.auto_status === "winner");
  const fakeWinners = perf.filter(r => r.auto_status === "fake_winner");
  const losers      = perf.filter(r => r.auto_status === "loser");
  const testing     = perf.filter(r => r.auto_status === "testing");
  const sum = (rows: PerfRow[], k: (r: PerfRow) => number) => rows.reduce((a, r) => a + k(r), 0);
  const totalSpend = sum(perf, r => num(r.spend));
  const totalLeads = sum(perf, r => num(r.leads));
  const totalQual  = sum(perf, r => num(r.qual_leads));

  const kpi: ReportKpi = {
    packHealth: (health?.status as ReportKpi["packHealth"]) ?? "unknown",
    winners: winners.length,
    fakeWinners: fakeWinners.length,
    losers: losers.length,
    testing: testing.length,
    blendedCpl: totalLeads > 0 ? totalSpend / totalLeads : null,
    blendedCpql: totalQual > 0 ? totalSpend / totalQual : null,
    totalSpend,
    activeAds: perf.length,
  };

  // 3. Visual-агрегаты (HELPS/HURTS — кросс-массив из bivariate; семьи; комбо; конкуренты)
  const bivResults = biv?.results ?? [];
  // Формулировки, повторённые в ≥2 крео, идут первыми: у одиночных эффект параметра неотличим от эффекта самого крео.
  const multiFirst = (a: BivResult, b: BivResult, dir: 1 | -1) =>
    (Number((b.withCount ?? 0) >= 2) - Number((a.withCount ?? 0) >= 2)) || dir * ((a.ratio ?? (dir === 1 ? 9 : 0)) - (b.ratio ?? (dir === 1 ? 9 : 0)));
  const toSignal = (r: BivResult): ReportSignal => ({
    code: r.code, paramType: r.paramType, label: r.label ?? r.code, ratio: r.ratio,
    adCount: r.withCount, ads: r.withAds ?? [], withCpl: r.withCpl ?? null, withoutCpl: r.withoutCpl ?? null,
  });
  const helps: ReportSignal[] = bivResults.filter(r => r.verdict === "HELPS").sort((a, b) => multiFirst(a, b, 1)).slice(0, 12).map(toSignal);
  const hurts: ReportSignal[] = bivResults.filter(r => r.verdict === "HURTS").sort((a, b) => multiFirst(a, b, -1)).slice(0, 12).map(toSignal);

  // Hook rate по кодам (плеи/показы) — отдельное измерение «цепляет ли», особенно хуки (H).
  const toHook = (r: BivResult): ReportHookSignal => ({
    code: r.code, paramType: r.paramType, label: r.label ?? r.code,
    hookRate: r.withHookRate ?? null, holdRate: r.withHoldRate ?? null,
    ratio: r.hookRatio ?? null, verdict: r.hookVerdict ?? "INSUFFICIENT",
  });
  const hookHelps: ReportHookSignal[] = bivResults.filter(r => r.hookVerdict === "HELPS" && r.withHookRate != null)
    .sort((a, b) => (b.hookRatio ?? 0) - (a.hookRatio ?? 0)).slice(0, 10).map(toHook);
  const hookHurts: ReportHookSignal[] = bivResults.filter(r => r.hookVerdict === "HURTS" && r.withHookRate != null)
    .sort((a, b) => (a.hookRatio ?? 9) - (b.hookRatio ?? 9)).slice(0, 10).map(toHook);

  const families: ReportFamily[] = (biv?.families ?? []).slice(0, 8).map(f => ({
    varyingParam: f.varyingParam,
    shared: [f.sharedPersona, f.sharedHook, f.sharedBody, f.sharedAngle].filter(Boolean).join(" "),
    bestCpl: f.bestCpl,
    worstCpl: f.worstCpl,
    spread: f.bestCpl != null && f.worstCpl != null ? f.worstCpl - f.bestCpl : null,
  }));

  const allCombos = Object.values(combosResp?.combinations ?? {}).flat();
  const combos: ReportCombo[] = allCombos
    .filter(c => c.winners > 0)
    .sort((a, b) => b.winners - a.winners || (a.cpl ?? 9e9) - (b.cpl ?? 9e9))
    .slice(0, 8)
    .map(c => ({ codes: `${c.codeA} + ${c.codeB}`, winners: c.winners, cpl: c.cpl, spend: num(c.spend) }));

  const competitors: ReportCompetitor[] = ((competitorsResp.data ?? []) as { title: string; concept_type?: string; raw_data?: Record<string, unknown> }[])
    .map(c => ({
      title: c.title,
      type: c.concept_type,
      hook: typeof c.raw_data?.ai_hook === "string" ? c.raw_data.ai_hook : undefined,
      reach: num(c.raw_data?.eu_total_reach),
    }))
    .sort((a, b) => b.reach - a.reach)
    .slice(0, 8)
    .map(({ title, type, hook }) => ({ title, type, hook }));

  const visual: ReportVisual = { helps, hurts, families, combos, competitors, hookHelps, hookHurts };

  // 4. Описания крео (Gemini, mode=creative_desc) — контент для контекста нарратива
  const { data: descRows } = await supabase
    .from("gemini_analyses").select("ad_name, analysis").eq("mode", "creative_desc").not("ad_name", "is", null);
  const descriptions = new Map<string, string>();
  for (const d of (descRows ?? []) as { ad_name: string; analysis: string }[]) {
    const key = (d.ad_name ?? "").trim().toLowerCase();
    if (key && d.analysis && !descriptions.has(key)) descriptions.set(key, d.analysis);
  }

  // 5. Нарратив (один Opus-проход)
  const labelOf: Record<string, string> = {};
  for (const r of bivResults) if (r.label) labelOf[r.code] = r.label;
  const narrative = await buildNarrative({ flow, platform, product, period, business, settings, perf, kpi, visual, descriptions, hookHelps, hookHurts, labelOf });

  // 5. Две независимые проверки (Gemini + Codex/OpenAI) — аудит чисел и выводов
  const verifications = await buildVerifications({ settings, kpi, visual, perf, narrative, period, product });

  // 6. Сохранить снапшот (+ строки виннеров/fake/лузеров — на них строится конструктор)
  const snapshot = {
    thresholds: { cplTarget: settings.cplTarget, cpqlTarget: settings.cpqlTarget },
    testing: testing.length,
    rows: [...winners, ...fakeWinners, ...losers].slice(0, 600).map(r => ({
      ad_name: r.ad_name, auto_status: r.auto_status, spend: num(r.spend), cpl: r.cpl, cpql: r.cpql,
      leads: num(r.leads), qual_leads: num(r.qual_leads), roas: r.roas, cr_lead_to_qual: r.cr_lead_to_qual,
      risk_signals: Array.isArray(r.risk_signals) ? r.risk_signals as string[] : [],
    })),
  };
  const { data: saved, error } = await supabase
    .from("analysis_reports")
    .insert({ flow, platform, product, kpi, visual, narrative, verifications, snapshot, date_from: period?.from ?? null, date_to: period?.to ?? null })
    .select("*")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true, report: saved });
}

// ── промпт + Opus ───────────────────────────────────────────────────────────────
async function buildNarrative(args: {
  flow: string;
  platform: string;
  product: Product;
  period: { from: string; to: string } | null;
  business: ReturnType<typeof getBusiness>;
  settings: Awaited<ReturnType<typeof getSettings>>;
  perf: PerfRow[];
  kpi: ReportKpi;
  visual: ReportVisual;
  descriptions: Map<string, string>;
  hookHelps: ReportHookSignal[];
  hookHurts: ReportHookSignal[];
  labelOf: Record<string, string>;     // код формулировки → дословный текст
}): Promise<string> {
  const { platform, product, period, business, settings, perf, kpi, visual, descriptions, hookHelps, hookHurts, labelOf } = args;
  const AX: Record<string, string> = { persona: "персона", hook: "хук", body: "боди", angle: "энгл", format: "формат", concept: "концепция", actor: "актёр" };
  const q = (code: string) => (labelOf[code] ? ` «${labelOf[code].replace(/\s+/g, " ").slice(0, 180)}»` : "");
  const kk = (s: string) => (s ?? "").trim().toLowerCase();
  // Описание содержания крео (Gemini) — добавляем к строке, если есть.
  const descOf = (r: PerfRow) => {
    const d = descriptions.get(kk(r.ad_name));
    return d ? `\n    ↳ контент: ${d.replace(/\s+/g, " ").slice(0, 220)}` : "";
  };
  const winners     = perf.filter(r => r.auto_status === "winner");
  const fakeWinners = perf.filter(r => r.auto_status === "fake_winner");
  const losers      = perf.filter(r => r.auto_status === "loser");

  const RISK_LABEL: Record<string, string> = {
    low_qual_cr: "низкая CR Lead→Qual", short_lifespan: "короткий жизненный цикл", low_roas_30d: "ROAS<1",
  };
  const fmtRisk = (s: unknown) => (Array.isArray(s) ? (s as string[]) : []).map(x => RISK_LABEL[x] ?? x).join(", ") || "—";
  const eur = (v: number | null) => (v == null ? "—" : `€${v.toFixed(1)}`);
  const sig = (s: ReportSignal) => `\n  • ${s.code} [${AX[s.paramType] ?? s.paramType}, ${s.adCount ?? "?"} крео: ${(s.ads ?? []).slice(0, 5).join(", ") || "—"}; CPL ${eur(s.withCpl ?? null)} vs ${eur(s.withoutCpl ?? null)} у остальных, ×${s.ratio?.toFixed(2) ?? "—"}]${q(s.code)}`;

  const prompt = `Ты — аналитик Meta Ads для ${business.name}. Готовишь ЕДИНЫЙ отчёт по всему массиву креативов перед запуском нового пакета.

${getAiContext()}

Цели: CPL ≤ €${settings.cplTarget}, CPQL ≤ €${settings.cpqlTarget}, порог значимости ${settings.minImpressionsForStatus.toLocaleString()} показов.
Канал: ${platform === "all" ? "все каналы (общий отчёт)" : platform === "meta" ? "Meta Ads" : platform === "google" ? "Google Ads" : platform}
Продукт: ${product === "all" ? "оба продукта (Бухгалтер + Медадмин) — не смешивай выводы между продуктами без оговорки" : product === "buchhalter" ? "курс «Бухгалтер в Германии» (только его креативы)" : "курс «Медадмин / Praxismanager» (только его креативы)"}
Период: ${period ? `${period.from} – ${period.to} (метрики и лиды ТОЛЬКО за это окно; статусы winner/loser — по CPL/CPQL за окно; age/ROAS/risk-сигналов и fake_winner в окне НЕТ — не пиши о них)` : "весь срок жизни креативов (lifetime)"}

## СВОДКА МАССИВА
Здоровье пакета: ${kpi.packHealth}. Объявлений: ${kpi.activeAds}. Спенд: €${kpi.totalSpend.toFixed(0)}. Blended CPL: ${eur(kpi.blendedCpl)}, CPQL: ${eur(kpi.blendedCpql)}.
Виннеры: ${kpi.winners} · ⚠️ fake-winners: ${kpi.fakeWinners} · лузеры: ${kpi.losers} · в тесте: ${kpi.testing}.

${totalsBlock(perf)}

## НАСТОЯЩИЕ ВИННЕРЫ (${winners.length})
${winners.slice(0, 15).map(r => `• ${r.ad_name} | CPL ${eur(r.cpl)} | CPQL ${eur(r.cpql)} | CR ${r.cr_lead_to_qual?.toFixed(0) ?? "—"}% | ROAS ${r.roas?.toFixed(2) ?? "—"}${descOf(r)}`).join("\n") || "Виннеров нет."}

## ⚠️ FAKE-WINNERS — замаскированные убытки (${fakeWinners.length})
${fakeWinners.slice(0, 12).map(r => `• ${r.ad_name} | spend €${num(r.spend).toFixed(0)} | CPL ${eur(r.cpl)} | CR ${r.cr_lead_to_qual?.toFixed(0) ?? "—"}% | ROAS ${r.roas?.toFixed(2) ?? "—"} | ⚑ ${fmtRisk(r.risk_signals)}${descOf(r)}`).join("\n") || "Опасных виннеров нет."}

## ЛУЗЕРЫ (${losers.length})
${losers.slice(0, 10).map(r => `• ${r.ad_name} | CPL ${eur(r.cpl)} | €${num(r.spend).toFixed(0)} спенд${descOf(r)}`).join("\n") || "Лузеров нет."}

## ФОРМУЛИРОВКИ — что помогает / вредит (бивариат по всему массиву)
Каждый код = ОДНА уникальная ДОСЛОВНАЯ формулировка (текст в кавычках — ровно то, что звучит/написано в креативе). Это не категории и не направления: анализируй и называй именно эти тексты.
HELPS (снижают CPL):${visual.helps.map(sig).join("") || " —"}
HURTS (повышают CPL):${visual.hurts.map(sig).join("") || " —"}

## HOOK RATE — что цепляет (плеи/показы, ВЫШЕ=лучше; ×N = vs остальные)
Цепляют:${hookHelps.map(h => `\n  • ${h.code} [${AX[h.paramType] ?? h.paramType}, hook ${h.hookRate?.toFixed(1) ?? "—"}%, ×${h.ratio?.toFixed(2) ?? "—"}]${q(h.code)}`).join("") || " —"}
Не цепляют:${hookHurts.map(h => `\n  • ${h.code} [${AX[h.paramType] ?? h.paramType}, hook ${h.hookRate?.toFixed(1) ?? "—"}%, ×${h.ratio?.toFixed(2) ?? "—"}]${q(h.code)}`).join("") || " —"}
ВАЖНО: hook rate и CPL — РАЗНЫЕ оси. Код может цеплять (высокий hook), но давать дорогой лид, и наоборот. Сопоставь: если хук цепляет, но CPL высокий — проблема не в первых секундах, а дальше (боди/оффер). Если не цепляет и CPL дорогой — меняй хук.

## СЕМЬИ (фикс 3 формулировки, варьируется 1) — вспомогательный блок: где один свап формулировки решает
${visual.families.map(f => `• варьируется ${f.varyingParam} при [${f.shared.split(" ").filter(Boolean).map(c => `${c}${q(c)}`).join(" + ")}]: лучший CPL ${eur(f.bestCpl)} ↔ худший ${eur(f.worstCpl)} (разброс ${eur(f.spread)})`).join("\n") || "Семей недостаточно."}

## КОМБО ФОРМУЛИРОВОК С ВИННЕРАМИ
${visual.combos.map(c => `• ${c.codes.split(" + ").map(cd => `${cd}${q(cd)}`).join(" + ")}: ${c.winners} виннер(ов), CPL ${eur(c.cpl)}`).join("\n") || "—"}

## КОНКУРЕНТЫ (одобренные концепты)
${visual.competitors.map(c => `• [${c.type ?? "—"}] ${c.title}${c.hook ? ` — хук: ${c.hook}` : ""}`).join("\n") || "Одобренных концептов нет."}

---

ПРАВИЛА ТОЧНОСТИ (строго — иначе отчёт будет отклонён проверкой):
- НЕ вычисляй агрегаты сам (суммы, средние, доли). ВСЕ суммарные числа (спенд/лиды по группам и т.п.) бери ТОЛЬКО из блока «ТОЧНЫЕ ИТОГИ» или из KPI. Если нужного готового числа нет — не приводи его, говори качественно («большинство», «несколько»), без выдуманной цифры.
- Привязка формулировка → крео дана ТОЛЬКО в блоках HELPS/HURTS/HOOK RATE (список имён после числа крео) — используй её; другим объявлениям коды не приписывай. Коды формулировок (вида MH483920 / BA102938 — каждый код = одна ДОСЛОВНАЯ формулировка, не категория) используй ТОЛЬКО те, что реально есть в секциях HELPS/HURTS/СЕМЬИ/КОМБО, и цитируй их текст как есть.
- Любая связка кодов в рекомендациях должна опираться на HELPS/СЕМЬИ/КОМБО выше, а не на догадку.
- Списки виннеров/fake/лузеров — это СРЕЗ (top-N), НЕ весь массив. Не делай выводов «минимальный/максимальный во всём массиве» или «X несёт основную нагрузку» на основе среза — говори только о показанных строках.
- У части строк есть «↳ контент:» — описание содержания крео от Gemini (хук, формат, оффер, визуал). ОПИРАЙСЯ на него: выводы «что работает / что не работает» формулируй через реальный контент (какие хуки/форматы/офферы у виннеров vs лузеров), а не только через коды и метрики. Не выдумывай контент сверх описанного.

Дай структурированный анализ на русском (markdown, секции через "### "):

### 1. Какие конкретные формулировки работают
ГЛАВНАЯ секция. Перечисли КОНКРЕТНЫЕ формулировки из HELPS — по каждой: код, дословный текст в кавычках, ось, в скольких крео, CPL с ней vs без неё. Не обобщай в «направления», «семьи» или «типы хуков» — предмет анализа ровно эти тексты. Имена крео, где стоит формулировка, ДАНЫ в блоке HELPS — используй их, не гадай. Формулировки из ≥2 крео — настоящий сигнал параметра, разбирай их первыми. Если формулировка стоит в 1 крео — это эффект самого крео, а не параметра: назови крео и скажи, что формулировку нужно повторить в новых крео с другими соседями, чтобы измерить. Несколько формулировок из одного и того же крео не считай независимыми подтверждениями.

### 2. ⚠️ Опасные fake-winners
Где замаскированы убытки. Топ самых дорогих fake по сигналам и бюджету. Какие параметры тянут в fake-категорию.

### 3. Какие формулировки не работают
Конкретные формулировки из HURTS (код + дословный текст + CPL с ней vs без) — что выключать и не повторять. Плюс паттерны лузеров по контенту.

### 4. Хуки (hook rate)
ОТДЕЛЬНЫЙ разбор хуков по блоку HOOK RATE (только видео, плеи/показы). Шкала уровней: <15% Fix-it, 15-25 Workable, 25-35 Solid, 35-45 Strong, 45%+ Elite — называй уровень для топовых хуков. Называй хуки ДОСЛОВНЫМ текстом (с кодом). ГЛАВНОЕ — сопоставь hook rate с CPL по тем же хукам: если хук цепляет (Strong/Elite), но CPL высокий → проблема НЕ в первых секундах, а в боди/оффере; если хук слабый (Fix-it) → менять сам хук. Дай 1-2 конкретных вывода.

### 5. Тренд массива
Состояние пакета: здоровье, доля фейков, риск усталости.

### 6. Рекомендации к производству
Чётко разбей следующий пакет по нашей формуле:
- **55% размножение виннеров** — какие именно виннеры (ad_name) размножать, какую ОДНУ формулировку в них менять и на какую (код + текст из HELPS); остальные формулировки виннера сохраняются дословно, чтобы параметр оставался измеримым.
- **25% вариации из анализа** — новые комбинации HELPS-формулировок (коды + тексты), которых ещё не было; избегай HURTS.
- **20% гипотезы из конкурентов/рынка** — какие углы из одобренных концептов конкурентов превратить в НОВЫЕ дословные формулировки (напиши сам текст хука/боди/энгла, он получит код при создании брифа).

Везде, где называешь параметр, пиши код И его дословный текст. Без воды, не больше 1100 слов.`;

  const msg = await client.messages.create({
    model: "claude-opus-5-5",
    max_tokens: 10000,
    messages: [{ role: "user", content: prompt }],
  });
  // Модели 5-го поколения отдают несколько блоков content — склеиваем ВСЕ текстовые (первый блок = обрыв нарратива).
  const text = msg.content.filter(b => b.type === "text").map(b => (b as { text?: string }).text ?? "").join("");
  if (msg.stop_reason === "max_tokens") return text + "\n\n_(разбор обрезан по лимиту токенов — сократи период или повтори генерацию)_";
  return text;
}

// ── Проверка отчёта: 2 независимые модели (Gemini + Codex/OpenAI) ───────────────

const AUDIT_INSTRUCTION = `Ты — независимый аудитор отчёта по Meta Ads. Дан ДЕТЕРМИНИРОВАННЫЙ свод чисел и текстовый разбор (написан ДРУГОЙ моделью). Проверяй КОРРЕКТНОСТЬ строго по ПРАВИЛАМ КЛАССИФИКАЦИИ, приведённым в контексте, — НЕ по своей наивной эвристике.

ВАЖНО (частые ложные срабатывания — НЕ считай это ошибками):
- ROAS = 0 у МОЛОДОГО ада (age < порога зрелости) — ЭТО НОРМА: цикл сделки 14–30 дней, выручка ещё не дозрела. Молодой winner с ROAS 0 классифицирован ВЕРНО.
- fake_winner с ВЫСОКИМ ROAS — допустимо, если у строки есть risk_signals (напр. short_lifespan): значит причина не в ROAS. Смотри поле signals перед выводом о «неверной классификации».
- Статусы (winner/fake_winner/loser/testing) уже проставлены по правилам в контексте — если они правилам соответствуют, это НЕ ошибка.
- Рекомендация ВЫКЛЮЧИТЬ / НЕ ПОВТОРЯТЬ параметр (формулировку, актёра, формат), у которого CPL ВЫШЕ цели или ratio > 1 в HURTS, — ЛОГИЧНА и СОГЛАСУЕТСЯ с данными. Это не противоречие. Противоречие — только если советуют размножать параметр с плохими числами или выключать параметр с хорошими.
- Код параметра = одна уникальная ДОСЛОВНАЯ формулировка (тексты даны в HELPS/HURTS). Если разбор цитирует эти тексты — это не галлюцинация.

ЧТО ПРОВЕРЯТЬ:
1) Аномалии в ЧИСЛАХ: CPQL < CPL; противоречия leads/qual_leads/CR; нереалистичные значения; статус, НЕ соответствующий правилам.
2) Соответствуют ли выводы разбора числам; нет ли галлюцинаций (имя объявления считай галлюцинацией ТОЛЬКО если его нет НИ в списках виннеров/fake/лузеров, НИ в привязках «в:» блоков HELPS/HURTS/HOOK RATE); НЕ делает ли разбор выводов «по всему массиву» из усечённого среза (показан top-N, не всё) — это повод для warning.
3) Обоснованы ли рекомендации (55/25/20).
Верни СТРОГО JSON без markdown и без преамбулы:
{"status":"ok|warning|fail","confidence":0..1,"issues":[{"severity":"high|medium|low","area":"кратко","detail":"что именно не так"}],"summary":"1-2 предложения"}
status=fail — ТОЛЬКО при явных ошибках в данных/выводах (НЕ за следование правилам классификации); warning — обоснованные сомнения; ok — консистентно.`;

function buildAuditContext(args: {
  settings: Awaited<ReturnType<typeof getSettings>>;
  kpi: ReportKpi; visual: ReportVisual; perf: PerfRow[]; narrative: string;
  period?: { from: string; to: string } | null;
  product?: Product;
}): string {
  const { settings, kpi, visual, perf, narrative, period, product } = args;
  const ROAS_MATURITY = 30;   // age, после которого требуется ROAS (верх цикла сделки)
  const ROAS_WIN_MIN = 1.0;   // минимальный ROAS для зрелого винера
  const eur = (v: number | null) => (v == null ? "—" : `€${v.toFixed(1)}`);
  const sig = (r: PerfRow) => (Array.isArray(r.risk_signals) && r.risk_signals.length ? (r.risk_signals as string[]).join(",") : "—");
  const line = (r: PerfRow) =>
    `${r.ad_name} | spend €${num(r.spend).toFixed(0)} | CPL ${eur(r.cpl)} | CPQL ${eur(r.cpql)} | CR ${r.cr_lead_to_qual?.toFixed(0) ?? "—"}% | ROAS ${r.roas?.toFixed(2) ?? "—"} | age ${r.age_days ?? "—"}д | signals ${sig(r)} | leads ${r.leads}/${r.qual_leads}`;
  const winners = perf.filter(r => r.auto_status === "winner");
  const fakeWinners = perf.filter(r => r.auto_status === "fake_winner");
  const losers = perf.filter(r => r.auto_status === "loser");
  return `Цели: CPL ≤ €${settings.cplTarget}, CPQL ≤ €${settings.cpqlTarget}, порог значимости ${settings.minImpressionsForStatus} показов.
${product && product !== "all" ? `ПРОДУКТ ОТЧЁТА: ${productMeta(product).label} — в выборке только его креативы.\n` : ""}${period ? `ПЕРИОД ОТЧЁТА: ${period.from} – ${period.to}. Все метрики и лиды — только за это окно. В окне НЕТ age/ROAS/risk_signals (показаны как «—») и НЕТ статуса fake_winner — это норма режима периода, не ошибка данных; правило про ROAS/age к окну не применяй.\n` : ""}
ПРАВИЛА КЛАССИФИКАЦИИ (статусы проставлены ПО НИМ — проверяй соответствие, не свою эвристику):
- winner: показы ≥ порога И CPL ≤ цели И CPQL ≤ цели И (ад МОЛОДОЙ age<${ROAS_MATURITY}д ИЛИ ROAS ≥ ${ROAS_WIN_MIN}). Цикл сделки 14–30 дн: у молодых выручка не дозрела → ROAS=0 у молодого винера = НОРМА.
- fake_winner: пороги CPL/CPQL пройдены, но есть риск — зрелый (age≥${ROAS_MATURITY}) с ROAS<${ROAS_WIN_MIN} ЛИБО есть signals (short_lifespan/low_roas_30d). Высокий ROAS у fake_winner ОК, если стоит signal.
- loser: показы ≥ порога И (CPL > цели ИЛИ CPQL > цели). testing: мало показов / нет лидов.

KPI: пакет ${kpi.packHealth}; объявлений ${kpi.activeAds}; спенд €${kpi.totalSpend.toFixed(0)}; blended CPL ${eur(kpi.blendedCpl)}; CPQL ${eur(kpi.blendedCpql)}; виннеры ${kpi.winners}; fake ${kpi.fakeWinners}; лузеры ${kpi.losers}; в тесте ${kpi.testing}.

${totalsBlock(perf)}
(Это авторитетные итоги по ГРУППАМ. Списки ниже — усечённый top-N; НЕ пересчитывай суммы по ним и не сравнивай свою сумму среза с итогами выше.)

ВИННЕРЫ (${winners.length}):
${winners.slice(0, 20).map(line).join("\n") || "—"}

FAKE-WINNERS (${fakeWinners.length}):
${fakeWinners.slice(0, 15).map(line).join("\n") || "—"}

ЛУЗЕРЫ (${losers.length}):
${losers.slice(0, 10).map(line).join("\n") || "—"}

(Код параметра = одна уникальная ДОСЛОВНАЯ формулировка; разбор обязан называть их текстом — это не галлюцинация, тексты даны ниже.)
(Имена крео после «в:» — АВТОРИТЕТНАЯ привязка формулировка → объявление по всему массиву; эти объявления могут отсутствовать в усечённых списках виннеров/лузеров выше — это НЕ галлюцинация.)
HELPS: ${visual.helps.map(s => `${s.code}(${s.paramType}, ${s.adCount ?? "?"} крео в: ${(s.ads ?? []).slice(0, 5).join(", ") || "—"}; CPL ${eur(s.withCpl ?? null)} vs ${eur(s.withoutCpl ?? null)}, ratio ${s.ratio?.toFixed(2) ?? "—"}) «${s.label.slice(0, 120)}»`).join("; ") || "—"}
HURTS: ${visual.hurts.map(s => `${s.code}(${s.paramType}, ${s.adCount ?? "?"} крео в: ${(s.ads ?? []).slice(0, 5).join(", ") || "—"}; CPL ${eur(s.withCpl ?? null)} vs ${eur(s.withoutCpl ?? null)}, ratio ${s.ratio?.toFixed(2) ?? "—"}) «${s.label.slice(0, 120)}»`).join("; ") || "—"}
СЕМЬИ: ${visual.families.map(f => `${f.varyingParam}@${f.shared}: ${eur(f.bestCpl)}↔${eur(f.worstCpl)}`).join("; ") || "—"}
КОМБО: ${visual.combos.map(c => `${c.codes}: ${c.winners}W ${eur(c.cpl)}`).join("; ") || "—"}
HOOK RATE (детерминированный блок: плеи/показы по видео, ×N = vs остальные; разбор ВПРАВЕ цитировать эти числа и уровни Fix-it/Workable/Solid/Strong/Elite):
  цепляют: ${(visual.hookHelps ?? []).map(h => `${h.code} hook ${h.hookRate?.toFixed(1) ?? "—"}% hold ${h.holdRate?.toFixed(0) ?? "—"}% ×${h.ratio?.toFixed(2) ?? "—"}`).join("; ") || "—"}
  не цепляют: ${(visual.hookHurts ?? []).map(h => `${h.code} hook ${h.hookRate?.toFixed(1) ?? "—"}% ×${h.ratio?.toFixed(2) ?? "—"}`).join("; ") || "—"}
(Описания содержания крео в разборе взяты из Gemini-разбора медиа (mode=creative_desc) — это отдельный источник, не таблица; не считай их галлюцинацией, если они не противоречат числам.)

=== РАЗБОР (написан другой моделью — его и проверяй) ===
${narrative}`;
}

async function buildVerifications(args: {
  settings: Awaited<ReturnType<typeof getSettings>>;
  kpi: ReportKpi; visual: ReportVisual; perf: PerfRow[]; narrative: string;
  period?: { from: string; to: string } | null;
  product?: Product;
}): Promise<ReportVerifications> {
  const ctx = buildAuditContext(args);
  const checks = await Promise.all([verifyWithGemini(AUDIT_INSTRUCTION, ctx), verifyWithCodex(AUDIT_INSTRUCTION, ctx)]);
  const overall: ReportVerifications["overall"] = checks.some(c => c.status === "fail") ? "fail" : checks.some(c => c.status === "warning") ? "warning" : "ok";
  return { overall, checks };
}
