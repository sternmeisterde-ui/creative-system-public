// ── Резолв id параметров брифа/крео → код и текст ────────────────────────────
// С 06.10.2026 брифы и крео ссылаются на formulations.id. Старые строки (до перехода)
// держат id прежних таблиц personas/hooks/bodies/angles — для них читаем оттуда (только чтение).
import type { SupabaseClient } from "@supabase/supabase-js";
import { FORMULATION_COLUMNS, type FormulationRow } from "@/lib/formulations";

export interface ParamRef { id: string; code: string; text: string; legacy: boolean }

export async function resolveParamRefs(sb: SupabaseClient, ids: (string | null | undefined)[]): Promise<Record<string, ParamRef>> {
  const uniq = Array.from(new Set(ids.filter((x): x is string => !!x)));
  const out: Record<string, ParamRef> = {};
  if (uniq.length === 0) return out;
  for (let i = 0; i < uniq.length; i += 200) {
    const { data } = await sb.from("formulations").select(FORMULATION_COLUMNS).in("id", uniq.slice(i, i + 200));
    for (const r of (data ?? []) as FormulationRow[]) out[r.id] = { id: r.id, code: r.code, text: r.text, legacy: false };
  }
  const missing = uniq.filter(id => !out[id]);
  if (missing.length === 0) return out;
  for (const table of ["personas", "hooks", "bodies", "angles"] as const) {
    const { data } = await sb.from(table).select("id, code, name").in("id", missing);
    for (const r of (data ?? []) as { id: string; code: string | null; name: string }[]) {
      if (!out[r.id]) out[r.id] = { id: r.id, code: r.code ?? "?", text: r.name, legacy: true };
    }
  }
  return out;
}
