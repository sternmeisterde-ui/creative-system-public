import { Document, Packer, Paragraph, PageBreak, type Table } from "docx";
import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveParamRefs, type ParamRef } from "@/lib/param-lookup";
import { AXIS_LABEL, type Axis } from "@/lib/formulations";
import { buildAdName } from "@/lib/naming";
import { detectProduct } from "@/lib/product";
import { loadTeamNotes, formatTeamNotes } from "@/lib/weekly-notes";
import { getParamTimings, fmtSec, fragmentUrl, type AxisTexts } from "@/lib/param-timings";
import { FONT, eur, ruDate, para, h1, h2, h3, small, table, markdownToDocx, linkPara } from "@/lib/docx";

// Сборка ТЗ (бриф + референсы) в DOCX. Используется /api/briefs/docx (скачать) и /api/briefs/gdoc (в Google Docs).
// ТЗ для креатора (ИИ / UGC / дизайнер): шапка с кодами параметров, сам бриф (паспорт, параметры в ролике, хук,
// сценарий по сценам, подача, монтаж, Higgsfield, проверка речи) и РЕФЕРЕНСЫ: по каждому параметру — креативы, где
// он уже стоял (метрики + ссылки на превью/видео), и креативы-доноры слота с описанием исполнения (Gemini).

type BriefRow = {
  id: string; session_id: string; persona_id: string | null; hook_id: string | null; body_id: string | null; angle_id: string | null;
  format: string | null; adapted_hook: string | null; adapted_body: string | null; adapted_angle: string | null; full_brief: string | null; batch_index: number | null; created_at: string;
};
type Perf = { ad_id: string | null; ad_name: string; spend: string | number | null; impressions: string | number | null; leads: string | number | null; qual_leads: string | number | null; cpl: string | number | null; cpql: string | number | null; auto_status: string | null; first_seen: string | null; last_seen: string | null };
type Asset = { ad_id: string | null; ad_name: string; video_id: string | null; thumbnail_url: string | null; asset_url: string | null; object_type: string | null };
type Slot = { codes: { persona: string | null; hook: string | null; body: string | null; angle: string | null; concept?: string | null; actor?: string | null }; category?: string; basedOnAd?: string; variedParam?: string; fromWinners?: string[]; rationale?: string; change?: { axis: string; fromCode?: string | null; toCode: string; kind?: string; tier?: string } };

