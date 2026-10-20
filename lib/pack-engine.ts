// ── Движок состава пака: детерминированный дизайн эксперимента (08.10.2026, v2) ────────────
// Пак — эксперимент, из которого следующий отчёт выучит вклад каждого параметра. Категории:
//   • winner_family — семья: виннер ТОГО ЖЕ МЕДИА, меняется РОВНО одна формулировка (оси чередуются);
//   • winner_mix    — масштабирование: HELPS-формулировка/концепция в 2–3 РАЗНЫХ контекстах виннеров, по одной замене;
//   • discovery     — разведка концепций: новые концепции, тексты виннеров дословно, ≥3 крео на концепцию;
//   • transfer      — перенос медиа: виннер ДРУГОГО медиа (статика → видео или наоборот) целиком, тексты дословно, меняется только медиа;
//   • заполнитель   — перекрёстное опыление виннеров одного медиа.
// Уровни доказательности «стало» (tier): A — HELPS за период отчёта, ≥2 крео; B — HELPS за период с 1 крео ИЛИ HELPS за весь срок без
// свежего HURTS и с показами за 90 дней; C — наша формулировка с 1 крео (не лузер) в контексте виннера — только измерение.
// Сигналы и доноры берутся ТОЛЬКО из медиа пака (видео ↔ видео, статика ↔ статика): текст из статики в видео — другой параметр.
// Никаких догадок модели: выбор по бивариату и архиву, обоснование — шаблон. Внешние гипотезы (конкуренты, уровень D) — отдельный процесс.
import { parseAdNameWithMapping, type AdNameMapping } from "@/lib/naming";
import { computeBivariate, type BivariateResult } from "@/lib/bivariate";
import { isFormulationCode, type Axis, type Formulation } from "@/lib/formulations";
import type { Format, PackSlot, PackSlotCategory } from "@/lib/types";

export type Medium = "video" | "static";
export type Tier = "A" | "B" | "C";
export interface EngineRow { ad_name: string; auto_status: string; spend: number; cpl: number | null; cpql: number | null; leads: number; last_seen?: string | null }
export interface EngineConcept { code: string; name: string; category: string | null; isOurs: boolean }
export interface EngineActor { code: string; name: string; kind: string }

export interface EngineInput {
  format: Format;
  packSize: number;
  rows: EngineRow[];                 // архив отчёта (snapshot за период)
  lifetimeRows?: EngineRow[];        // весь срок (creative_performance) — уровень B
  mapping: AdNameMapping[];
  formulations: Formulation[];
  concepts: EngineConcept[];
  actors: EngineActor[];
  usage: Record<string, number>;
  medium: Record<string, Medium>;    // ad_name → медиа крео (по meta_creatives)
  exploreConcepts?: string[];
  autoExplore?: number;
  blockedConcepts?: string[];
  actorPool?: string[] | null;
  actorKind?: "ai" | "real" | null;
  transfer?: boolean;                // категория «перенос медиа» (по умолчанию да)
  shares?: { scale: number; family: number; explore: number; transfer: number };
}

export interface ExperimentCell { axis: Axis | "concept" | "actor"; code: string; label: string; slots: number[]; isNew: boolean }
export interface EngineWinner { adName: string; cpl: number | null; leads: number; spend: number; medium: Medium; codes: { persona: string; hook: string; body: string; angle: string }; concept: string | null; actor: string | null }
export interface EngineResult {
  slots: PackSlot[];
  distribution: Record<PackSlotCategory, number>;
  matrix: ExperimentCell[];
  notes: string[];
  signals: { helps: BivariateResult[]; hurts: BivariateResult[]; helpsConcepts: BivariateResult[]; lifetimeHelps: BivariateResult[] };
  tiers: Record<string, Tier>;       // код «стало» → уровень доказательности
  winnersUsed: string[];
  winners: EngineWinner[];           // виннеры медиа пака
  transferDonors: EngineWinner[];    // виннеры другого медиа (доноры переноса)
  exploreList: string[];
  medium: Medium;
  debug: { winners: number; helps: number; lifetimeHelps: number; cCandidates: number; rejectedArchiveDup: number; rejectedPackDup: number; fillers: number };
}

