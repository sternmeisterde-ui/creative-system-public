// ── Заметки команды из субъективного анализа (/weekly) по имени креатива ────────────────────────
// Нужны в ТЗ: когда слот строится на крео-доноре, в бриф и DOCX попадают комментарии «что сработало / что менять»,
// которые команда оставила на неделе (weekly_creative_notes.note / todo). Берём все недели, свежие — первыми.
import type { SupabaseClient } from "@supabase/supabase-js";

export interface TeamNote { adName: string; weekStart: string; note: string | null; todo: string | null }

export async function loadTeamNotes(sb: SupabaseClient, adNames: string[]): Promise<Map<string, TeamNote[]>> {
  const out = new Map<string, TeamNote[]>();
  const want = new Set(adNames.map(n => n.trim().toLowerCase()));
  if (!want.size) return out;
  const { data: notes } = await sb.from("weekly_creative_notes").select("report_id, ad_id, note, todo, updated_at").or("note.neq.,todo.neq.").order("updated_at", { ascending: false }).limit(2000);
  const rows = (notes ?? []).filter(n => (n.note && n.note.trim()) || (n.todo && n.todo.trim()));
  if (!rows.length) return out;
  const reportIds = Array.from(new Set(rows.map(n => n.report_id)));
  const { data: reports } = await sb.from("weekly_creative_reports").select("id, week_start, rows").in("id", reportIds);
  const nameOf = new Map<string, string>(); const weekOf = new Map<string, string>();
  for (const r of reports ?? []) {
    weekOf.set(r.id, r.week_start);
    for (const x of (Array.isArray(r.rows) ? r.rows : []) as Array<{ adId?: string; adName?: string }>) if (x.adId && x.adName) nameOf.set(`${r.id}|${x.adId}`, x.adName);
  }
  for (const n of rows) {
    const adName = nameOf.get(`${n.report_id}|${n.ad_id}`); if (!adName) continue;
    const k = adName.trim().toLowerCase(); if (!want.has(k)) continue;
    const list = out.get(k) ?? []; list.push({ adName, weekStart: weekOf.get(n.report_id) ?? "", note: n.note?.trim() || null, todo: n.todo?.trim() || null }); out.set(k, list);
  }
  for (const list of out.values()) list.sort((a, b) => b.weekStart.localeCompare(a.weekStart));
  return out;
}

export function formatTeamNotes(list: TeamNote[] | undefined, max = 2): string {
  if (!list?.length) return "";
  return list.slice(0, max).map(n => `[неделя ${n.weekStart}] ${[n.note, n.todo ? `Что делаем: ${n.todo}` : null].filter(Boolean).join(" · ")}`).join("\n");
}