const num = (v: unknown) => (v == null ? 0 : Number(v));
const k = (s: string) => (s ?? "").trim().toLowerCase();
const STATUS: Record<string, string> = { winner: "виннер", fake_winner: "fake winner", loser: "лузер", testing: "в тесте", unknown: "—" };
const CAT: Record<string, string> = { winner_family: "семья виннера (меняется один параметр)", winner_mix: "микс параметров виннеров", discovery: "discovery — новая комбинация HELPS-параметров", transfer: "перенос медиа (виннер другого медиа целиком)", competitor: "гипотеза из концепта конкурента" };
// Служебные секции брифа, которые продакшену не нужны (правка ТЗ 11.10.2026): промпт Higgsfield и отчёт линтера остаются в приложении
const DOCX_SKIP_SECTIONS = /^##\s*(ПРОМПТ ДЛЯ HIGGSFIELD|ПРОВЕРКА РЕЧИ)/i;
function briefMarkdownForDocx(full: string): string {
  return full.split(/\n---\n/).map(s => s.trim()).filter(s => s && !DOCX_SKIP_SECTIONS.test(s))
    .map(s => s.replace(/^##\s*СЦЕНАРИЙ\s*$/im, "## СЦЕНАРИЙ — главное, берём отсюда")).join("\n\n");
}

export class BriefDocxError extends Error { status: number; constructor(m: string, status: number) { super(m); this.status = status; } }

export async function buildBriefDocx(sb: SupabaseClient, opts: { id?: string | null; sessionId?: string | null; origin: string }): Promise<{ buffer: Buffer; fname: string; title: string; sessionId: string; briefIds: string[] }> {
  const { id, sessionId, origin } = opts;
  if (!id && !sessionId) throw new BriefDocxError("id или sessionId обязателен", 400);

  let q = sb.from("briefs").select("*").order("batch_index");
  q = id ? q.eq("id", id) : q.eq("session_id", sessionId!);
  const { data: briefRows, error } = await q;
  if (error) throw new BriefDocxError(error.message, 500);
  const briefs = (briefRows ?? []) as BriefRow[];
  if (!briefs.length) throw new BriefDocxError("Брифы не найдены", 404);

  const { data: session } = await sb.from("constructor_sessions").select("id, name, format, pack_metadata, created_at").eq("id", briefs[0].session_id).maybeSingle();
  const pack = (session?.pack_metadata ?? null) as { slots?: Slot[]; concept?: { code: string; name: string } | null; product?: string; report?: { id: string; createdAt: string; dateFrom: string | null; dateTo: string | null } | null } | null;
  const slots = pack?.slots ?? [];

  const refs = await resolveParamRefs(sb, briefs.flatMap(b => [b.persona_id, b.hook_id, b.body_id, b.angle_id]));
  const allCodes = Array.from(new Set(Object.values(refs).map(r => r.code)));
  const slotActors = Array.from(new Set(slots.map(s => s.codes.actor).filter((c): c is string => !!c)));
  const slotConcepts = Array.from(new Set(slots.map(s => s.codes.concept).filter((c): c is string => !!c)));

  // ── Референсы: где уже стояли эти параметры (маппинг → метрики → медиа)
  const mapRows: { ad_name: string; persona_code: string | null; hook_code: string | null; body_code: string | null; angle_code: string | null; actor_code: string | null; concept_code: string | null; product: string | null }[] = [];
  for (let from = 0; ; from += 1000) {
    const { data } = await sb.from("ad_name_mapping").select("ad_name, persona_code, hook_code, body_code, angle_code, actor_code, concept_code, product").order("ad_name").range(from, from + 999);
    mapRows.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  const want = new Set([...allCodes, ...slotActors, ...slotConcepts]);
  const adsByCode = new Map<string, Set<string>>();
  const product = pack?.product === "buchhalter" || pack?.product === "medadmin" ? pack.product : null;
  for (const m of mapRows) for (const c of [m.persona_code, m.hook_code, m.body_code, m.angle_code, m.actor_code, m.concept_code]) {
    if (product && detectProduct(m.ad_name, null, null, m.product) !== product) continue; // концепции/актёры общие — референсы только своего продукта
    if (c && want.has(c)) { if (!adsByCode.has(c)) adsByCode.set(c, new Set()); adsByCode.get(c)!.add(m.ad_name); }
  }
  const donorNames = Array.from(new Set(slots.flatMap(s => [s.basedOnAd, ...(s.fromWinners ?? [])]).filter((n): n is string => !!n)));
  const refNames = Array.from(new Set([...Array.from(adsByCode.values()).flatMap(s => [...s]), ...donorNames]));

  const perfByName = new Map<string, Perf>();
  const assetByName = new Map<string, Asset>();
  const descByName = new Map<string, string>();
  for (let i = 0; i < refNames.length; i += 150) {
    const chunk = refNames.slice(i, i + 150);
    const [{ data: perf }, { data: assets }, { data: descs }] = await Promise.all([
      sb.from("creative_performance").select("ad_id, ad_name, spend, impressions, leads, qual_leads, cpl, cpql, auto_status, first_seen, last_seen").in("ad_name", chunk).eq("platform", "meta"),
      sb.from("meta_creatives").select("ad_id, ad_name, video_id, thumbnail_url, asset_url, object_type").in("ad_name", chunk),
      sb.from("gemini_analyses").select("ad_name, analysis").eq("mode", "creative_desc").in("ad_name", chunk),
    ]);
    for (const p of (perf ?? []) as Perf[]) { // одно имя может быть у нескольких ad_id — суммируем
      const cur = perfByName.get(k(p.ad_name));
      if (!cur) perfByName.set(k(p.ad_name), { ...p });
      else { cur.spend = num(cur.spend) + num(p.spend); cur.leads = num(cur.leads) + num(p.leads); cur.qual_leads = num(cur.qual_leads) + num(p.qual_leads); cur.impressions = num(cur.impressions) + num(p.impressions); cur.cpl = num(cur.leads) ? num(cur.spend) / num(cur.leads) : null; cur.cpql = num(cur.qual_leads) ? num(cur.spend) / num(cur.qual_leads) : null; }
    }
    for (const a of (assets ?? []) as Asset[]) if (!assetByName.has(k(a.ad_name)) || (a.video_id && !assetByName.get(k(a.ad_name))?.video_id)) assetByName.set(k(a.ad_name), a);
    for (const d of (descs ?? []) as { ad_name: string; analysis: string }[]) if (!descByName.has(k(d.ad_name))) descByName.set(k(d.ad_name), d.analysis);
  }
  const mediaLink = (name: string): { url: string; label: string } | null => {
    const a = assetByName.get(k(name)); if (!a) return null;
    if (a.video_id) return { url: `${origin}/api/meta/video?videoId=${a.video_id}`, label: "видео" };
    if (a.ad_id) return { url: `${origin}/api/meta/thumb?adId=${a.ad_id}`, label: "картинку" };
    return a.asset_url ? { url: a.asset_url, label: "медиа" } : null;
  };
  // Тексты формулировок по кодам (для «было → стало» и для таймкодов) — коды из маппинга референсов и из изменений слотов
  const codeSet = new Set<string>([...allCodes, ...slots.flatMap(s => [s.change?.fromCode ?? "", s.change?.toCode ?? ""]).filter(Boolean)]);
  for (const m of mapRows) if (refNames.includes(m.ad_name)) for (const c of [m.persona_code, m.hook_code, m.body_code, m.angle_code]) if (c) codeSet.add(c);
  const textOf: Record<string, string> = {};
  const codeList = [...codeSet];
  for (let i = 0; i < codeList.length; i += 200) { const { data } = await sb.from("formulations").select("code, text").in("code", codeList.slice(i, i + 200)); for (const f of data ?? []) textOf[f.code] = f.text; }
  { const [{ data: cs }, { data: as }] = await Promise.all([sb.from("concepts").select("code, name").in("code", codeList), sb.from("actors").select("code, name, description").in("code", codeList)]); for (const c of cs ?? []) if (c.code) textOf[c.code] = c.name; for (const a of as ?? []) textOf[a.code] = a.description ? `${a.name} — ${a.description}` : a.name; }
  const codesOfAd = (name: string): Record<Axis, string | null> => { const m = mapRows.find(x => x.ad_name === name); return { persona: m?.persona_code ?? null, hook: m?.hook_code ?? null, body: m?.body_code ?? null, angle: m?.angle_code ?? null }; };
  // Таймкоды: где в видео-референсе звучит/показан каждый параметр (Gemini, кеш). Не более 6 новых расчётов на документ.
  const priority = new Set<string>([...donorNames, ...slots.flatMap(s => [...(adsByCode.get(s.change?.toCode ?? "") ?? []), ...(adsByCode.get(s.change?.fromCode ?? "") ?? [])])]);
  const orderedRefNames = [...refNames].sort((a, b) => Number(priority.has(b)) - Number(priority.has(a)));
  const timingItems = orderedRefNames.map(n => ({ adName: n, videoId: assetByName.get(k(n))?.video_id ?? null, texts: Object.fromEntries((["persona", "hook", "body", "angle"] as Axis[]).map(a => [a, codesOfAd(n)[a] ? textOf[codesOfAd(n)[a]!] ?? null : null])) as AxisTexts })).filter(i => i.videoId);
  const timings = await getParamTimings(sb, timingItems, { maxNew: 0 }).catch(() => new Map()); // только кеш: таймкоды считаются заранее (generate-briefs, POST /api/briefs/timings), экспорт не тянет видео и не падает по памяти/времени
  const AXIS_OF_LABEL: Record<string, Axis> = { [AXIS_LABEL.persona as string]: "persona", [AXIS_LABEL.hook as string]: "hook", [AXIS_LABEL.body as string]: "body", [AXIS_LABEL.angle as string]: "angle" };
  /** Ссылка на референс параметра: для видео — фрагмент с этим параметром (#t=start,end), для статики — баннер целиком */
  const paramRefLink = (name: string, axis: Axis | null): { text: string; url: string } | null => {
    const m = mediaLink(name); if (!m) return null;
    const seg = axis ? timings.get(name)?.[axis] ?? null : null;
    if (seg) return { text: `${name} · фрагмент ${fmtSec(seg[0])}–${fmtSec(seg[1])}`, url: fragmentUrl(m.url, seg) };
    return { text: `${name} · ${m.label === "видео" ? "видео целиком (таймкод не определён)" : "баннер"}`, url: m.url };
  };
  const refRows = (code: string, limit = 6): string[][] => {
    const names = [...(adsByCode.get(code) ?? [])].map(n => ({ n, p: perfByName.get(k(n)) })).sort((a, b) => num(b.p?.spend) - num(a.p?.spend)).slice(0, limit);
    return names.map(({ n, p }) => [n, STATUS[p?.auto_status ?? "unknown"] ?? "—", eur(p ? num(p.spend) : null, 0), String(p ? num(p.leads) : "—"), eur(p?.cpl == null ? null : num(p.cpl)), eur(p?.cpql == null ? null : num(p.cpql)), mediaLink(n)?.url ?? "—"]);
  };

  const teamNotes = await loadTeamNotes(sb, donorNames).catch(() => new Map());
  const children: (Paragraph | Table)[] = [];
  const title = `ТЗ на креативы · ${session?.name ?? "пак"}`;
  children.push(h1(title));
  children.push(small(`Сформировано ${ruDate(new Date().toISOString())} · Creative System · ${briefs.length} бриф(ов)${pack?.report ? ` · на основе отчёта от ${ruDate(pack.report.createdAt)}${pack.report.dateFrom ? ` за ${pack.report.dateFrom} – ${pack.report.dateTo}` : " (lifetime)"}` : ""}`));

  briefs.forEach((b, idx) => {
    const P = (idv: string | null): ParamRef | undefined => (idv ? refs[idv] : undefined);
    const persona = P(b.persona_id), hook = P(b.hook_id), body = P(b.body_id), angle = P(b.angle_id);
    const slot = slots.find(s => (s.codes.persona ?? "") === (persona?.code ?? "") && s.codes.hook === hook?.code && s.codes.body === body?.code && s.codes.angle === angle?.code);
    const actor = slot?.codes.actor ?? null; const concept = slot?.codes.concept ?? pack?.concept?.code ?? null;
    const fmt = (b.format ?? session?.format ?? "ugc").toUpperCase();
    const adName = buildAdName(persona?.code ?? "", hook?.code ?? "?", body?.code ?? "?", angle?.code ?? "?", fmt, undefined, concept, actor ?? undefined);

    if (idx > 0) children.push(new Paragraph({ children: [new PageBreak()] }));
    children.push(h1(`Бриф ${idx + 1} из ${briefs.length} · ${adName}`));
    children.push(small(`Имя объявления для Meta Ads Manager: ${adName}${slot?.category ? ` · тип слота: ${CAT[slot.category] ?? slot.category}` : ""}`));
    if (slot?.rationale) children.push(para(`Почему эта комбинация: ${slot.rationale}`, { size: 20, color: "444444" }));
    if (slot?.change) {
      const ch = slot.change; const axis = (["persona", "hook", "body", "angle"].includes(ch.axis) ? ch.axis : null) as Axis | null;
      const axisLabel = axis ? (AXIS_LABEL[axis] as string) : ch.axis === "concept" ? "Концепция" : ch.axis === "actor" ? "Актёр" : ch.axis;
      children.push(h2(`Что меняем: ${axisLabel}`));
      const fromText = ch.fromCode ? (textOf[ch.fromCode] ?? (ch.axis === "concept" ? pack?.concept?.name : undefined) ?? "") : "";
      const toText = textOf[ch.toCode] ?? "";
      children.push(para(`БЫЛО (у донора ${slot.basedOnAd ?? "—"}): ${ch.fromCode ? `${ch.fromCode} — «${fromText || "текст в библиотеке не найден"}»` : "параметра не было"}`, { size: 20 }));
      if (slot.basedOnAd) { const l = paramRefLink(slot.basedOnAd, axis); if (l) children.push(linkPara(`  референс «было»: ${l.text}`, l.url, "открыть")); }
      children.push(para(`СТАЛО: ${ch.toCode} — «${toText || "текст в библиотеке не найден"}»${ch.tier ? ` · уровень доказательности ${ch.tier}` : ""}`, { size: 20 }));
      const toRefs = [...(adsByCode.get(ch.toCode) ?? [])].map(n => ({ n, p: perfByName.get(k(n)) })).sort((a, b) => num(b.p?.spend) - num(a.p?.spend)).slice(0, 3);
      if (!toRefs.length) children.push(small("  референсов «стало» нет: формулировка в массиве ещё не стояла — это и есть гипотеза слота"));
      for (const { n, p } of toRefs) { const l = paramRefLink(n, axis); children.push(l ? linkPara(`  референс «стало»: ${l.text} · ${STATUS[p?.auto_status ?? "unknown"] ?? "—"} · CPL ${eur(p?.cpl == null ? null : num(p.cpl))}`, l.url, "открыть") : small(`  референс «стало»: ${n}`)); }
      children.push(small("Остальные параметры — как у донора. Всё, что не названо в «Что меняем», воспроизводится дословно."));
    }

    const axisRows: string[][] = [];
    const pushAxis = (label: string, r?: ParamRef | null, extra?: string) => { if (r) axisRows.push([label, r.code, r.text]); else if (extra) axisRows.push([label, "—", extra]); };
    pushAxis("Персона (обращение)", persona, "не задана");
    pushAxis("Хук", hook); pushAxis("Боди", body); pushAxis("Энгл", angle);
    if (actor) axisRows.push(["Актёр", actor, "кто в кадре — см. раздел «Параметры в ролике»"]);
    if (concept) axisRows.push(["Концепция", concept, pack?.concept?.name ?? ""]);
    axisRows.push(["Формат", fmt, ""]);
    children.push(h2("Параметры (дословно; правка текста = новая формулировка с новым кодом — вносится в приложении)"));
    children.push(table(["Параметр", "Код", "Текст"], axisRows, [22, 16, 62]));

    // Сам бриф (markdown → docx)
    children.push(h2("Бриф"));
    children.push(...markdownToDocx(briefMarkdownForDocx(b.full_brief ?? "")));

    // Референсы
    children.push(h2("Референсы"));
    children.push(para("Креативы из нашего массива, где уже стояли параметры этого брифа (топ по спенду). CPL/CPQL за весь срок жизни. Ссылки открывают актуальное медиа из Meta — смотреть исполнение: ритм, кадры, подача.", { size: 20, color: "444444" }));
    const refAxes: Array<[string, string | undefined]> = [
      [AXIS_LABEL.persona as string, persona?.code], [AXIS_LABEL.hook as string, hook?.code], [AXIS_LABEL.body as string, body?.code], [AXIS_LABEL.angle as string, angle?.code],
      ["Актёр", actor ?? undefined], ["Концепция", concept ?? undefined],
    ];
    for (const [label, code] of refAxes) {
      if (!code) continue;
      const rows = refRows(code);
      children.push(h3(`${label} · ${code}`));
      const axis = AXIS_OF_LABEL[label] ?? null;
      if (axis && textOf[code]) children.push(para(`Параметр дословно: «${textOf[code]}»`, { size: 20 }));
      if (!rows.length) { children.push(small(label === "Актёр" || label === "Концепция" ? `В размеченном массиве ещё нет крео с этим параметром (${label.toLowerCase()} ${code}) — референсов нет, это новая проверка.` : "Новая формулировка — в массиве ещё не было крео с ней. Это и есть гипотеза слота.")); continue; }
      children.push(table(["Креатив", "Статус", "Спенд", "Лиды", "CPL", "CPQL", "Медиа"], rows.map(r => r.slice(0, 6).concat([paramRefLink(r[0], axis)?.url ?? "—"])), [26, 10, 10, 8, 9, 9, 28]));
      // ссылка ведёт на фрагмент именно этого параметра (видео: #t=start,end по таймкодам Gemini); статика — баннер целиком
      for (const r of rows) { const l = paramRefLink(r[0], axis); if (l) children.push(linkPara(l.text, l.url, axis ? `открыть ${axis === "hook" ? "хук" : axis === "body" ? "боди" : axis === "angle" ? "энгл" : "персону"}` : `открыть`)); }
    }
    const donors = Array.from(new Set([slot?.basedOnAd, ...(slot?.fromWinners ?? [])].filter((n): n is string => !!n)));
    if (donors.length) {
      children.push(h3("Креативы-доноры слота — исполнение наследуем"));
      for (const n of donors) {
        const p = perfByName.get(k(n)); const m = mediaLink(n); const d = descByName.get(k(n));
        children.push(para(`**${n}** · ${STATUS[p?.auto_status ?? "unknown"] ?? "—"} · спенд ${eur(p ? num(p.spend) : null, 0)} · лиды ${p ? num(p.leads) : "—"} · CPL ${eur(p?.cpl == null ? null : num(p.cpl))} · CPQL ${eur(p?.cpql == null ? null : num(p.cpql))}${slot?.variedParam && n === slot.basedOnAd ? ` · меняем только: ${AXIS_LABEL[slot.variedParam as Axis] ?? slot.variedParam}` : ""}`));
        if (m) children.push(linkPara("Медиа", m.url, `открыть ${m.label}`));
        if (d) children.push(para(`Исполнение (разбор Gemini): ${d.replace(/\s+/g, " ").slice(0, 900)}${d.length > 900 ? "…" : ""}`, { size: 19, color: "444444" }));
        const tn = formatTeamNotes(teamNotes.get(n.trim().toLowerCase()), 3);
        if (tn) children.push(para(`Заметки команды (субъективный анализ): ${tn.replace(/\s+/g, " ")}`, { size: 19, color: "7A5A00" }));
      }
    }
  });

  const doc = new Document({
    creator: "Creative System", title,
    styles: { default: { document: { run: { font: FONT, size: 22 } } } },
    sections: [{ properties: { page: { margin: { top: 1000, bottom: 1000, left: 1100, right: 1100 } } }, children }],
  });
  const buf = await Packer.toBuffer(doc);
  const slug = (s: string) => s.replace(/[^\p{L}\p{N}]+/gu, "_").replace(/^_|_$/g, "");
  const fname = `ТЗ_${slug(session?.name ?? "pack")}${id ? `_бриф_${(briefs[0].batch_index ?? 0) + 1}` : ""}_${new Date().toISOString().slice(0, 10)}.docx`;
  return { buffer: Buffer.from(buf), fname, title: id ? `${title} · бриф ${(briefs[0].batch_index ?? 0) + 1}` : title, sessionId: briefs[0].session_id, briefIds: briefs.map(b => b.id) };
}
