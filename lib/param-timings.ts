// ── Таймкоды параметров в видео-креативах (кеш) ──────────────────────────────────────────────────
// Для ТЗ: референс хука = фрагмент донора с хуком, а не весь ролик. Считается Gemini один раз на креатив
// (gemini_analyses mode='timings'), дальше читается из кеша. Статики таймкодов не имеют.
import type { SupabaseClient } from "@supabase/supabase-js";
import { extractTimings, resolveMetaVideoSource, type ParamTimings } from "@/lib/gemini";
import type { Axis } from "@/lib/formulations";

export type AxisTexts = Partial<Record<Axis, string | null>>;

export async function getParamTimings(sb: SupabaseClient, items: Array<{ adName: string; videoId: string | null; texts: AxisTexts }>, opts?: { maxNew?: number }): Promise<Map<string, ParamTimings>> {
  const out = new Map<string, ParamTimings>();
  const names = items.map(i => i.adName);
  if (!names.length) return out;
  const { data: cached } = await sb.from("gemini_analyses").select("ad_name, analysis").eq("mode", "timings").in("ad_name", names);
  for (const c of cached ?? []) { try { out.set(c.ad_name, JSON.parse(c.analysis as string) as ParamTimings); } catch { /* skip */ } }
  let budget = opts?.maxNew ?? 6;
  for (const it of items) {
    if (out.has(it.adName) || !it.videoId || budget <= 0) continue;
    if (!Object.values(it.texts).some(Boolean)) continue;
    try {
      const src = await resolveMetaVideoSource(it.videoId); if (!src) continue;
      const t = await extractTimings(src, it.texts); budget--;
      out.set(it.adName, t);
      await sb.from("gemini_analyses").delete().eq("mode", "timings").eq("ad_name", it.adName);
      await sb.from("gemini_analyses").insert({ mode: "timings", ad_name: it.adName, analysis: JSON.stringify(t) });
    } catch { /* таймкоды — удобство, не блокер ТЗ */ }
  }
  return out;
}

export const fmtSec = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
export const fragmentUrl = (url: string, seg: [number, number] | null) => (seg ? `${url}#t=${seg[0]},${Math.max(seg[1], seg[0] + 1)}` : url);