export const DEFAULT_BLOCKED_CONCEPTS = ["V2", "V3"];
const AXES4: Axis[] = ["persona", "hook", "body", "angle"];
const comboKey = (c: PackSlot["codes"]) => [c.persona, c.hook, c.body, c.angle].map(x => x ?? "").join("|");
export const mediumOfFormat = (f: Format): Medium => (f === "static" ? "static" : "video");
const RECENT_DAYS = 90;

export function designPack(inp: EngineInput): EngineResult {
  const shares = inp.shares ?? { scale: 0.45, family: 0.25, explore: 0.2, transfer: 0.1 };
  const useTransfer = inp.transfer ?? true;
  const blocked = new Set((inp.blockedConcepts ?? DEFAULT_BLOCKED_CONCEPTS).map(c => c.toUpperCase()));
  const notes: string[] = [];
  const medium = mediumOfFormat(inp.format);
  const otherMedium: Medium = medium === "video" ? "static" : "video";
  const byCode = new Map(inp.formulations.map(f => [f.code, f]));
  const conceptByCode = new Map(inp.concepts.map(c => [c.code.toUpperCase(), c]));
  const label = (code: string) => byCode.get(code)?.text ?? conceptByCode.get(code)?.name ?? code;
  const medOf = (name: string): Medium | null => inp.medium[name] ?? inp.medium[name.trim().toLowerCase()] ?? null;
  const toBiv = (rows: EngineRow[]) => computeBivariate(rows.map(r => ({ adName: r.ad_name, spend: r.spend, leads: r.leads, impressions: 0, video3s: 0, videoThru: 0, autoStatus: r.auto_status })), inp.mapping, {});

  // ── Сигналы ТОЛЬКО по медиа пака (период) + уровень B по всему сроку того же медиа
  const rowsMed = inp.rows.filter(r => medOf(r.ad_name) === medium);
  const rowsOther = inp.rows.filter(r => medOf(r.ad_name) === otherMedium);
  const biv = toBiv(rowsMed);
  const isTextHelps = (r: BivariateResult) => r.verdict === "HELPS" && AXES4.includes(r.paramType as Axis) && isFormulationCode(r.code);
  const helps = biv.results.filter(isTextHelps).sort((a, b) => Number(b.withCount >= 2) - Number(a.withCount >= 2) || (a.ratio ?? 9) - (b.ratio ?? 9));
  const hurts = biv.results.filter(r => r.verdict === "HURTS");
  const hurtSet = new Set(hurts.map(r => r.code));
  const helpsConcepts = biv.results.filter(r => r.verdict === "HELPS" && r.paramType === "concept" && !blocked.has(r.code.toUpperCase())).sort((a, b) => (a.ratio ?? 9) - (b.ratio ?? 9));

  const lifeMed = (inp.lifetimeRows ?? []).filter(r => medOf(r.ad_name) === medium);
  const lifeBiv = lifeMed.length ? toBiv(lifeMed) : null;
  const recentCut = Date.now() - RECENT_DAYS * 864e5;
  const recentNames = new Set(lifeMed.filter(r => r.last_seen && new Date(r.last_seen).getTime() >= recentCut).map(r => r.ad_name));
  const codesOfRecent = new Set<string>();
  for (const m of inp.mapping) if (recentNames.has(m.adName)) for (const c of [m.personaCode, m.hookCode, m.bodyCode, m.angleCode]) if (c) codesOfRecent.add(c);
  const periodCodes = new Set(helps.map(r => r.code));
  const lifetimeHelps = (lifeBiv?.results ?? []).filter(r => isTextHelps(r) && !periodCodes.has(r.code) && !hurtSet.has(r.code) && codesOfRecent.has(r.code))
    .sort((a, b) => Number(b.withCount >= 2) - Number(a.withCount >= 2) || (a.ratio ?? 9) - (b.ratio ?? 9));
  const tiers: Record<string, Tier> = {};
  for (const r of helps) tiers[r.code] = r.withCount >= 2 ? "A" : "B";
  for (const r of lifetimeHelps) tiers[r.code] = "B";
  const tierOf = (code: string): Tier => tiers[code] ?? "C";
  const tierLabel = (code: string) => ({ A: "уровень A: HELPS за период, ≥2 крео", B: "уровень B: слабый сигнал (1 крео за период или HELPS за весь срок)", C: "уровень C: наша формулировка с 1 крео, только измерение" })[tierOf(code)];

  // ── Виннеры: медиа пака (основа) и другого медиа (доноры переноса), только с полным набором формулировок
  const toWinner = (r: EngineRow): EngineWinner | null => {
    const p = parseAdNameWithMapping(r.ad_name, inp.mapping);
    const codes = { persona: p.personaCode ?? "", hook: p.hookCode ?? "", body: p.bodyCode ?? "", angle: p.angleCode ?? "" };
    // персона необязательна (нет прямого обращения → null); хук, боди и энгл — обязательны. Баг 16.10.2026: требование персоны выкидывало всех виннеров без неё.
    if (![codes.hook, codes.body, codes.angle].every(isFormulationCode)) return null;
    if (codes.persona && !isFormulationCode(codes.persona)) codes.persona = "";
    return { adName: r.ad_name, cpl: r.cpl, leads: r.leads, spend: r.spend, medium: medOf(r.ad_name) ?? medium, codes, concept: p.conceptCode, actor: p.actorCode };
  };
  // Копии одного креатива («… - Copy») — один виннер: оставляем лучшую по CPL, иначе семьи дублируются на тех же кодах
  const dedupe = (ws: EngineWinner[]) => { const seenW = new Set<string>(); return ws.filter(w => { const k = `${comboKey(w.codes)}|${w.concept ?? ""}|${w.actor ?? ""}`; if (seenW.has(k)) return false; seenW.add(k); return true; }); };
  const winners = dedupe(rowsMed.filter(r => r.auto_status === "winner").map(toWinner).filter((w): w is EngineWinner => !!w).sort((a, b) => (a.cpl ?? 9e9) - (b.cpl ?? 9e9)));
  const transferDonors = dedupe(rowsOther.filter(r => r.auto_status === "winner").map(toWinner).filter((w): w is EngineWinner => !!w).sort((a, b) => (a.cpl ?? 9e9) - (b.cpl ?? 9e9)));
  const unmappedWinners = rowsMed.filter(r => r.auto_status === "winner" && !toWinner(r)).map(r => r.ad_name);
  if (unmappedWinners.length) notes.push(`Виннеры этого медиа без формулировок (не попали в пак — разметь их в /mapping): ${unmappedWinners.join(", ")}.`);
  if (!winners.length) notes.push(`В отчёте нет виннеров-${medium === "video" ? "видео" : "статик"} с полным набором формулировок — семьи и масштабирование строить не на чем; пак из переноса медиа и разведки.`);

  // ── Уровень C: наши формулировки медиа пака с 1 крео (не лузер, не HURTS), ещё не измеренные
  const statusByName = new Map(inp.rows.map(r => [r.ad_name, r.auto_status]));
  const cCandidates: Record<Axis, string[]> = { persona: [], hook: [], body: [], angle: [] };
  const codeCount: Record<string, { n: number; ok: boolean; medium: Medium | null }> = {};
  for (const m of inp.mapping) {
    const med = medOf(m.adName); const st = statusByName.get(m.adName);
    for (const c of [m.personaCode, m.hookCode, m.bodyCode, m.angleCode]) {
      if (!c || !isFormulationCode(c)) continue;
      const e = codeCount[c] ??= { n: 0, ok: true, medium: med };
      e.n++; if (st === "loser" || st === "fake_winner") e.ok = false; if (med !== medium) e.medium = null;
    }
  }
  for (const f of inp.formulations) {
    const e = codeCount[f.code];
    if (e && e.n === 1 && e.ok && e.medium === medium && !hurtSet.has(f.code) && !tiers[f.code]) cCandidates[f.axis].push(f.code);
  }

  // ── Актёры
  const wantKind: "ai" | "real" | null = inp.format === "static" ? null : inp.actorKind ?? (inp.format === "human" ? "real" : "ai");
  const actorPool = inp.actors.filter(a => (!inp.actorPool || inp.actorPool.includes(a.code)) && (!wantKind || a.kind === wantKind) && !hurtSet.has(a.code))
    .sort((a, b) => (inp.usage[b.code] ?? 0) - (inp.usage[a.code] ?? 0));
  let actorIdx = 0;
  const n = Math.max(3, inp.packSize);
  const useCount: Record<string, number> = {};
  const nextActor = (prefer?: string | null, keep = false): string | null => {
    if (inp.format === "static") return null;
    if (prefer && actorPool.some(a => a.code === prefer) && (keep || (useCount[prefer] ?? 0) < Math.max(4, Math.ceil(n / 3)))) return prefer;
    if (!actorPool.length) return null;
    return actorPool[actorIdx++ % Math.min(actorPool.length, 4)].code;
  };
  const actorNote = (w: { actor: string | null }, chosen: string | null) => (chosen && chosen !== w.actor ? ` Актёр виннера ${w.actor ? `${w.actor} не подходит под производство (${wantKind === "ai" ? "ИИ" : "реальные"})` : "не размечен"} — поставлен ${chosen}; это второе изменение, учитывать при сравнении.` : "");
  const keptPhrase = (w: { actor: string | null }, chosen: string | null) => (chosen && chosen !== w.actor ? "концепция — как у виннера" : "концепция и актёр — как у виннера");
  const conceptOf = (w: EngineWinner) => (w.concept && !blocked.has(w.concept.toUpperCase()) ? w.concept : null);

  // ── Уникальность и push
  const seen = new Set<string>(); const seenWithConcept = new Set<string>();
  for (const m of inp.mapping) { const k = [m.personaCode, m.hookCode, m.bodyCode, m.angleCode].map(x => x ?? "").join("|"); seen.add(k); seenWithConcept.add(`${k}|${m.conceptCode ?? ""}`); }
  const slots: PackSlot[] = [];
  const debug = { winners: winners.length, helps: helps.length, lifetimeHelps: lifetimeHelps.length, cCandidates: Object.values(cCandidates).reduce((a, b) => a + b.length, 0), rejectedArchiveDup: 0, rejectedPackDup: 0, fillers: 0 };
  const push = (s: Omit<PackSlot, "slotId">): boolean => {
    const key = comboKey(s.codes) + `|${s.codes.concept ?? ""}`;
    const sameMediumDup = seen.has(comboKey(s.codes)) && (!s.codes.concept || seenWithConcept.has(key)) && s.category !== "transfer";
    if (sameMediumDup) { debug.rejectedArchiveDup++; return false; }
    if (slots.some(x => comboKey(x.codes) + `|${x.codes.concept ?? ""}` === key)) { debug.rejectedPackDup++; return false; } // одна комбинация — один слот, независимо от категории
    slots.push({ ...s, slotId: slots.length + 1 });
    for (const c of [s.codes.persona, s.codes.hook, s.codes.body, s.codes.angle, s.codes.concept, s.codes.actor]) if (c) useCount[c] = (useCount[c] ?? 0) + 1;
    return true;
  };
  const MAX_USE_TEXT = 4;
  const cnt = (cat: PackSlotCategory) => slots.filter(s => s.category === cat).length;

  // ── 1. Перенос медиа: виннер другого медиа целиком, меняется только медиа (+ концепция/актёр, нужные видео)
  const nTransfer = useTransfer && transferDonors.length ? Math.max(0, Math.round(n * shares.transfer)) : 0;
  for (let i = 0; i < transferDonors.length && cnt("transfer") < nTransfer; i++) {
    const d = transferDonors[i];
    const concept = medium === "video" ? (helpsConcepts[0]?.code ?? null) : null;
    const actor = medium === "video" ? nextActor(null) : null;
    push({
      category: "transfer", codes: { ...d.codes, concept, actor }, basedOnAd: d.adName, fromWinners: [d.adName], helpsCodes: [],
      change: { axis: "concept", fromCode: null, toCode: concept ?? inp.format.toUpperCase(), kind: "transfer" },
      rationale: `Перенос медиа: виннер-${d.medium === "static" ? "статика" : "видео"} ${d.adName} (CPL ${d.cpl?.toFixed(1) ?? "—"} €) целиком в ${medium === "video" ? "видео" : "статику"}. Все четыре формулировки дословно, меняется только медиа${concept ? `; для видео нужна концепция — взята HELPS-концепция ${concept} «${label(concept)}»` : ""}${actor ? ` и актёр ${actor}` : ""}. Проверяем, переносится ли текст между медиа — это отдельный вопрос, не вклад формулировки.`,
    });
  }

  // ── 2. Разведка концепций (только видео): выбранные + автодобор, ≥3 крео на концепцию, тексты виннеров медиа пака
  const blockedCats = new Set(inp.concepts.filter(c => blocked.has(c.code.toUpperCase())).map(c => c.category).filter((c): c is string => !!c));
  const explore = new Set((inp.exploreConcepts ?? []).map(c => c.toUpperCase()).filter(c => conceptByCode.has(c) && !blocked.has(c)));
  if (medium === "video") {
    const untested = inp.concepts.filter(c => (inp.usage[c.code] ?? 0) <= 1 && !blocked.has(c.code.toUpperCase()) && !explore.has(c.code.toUpperCase()) && !(c.category && blockedCats.has(c.category)));
    const seenCat = new Set<string>();
    for (const c of untested) { if (explore.size >= (inp.exploreConcepts?.length ?? 0) + (inp.autoExplore ?? 0)) break; if (c.category && seenCat.has(c.category)) continue; explore.add(c.code.toUpperCase()); if (c.category) seenCat.add(c.category); }
  }
  const exploreList = medium === "video" ? [...explore] : [];
  const nExploreTarget = Math.round(n * shares.explore);
  if (exploreList.length && winners.length) {
    const per = Math.max(3, Math.floor(nExploreTarget / exploreList.length));
    for (const code of exploreList) for (let i = 0; i < per; i++) {
      const w = winners[i % winners.length]; const actorE = nextActor(w.actor, true);
      push({
        category: "discovery", codes: { ...w.codes, concept: code, actor: actorE }, basedOnAd: w.adName, helpsCodes: [], change: { axis: "concept", fromCode: w.concept, toCode: code, kind: "explore" },
        rationale: `Разведка концепции ${code} «${label(code)}» (${inp.usage[code] ?? 0} крео в массиве): тексты виннера ${w.adName} (CPL ${w.cpl?.toFixed(1) ?? "—"} €) дословно${actorE && actorE === w.actor ? " и его актёр" : ""}, чтобы измерить саму концепцию. На концепцию ${per} крео с разными виннерами — минимум для вывода.${actorNote(w, actorE)}`,
      });
    }
  } else if (exploreList.length) notes.push("Разведку концепций не на чем строить: нет виннеров этого медиа с полными формулировками.");

  // ── 3. Семьи: виннер медиа пака, одна ось, замена уровня A → B → C
  const nFamily = Math.round(n * shares.family);
  // Кандидат на замену оси у виннера. Пропускаем коды, с которыми комбинация уже есть в паке или в архиве —
  // иначе при одном виннере лучший кандидат возвращался бесконечно, push отклонял дубль, и пак останавливался на 7 слотах (баг 12.10.2026).
  const pickReplacement = (axis: Axis, w: EngineWinner): { code: string; tier: Tier; r?: BivariateResult } | null => {
    const current = w.codes[axis];
    const concept = conceptOf(w);
    const fresh = (code: string) => {
      const codes = { ...w.codes, [axis]: code, concept };
      const key = comboKey(codes) + `|${concept ?? ""}`;
      if (slots.some(x => comboKey(x.codes) + `|${x.codes.concept ?? ""}` === key)) return false;
      return !(seen.has(comboKey(codes)) && (!concept || seenWithConcept.has(key)));
    };
    const fromList = (list: BivariateResult[]) => list.filter(r => r.paramType === axis && r.code !== current && !hurtSet.has(r.code) && (useCount[r.code] ?? 0) < MAX_USE_TEXT && fresh(r.code))
      .sort((a, b) => (useCount[b.code] === 1 ? 1 : 0) - (useCount[a.code] === 1 ? 1 : 0) || Number(b.withCount >= 2) - Number(a.withCount >= 2) || (a.ratio ?? 9) - (b.ratio ?? 9))[0];
    const a = fromList(helps); if (a) return { code: a.code, tier: tierOf(a.code), r: a };
    const b = fromList(lifetimeHelps); if (b) return { code: b.code, tier: "B", r: b };
    const c = cCandidates[axis].find(code => code !== current && (useCount[code] ?? 0) < 2 && fresh(code)); if (c) return { code: c, tier: "C" };
    return null;
  };
  let axisIdx = 0, wi = 0, guard = 0;
  while (cnt("winner_family") < nFamily && winners.length && guard++ < nFamily * 12) {
    const w = winners[wi++ % winners.length]; const axis = AXES4[axisIdx++ % 4]; const current = w.codes[axis];
    const alt = pickReplacement(axis, w); if (!alt) continue;
    const actorF = nextActor(w.actor, true);
    const sig = alt.r ? ` (HELPS ×${alt.r.ratio?.toFixed(2) ?? "—"}, ${alt.r.withCount} крео${alt.tier === "B" && !periodCodes.has(alt.code) ? ", сигнал за весь срок" : ""})` : " (без сигнала: 1 крео в массиве)";
    push({
      category: "winner_family", codes: { ...w.codes, [axis]: alt.code, concept: conceptOf(w), actor: actorF }, basedOnAd: w.adName, variedParam: axis, helpsCodes: alt.r ? [alt.code] : [], change: { axis, fromCode: current, toCode: alt.code, kind: alt.tier === "C" ? "ours" : "helps", tier: alt.tier },
      rationale: `Семья виннера ${w.adName} (CPL ${w.cpl?.toFixed(1) ?? "—"} €): меняем только ${axis} → ${alt.code} «${label(alt.code).slice(0, 70)}»${sig}; ${tierLabel(alt.code)}. Остальные три формулировки и ${keptPhrase(w, actorF)}, так измерим вклад одного параметра.${actorNote(w, actorF)}`,
    });
  }

  // ── 4. Масштабирование: уровни A и B в 2–3 разных контекстах виннеров
  const nScale = Math.max(0, n - slots.length);
  for (const hc of helpsConcepts) for (let i = 0; i < winners.length && cnt("winner_mix") < nScale && (useCount[hc.code] ?? 0) < 3; i++) {
    const w = winners[i]; if (w.concept === hc.code) continue; const actorC = nextActor(w.actor, true);
    push({
      category: "winner_mix", codes: { ...w.codes, concept: hc.code, actor: actorC }, basedOnAd: w.adName, fromWinners: [w.adName], helpsCodes: [hc.code], change: { axis: "concept", fromCode: w.concept, toCode: hc.code, kind: "helps-concept", tier: hc.withCount >= 2 ? "A" : "B" },
      rationale: `Масштабируем концепцию ${hc.code} «${label(hc.code)}» (HELPS ×${hc.ratio?.toFixed(2) ?? "—"}, ${hc.withCount} крео): тексты виннера ${w.adName} (CPL ${w.cpl?.toFixed(1) ?? "—"} €) дословно, меняется только исполнение.${actorNote(w, actorC)}`,
    });
  }
  const scaleList = [...helps, ...lifetimeHelps];
  let hi = 0; guard = 0;
  while (cnt("winner_mix") < nScale && scaleList.length && winners.length && guard++ < nScale * 20) {
    const r = scaleList[hi++ % scaleList.length];
    if ((useCount[r.code] ?? 0) >= 3) { if (scaleList.every(x => (useCount[x.code] ?? 0) >= 3)) break; continue; }
    const axis = r.paramType as Axis;
    const w = winners.find(w => w.codes[axis] !== r.code && !slots.some(s => s.basedOnAd === w.adName && s.helpsCodes?.includes(r.code)));
    if (!w) continue;
    const actorS = nextActor(w.actor, true); const tier = tierOf(r.code);
    push({
      category: "winner_mix", codes: { ...w.codes, [axis]: r.code, concept: conceptOf(w), actor: actorS }, basedOnAd: w.adName, fromWinners: [w.adName], variedParam: axis, helpsCodes: [r.code], change: { axis, fromCode: w.codes[axis], toCode: r.code, kind: "helps", tier },
      rationale: `Масштабируем ${axis} ${r.code} «${label(r.code).slice(0, 70)}» (HELPS ×${r.ratio?.toFixed(2) ?? "—"}, ${r.withCount} крео${periodCodes.has(r.code) ? "" : ", сигнал за весь срок"}; ${tierLabel(r.code)}) в контексте виннера ${w.adName} (CPL ${w.cpl?.toFixed(1) ?? "—"} €): остальные три формулировки и ${keptPhrase(w, actorS)}. Это ${(useCount[r.code] ?? 0) + 1}-й контекст для этой формулировки.${actorNote(w, actorS)}`,
    });
  }

  // ── 5. Заполнитель: перекрёстное опыление виннеров того же медиа
  guard = 0;
  while (slots.length < n && winners.length >= 2 && guard++ < n * 30) {
    const a = winners[guard % winners.length], b = winners[(guard * 7 + 3) % winners.length];
    if (a.adName === b.adName) continue;
    const axis = AXES4[guard % 4];
    if (a.codes[axis] === b.codes[axis] || hurtSet.has(b.codes[axis]) || (useCount[b.codes[axis]] ?? 0) >= MAX_USE_TEXT) continue;
    const actorX = nextActor(a.actor, true);
    const ok = push({
      category: "winner_family", codes: { ...a.codes, [axis]: b.codes[axis], concept: conceptOf(a), actor: actorX }, basedOnAd: a.adName, fromWinners: [a.adName, b.adName], variedParam: axis, helpsCodes: [], change: { axis, fromCode: a.codes[axis], toCode: b.codes[axis], kind: "cross", tier: tierOf(b.codes[axis]) },
      rationale: `Перекрёстное опыление: в виннер ${a.adName} (CPL ${a.cpl?.toFixed(1) ?? "—"} €) ставим ${axis} виннера ${b.adName} — ${b.codes[axis]} «${label(b.codes[axis]).slice(0, 60)}». Обе формулировки из виннеров того же медиа, комбинация новая, меняется один параметр; ${keptPhrase(a, actorX)} ${a.adName}.${actorNote(a, actorX)}`,
    });
    if (ok) debug.fillers++;
  }

  // ── 6. Добор до размера: ещё семьи (уровень C — измерение наших неизмеренных формулировок), когда HELPS и опыление исчерпаны
  guard = 0; wi = 0; axisIdx = 1;
  while (slots.length < n && winners.length && guard++ < n * 12) {
    const w = winners[wi++ % winners.length]; const axis = AXES4[axisIdx++ % 4]; const current = w.codes[axis];
    const alt = pickReplacement(axis, w); if (!alt) continue;
    const actorF = nextActor(w.actor, true);
    const sig = alt.r ? ` (HELPS ×${alt.r.ratio?.toFixed(2) ?? "—"}, ${alt.r.withCount} крео)` : " (без сигнала: 1 крео в массиве)";
    const ok = push({
      category: "winner_family", codes: { ...w.codes, [axis]: alt.code, concept: conceptOf(w), actor: actorF }, basedOnAd: w.adName, variedParam: axis, helpsCodes: alt.r ? [alt.code] : [], change: { axis, fromCode: current, toCode: alt.code, kind: alt.tier === "C" ? "ours" : "helps", tier: alt.tier },
      rationale: `Семья виннера ${w.adName} (CPL ${w.cpl?.toFixed(1) ?? "—"} €), добор для измерения: меняем только ${axis} → ${alt.code} «${label(alt.code).slice(0, 70)}»${sig}; ${tierLabel(alt.code)}. Остальные три формулировки и ${keptPhrase(w, actorF)}.${actorNote(w, actorF)}`,
    });
    if (ok) debug.fillers++;
  }

  // ── Порядок и номера
  const order: Record<PackSlotCategory, number> = { winner_family: 0, winner_mix: 1, transfer: 2, discovery: 3, competitor: 4 };
  slots.sort((a, b) => order[a.category] - order[b.category] || a.slotId - b.slotId);
  if (slots.length > n) slots.splice(n);
  slots.forEach((s, i) => { s.slotId = i + 1; });

  // ── Матрица и заметки
  const cells = new Map<string, ExperimentCell>();
  for (const s of slots) for (const [axis, code] of [["persona", s.codes.persona], ["hook", s.codes.hook], ["body", s.codes.body], ["angle", s.codes.angle], ["concept", s.codes.concept], ["actor", s.codes.actor]] as Array<[ExperimentCell["axis"], string | null | undefined]>) {
    if (!code) continue;
    const cell = cells.get(code) ?? { axis, code, label: label(code), slots: [], isNew: (inp.usage[code] ?? 0) === 0 };
    cell.slots.push(s.slotId); cells.set(code, cell);
  }
  const matrix = [...cells.values()].sort((a, b) => b.slots.length - a.slots.length);
  const single = matrix.filter(c => c.axis !== "actor" && c.slots.length === 1 && (inp.usage[c.code] ?? 0) <= 1);
  if (single.length) notes.push(`${single.length} параметр(ов) стоят только в ОДНОМ слоте этого пака и в массиве встречались ≤1 раза — после запуска у них будет ≤2 крео, вклад измерить не получится: ${single.map(c => c.code).join(", ")}.`);
  notes.push(`Медиа пака: ${medium === "video" ? "видео" : "статика"}. Доноры и сигналы — только из этого медиа (${winners.length} виннеров, ${helps.length} HELPS за период, ${lifetimeHelps.length} за весь срок как уровень B). Текст из другого медиа идёт только через «перенос медиа».`);
  const tierCounts = { A: 0, B: 0, C: 0 };
  for (const s of slots) if (s.change?.tier) tierCounts[s.change.tier]++;
  if (tierCounts.B + tierCounts.C > tierCounts.A) notes.push(`Сигналов уровня A мало (${tierCounts.A}); слотов уровня B — ${tierCounts.B}, уровня C — ${tierCounts.C}. Пак больше измеряет, чем масштабирует: ждать от него виннеров рано, ждать знания — самое время.`);
  if (useTransfer && !transferDonors.length) notes.push(`Переноса медиа нет: в отчёте нет виннеров-${otherMedium === "video" ? "видео" : "статик"} с полными формулировками.`);
  if (blocked.size) notes.push(`Без новых слотов: ${[...blocked].join(", ")} (перекормленные концепции; снять блок можно в настройках).`);

  const distribution: Record<PackSlotCategory, number> = { winner_family: cnt("winner_family"), winner_mix: cnt("winner_mix"), discovery: cnt("discovery"), transfer: cnt("transfer"), competitor: 0 };
  return {
    slots, distribution, matrix, notes, tiers, debug, medium,
    signals: { helps, hurts, helpsConcepts, lifetimeHelps }, winners, transferDonors, exploreList,
    winnersUsed: Array.from(new Set(slots.flatMap(s => [s.basedOnAd, ...(s.fromWinners ?? [])]).filter((x): x is string => !!x))),
  };
}
