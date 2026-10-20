// ── Бивариативный анализ — чистый расчёт (без БД) ────────────────────────────
// Вынесен из /api/analytics/bivariate, чтобы тот же расчёт работал и по lifetime-view
// (creative_performance), и по строкам за произвольное окно дат (отчёт за период).
import { parseAdNameWithMapping, type AdNameMapping } from "@/lib/naming";

export interface BivariateResult {
  code: string;
  paramType: "persona" | "hook" | "body" | "angle" | "format" | "flow" | "concept" | "actor";
  label: string | null;
  color: string | null;
  withCount: number;
  withAds: string[];   // имена крео с этим параметром (до 8, по спенду)
  withSpend: number;
  withLeads: number;
  withCpl: number | null;
  withWinners: number;
  withFakeWinners: number;
  withLosers: number;
  withoutCount: number;
  withoutSpend: number;
  withoutLeads: number;
  withoutCpl: number | null;
  withoutWinners: number;
  withoutFakeWinners: number;
  withoutLosers: number;
  ratio: number | null;
  verdict: "HELPS" | "HURTS" | "NEUTRAL" | "INSUFFICIENT";
  // Hook rate (плеи/показы) — отдельное измерение «цепляет ли». Выше = лучше,
  // поэтому вердикт инвертирован относительно CPL.
  withHookRate: number | null;
  withoutHookRate: number | null;
  withHoldRate: number | null;
  hookRatio: number | null;
  hookVerdict: "HELPS" | "HURTS" | "NEUTRAL" | "INSUFFICIENT";
}

export interface FamilyMember {
  adName: string;
  code: string;
  spend: number;
  leads: number;
  cpl: number | null;
  autoStatus: string;
}

export interface GenealogyFamily {
  id: string;
  varyingParam: "persona" | "hook" | "body" | "angle";
  sharedPersona: string | null;
  sharedHook: string | null;
  sharedBody: string | null;
  sharedAngle: string | null;
  members: FamilyMember[];
  bestCpl: number | null;
  worstCpl: number | null;
}

/** Входная строка: одно крео (грань — имя объявления) с агрегатами за период. */
export interface BivAdInput {
  adName: string;
  spend: number;
  leads: number;
  impressions: number;
  video3s: number;     // старты/первые секунды (Meta video_3s или video_plays)
  videoThru: number;   // досмотры (thruplay)
  autoStatus: string;  // winner | fake_winner | loser | testing
}

export type LabelMap = Record<string, { name: string; color: string }>;

function blendedCpl(spend: number, leads: number): number | null {
  return leads > 0 ? Math.round((spend / leads) * 100) / 100 : null;
}

// Семьи: член может задавать best/worst CPL только при достаточном объёме лидов (см. историю в роуте).
const MIN_FAMILY_LEADS = 5;

function verdict(ratio: number | null, withLeads: number, withoutLeads: number): BivariateResult["verdict"] {
  if (ratio == null || withLeads < 3 || withoutLeads < 3) return "INSUFFICIENT";
  if (ratio < 0.75) return "HELPS";
  if (ratio > 1.33) return "HURTS";
  return "NEUTRAL";
}

// Hook rate: ВЫШЕ = лучше, пороги зеркальны CPL; значимость по показам (≥1000 в каждой группе).
function hookVerdict(ratio: number | null, withImpr: number, withoutImpr: number): BivariateResult["verdict"] {
  if (ratio == null || withImpr < 1000 || withoutImpr < 1000) return "INSUFFICIENT";
  if (ratio > 1.33) return "HELPS";
  if (ratio < 0.75) return "HURTS";
  return "NEUTRAL";
}

type AdRow = BivAdInput & {
  personaCode: string | null; hookCode: string | null; bodyCode: string | null; angleCode: string | null;
  conceptCode: string | null; actorCode: string | null; format: string | null; flow: string | null;
};

