// ── Комбинации пар параметров — чистый расчёт (без БД) ───────────────────────
// Вынесен из /api/analytics/combinations: тот же расчёт для lifetime-view и для окна дат.
import { parseAdNameWithMapping, type AdNameMapping } from "@/lib/naming";

export interface ComboStat {
  codeA: string;   // e.g. "P1"
  codeB: string;   // e.g. "H2"
  typeA: string;   // "persona"
  typeB: string;   // "hook"
  adCount: number;
  winners: number;
  fakeWinners: number;
  losers: number;
  leads: number;
  qualLeads: number;
  spend: number;
  cpl: number | null;
  cpql: number | null;
  winRate: number | null;  // настоящие виннеры / (winners + fakes + losers)
}

export interface ComboAdInput { adName: string; spend: number; leads: number; qualLeads: number; autoStatus: string }

const PAIRS: [string, string][] = [
  ["personaCode", "hookCode"], ["personaCode", "bodyCode"], ["personaCode", "angleCode"],
  ["hookCode", "bodyCode"], ["hookCode", "angleCode"], ["bodyCode", "angleCode"],
];
const FIELD_TO_TYPE: Record<string, string> = { personaCode: "persona", hookCode: "hook", bodyCode: "body", angleCode: "angle" };

type AggEntry = {
  codeA: string; codeB: string; typeA: string; typeB: string;
  spend: number; leads: number; qualLeads: number; adCount: number; winners: number; fakeWinners: number; losers: number;
};

export function computeCombinations(ads: ComboAdInput[], mapping: AdNameMapping[]): Record<string, ComboStat[]> {
  const parsed = ads.map(a => ({ a, parts: parseAdNameWithMapping(a.adName, mapping) }));
  const result: Record<string, ComboStat[]> = {};

  for (const [fieldA, fieldB] of PAIRS) {
    const agg: Record<string, AggEntry> = {};
    for (const { a, parts } of parsed) {
      const codeA = parts[fieldA as keyof typeof parts] as string | null;
      const codeB = parts[fieldB as keyof typeof parts] as string | null;
      if (!codeA || !codeB) continue;
      const e = agg[`${codeA}|${codeB}`] ??= {
        codeA, codeB, typeA: FIELD_TO_TYPE[fieldA], typeB: FIELD_TO_TYPE[fieldB],
        spend: 0, leads: 0, qualLeads: 0, adCount: 0, winners: 0, fakeWinners: 0, losers: 0,
      };
      e.spend += a.spend; e.leads += a.leads; e.qualLeads += a.qualLeads; e.adCount++;
      if (a.autoStatus === "winner") e.winners++;
      if (a.autoStatus === "fake_winner") e.fakeWinners++;
      if (a.autoStatus === "loser") e.losers++;
    }
    const combos: ComboStat[] = Object.values(agg).map(e => {
      const decided = e.winners + e.fakeWinners + e.losers;
      return {
        ...e,
        spend: Math.round(e.spend * 100) / 100,
        cpl: e.leads > 0 ? Math.round((e.spend / e.leads) * 100) / 100 : null,
        cpql: e.qualLeads > 0 ? Math.round((e.spend / e.qualLeads) * 100) / 100 : null,
        winRate: decided > 0 ? Math.round((e.winners / decided) * 100) / 100 : null,
      };
    });
    combos.sort((a, b) => {
      if (b.winners !== a.winners) return b.winners - a.winners;
      if (a.cpl == null && b.cpl == null) return b.spend - a.spend;
      if (a.cpl == null) return 1;
      if (b.cpl == null) return -1;
      return a.cpl - b.cpl;
    });
    result[`${fieldA}__${fieldB}`] = combos;
  }
  return result;
}