export function computeBivariate(input: BivAdInput[], mapping: AdNameMapping[], labelMap: LabelMap): {
  totalAds: number; totalSpend: number; totalLeads: number; results: BivariateResult[]; families: GenealogyFamily[];
} {
  const ads: AdRow[] = input.map(row => {
    const parts = parseAdNameWithMapping(row.adName, mapping);
    return {
      ...row,
      personaCode: parts.personaCode, hookCode: parts.hookCode, bodyCode: parts.bodyCode, angleCode: parts.angleCode,
      conceptCode: parts.conceptCode, actorCode: parts.actorCode,
      format: parts.format?.toUpperCase() ?? null, flow: parts.flow?.toUpperCase() ?? null,
    };
  });

  const totalSpend = ads.reduce((s, a) => s + a.spend, 0);
  const totalLeads = ads.reduce((s, a) => s + a.leads, 0);

  // ── Слой 1: параметрический split ──
  const results: BivariateResult[] = [];
  type ParamEntry = { code: string; paramType: BivariateResult["paramType"]; getCode: (a: AdRow) => string | null };
  const paramEntries: ParamEntry[] = [];
  const axes: { type: BivariateResult["paramType"]; get: (a: AdRow) => string | null }[] = [
    { type: "persona", get: a => a.personaCode }, { type: "hook", get: a => a.hookCode },
    { type: "body", get: a => a.bodyCode }, { type: "angle", get: a => a.angleCode },
    { type: "format", get: a => a.format },
    // ось flow (COM/GOV) убрана 28.09.2026 — потоков больше нет
    { type: "concept", get: a => a.conceptCode }, { type: "actor", get: a => a.actorCode },
  ];
  for (const ax of axes) {
    const codes = new Set<string>();
    for (const a of ads) { const c = ax.get(a); if (c) codes.add(c); }
    for (const code of codes) paramEntries.push({ code, paramType: ax.type, getCode: ax.get });
  }

  for (const entry of paramEntries) {
    const withAds    = ads.filter(a => entry.getCode(a) === entry.code);
    const withoutAds = ads.filter(a => entry.getCode(a) !== entry.code);
    const sum = (arr: AdRow[], f: (a: AdRow) => number) => arr.reduce((s, a) => s + f(a), 0);

    const withSpend = sum(withAds, a => a.spend), withLeads = sum(withAds, a => a.leads);
    const woutSpend = sum(withoutAds, a => a.spend), woutLeads = sum(withoutAds, a => a.leads);
    const cnt = (arr: AdRow[], st: string) => arr.filter(a => a.autoStatus === st).length;

    const withCpl = blendedCpl(withSpend, withLeads);
    const withoutCpl = blendedCpl(woutSpend, woutLeads);
    const ratio = withCpl != null && withoutCpl != null ? Math.round((withCpl / withoutCpl) * 1000) / 1000 : null;

    // Hook/hold — только для хуков и только по видео-крео (см. пояснения в истории роута).
    let withHookRate: number | null = null, withoutHookRate: number | null = null;
    let withHoldRate: number | null = null, hookRatio: number | null = null;
    let hVerdict: BivariateResult["verdict"] = "INSUFFICIENT";
    if (entry.paramType === "hook") {
      const withVid = withAds.filter(a => a.video3s > 0), woutVid = withoutAds.filter(a => a.video3s > 0);
      const wImpr = sum(withVid, a => a.impressions), w3s = sum(withVid, a => a.video3s), wThru = sum(withVid, a => a.videoThru);
      const oImpr = sum(woutVid, a => a.impressions), o3s = sum(woutVid, a => a.video3s);
      const rate = (n: number, d: number) => d > 0 ? Math.round((n / d * 100) * 100) / 100 : null;
      withHookRate = rate(w3s, wImpr); withoutHookRate = rate(o3s, oImpr); withHoldRate = rate(wThru, w3s);
      hookRatio = withHookRate != null && withoutHookRate ? Math.round((withHookRate / withoutHookRate) * 1000) / 1000 : null;
      hVerdict = hookVerdict(hookRatio, wImpr, oImpr);
    }

    const meta = labelMap[entry.code];
    results.push({
      code: entry.code, paramType: entry.paramType, label: meta?.name ?? null, color: meta?.color ?? null,
      withCount: withAds.length, withAds: [...withAds].sort((a, b) => b.spend - a.spend).slice(0, 8).map(a => a.adName),
      withSpend: Math.round(withSpend * 100) / 100, withLeads, withCpl,
      withWinners: cnt(withAds, "winner"), withFakeWinners: cnt(withAds, "fake_winner"), withLosers: cnt(withAds, "loser"),
      withoutCount: withoutAds.length, withoutSpend: Math.round(woutSpend * 100) / 100, withoutLeads: woutLeads, withoutCpl,
      withoutWinners: cnt(withoutAds, "winner"), withoutFakeWinners: cnt(withoutAds, "fake_winner"), withoutLosers: cnt(withoutAds, "loser"),
      ratio, verdict: verdict(ratio, withLeads, woutLeads),
      withHookRate, withoutHookRate, withHoldRate, hookRatio, hookVerdict: hVerdict,
    });
  }

  results.sort((a, b) => {
    const order = { HELPS: 0, HURTS: 1, NEUTRAL: 2, INSUFFICIENT: 3 };
    const oa = order[a.verdict], ob = order[b.verdict];
    if (oa !== ob) return oa - ob;
    const ra = a.ratio != null ? Math.abs(a.ratio - 1) : 0;
    const rb = b.ratio != null ? Math.abs(b.ratio - 1) : 0;
    return rb - ra;
  });

  // ── Слой 2: генеалогия (семьи по 3 общим кодам, 4-й варьируется) ──
  const families: GenealogyFamily[] = [];
  type VaryingKey = "persona" | "hook" | "body" | "angle";
  const varyingConfigs: {
    key: VaryingKey;
    getCode: (a: AdRow) => string | null;
    groupKey: (a: AdRow) => string;
    buildShared: (a: AdRow) => Pick<GenealogyFamily, "sharedPersona" | "sharedHook" | "sharedBody" | "sharedAngle">;
  }[] = [
    { key: "angle", getCode: a => a.angleCode, groupKey: a => [a.personaCode, a.hookCode, a.bodyCode].filter(Boolean).join("|"),
      buildShared: a => ({ sharedPersona: a.personaCode, sharedHook: a.hookCode, sharedBody: a.bodyCode, sharedAngle: null }) },
    { key: "body", getCode: a => a.bodyCode, groupKey: a => [a.personaCode, a.hookCode, a.angleCode].filter(Boolean).join("|"),
      buildShared: a => ({ sharedPersona: a.personaCode, sharedHook: a.hookCode, sharedBody: null, sharedAngle: a.angleCode }) },
    { key: "hook", getCode: a => a.hookCode, groupKey: a => [a.personaCode, a.bodyCode, a.angleCode].filter(Boolean).join("|"),
      buildShared: a => ({ sharedPersona: a.personaCode, sharedHook: null, sharedBody: a.bodyCode, sharedAngle: a.angleCode }) },
    { key: "persona", getCode: a => a.personaCode, groupKey: a => [a.hookCode, a.bodyCode, a.angleCode].filter(Boolean).join("|"),
      buildShared: a => ({ sharedPersona: null, sharedHook: a.hookCode, sharedBody: a.bodyCode, sharedAngle: a.angleCode }) },
  ];

  for (const config of varyingConfigs) {
    const groups: Record<string, AdRow[]> = {};
    for (const a of ads) {
      const gk = config.groupKey(a);
      if (!gk || gk.split("|").filter(Boolean).length < 2) continue;
      (groups[gk] ??= []).push(a);
    }
    for (const groupAds of Object.values(groups)) {
      if (new Set(groupAds.map(a => config.getCode(a)).filter(Boolean)).size < 2) continue;
      const qualifiedAds = groupAds.filter(a => a.spend >= 20);
      if (qualifiedAds.length < 2) continue;
      if (new Set(qualifiedAds.map(a => config.getCode(a)).filter(Boolean)).size < 2) continue;
      if (!qualifiedAds.some(a => a.leads >= MIN_FAMILY_LEADS)) continue;

      const rep = qualifiedAds[0];
      const members: FamilyMember[] = qualifiedAds.map(a => ({
        adName: a.adName, code: config.getCode(a) ?? "?", spend: Math.round(a.spend * 100) / 100,
        leads: a.leads, cpl: blendedCpl(a.spend, a.leads), autoStatus: a.autoStatus,
      })).sort((a, b) => {
        if (a.cpl == null && b.cpl == null) return b.spend - a.spend;
        if (a.cpl == null) return 1;
        if (b.cpl == null) return -1;
        return a.cpl - b.cpl;
      });
      const cpls = members.filter(m => m.leads >= MIN_FAMILY_LEADS && m.cpl != null).map(m => m.cpl as number);
      families.push({
        id: `${config.key}__${config.groupKey(rep)}`, varyingParam: config.key, ...config.buildShared(rep), members,
        bestCpl: cpls.length ? Math.min(...cpls) : null, worstCpl: cpls.length ? Math.max(...cpls) : null,
      });
    }
  }
  families.sort((a, b) => {
    const sa = a.bestCpl != null && a.worstCpl != null ? a.worstCpl - a.bestCpl : 0;
    const sb = b.bestCpl != null && b.worstCpl != null ? b.worstCpl - b.bestCpl : 0;
    return sb - sa;
  });

  return { totalAds: ads.length, totalSpend: Math.round(totalSpend * 100) / 100, totalLeads, results, families };
}
