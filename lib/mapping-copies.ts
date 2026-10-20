// ── Протяжка маппинга на копии объявлений ────────────────────────────────────────────────────────
// Meta при дублировании добавляет к имени « - Copy», « - Copy 2», «(1)». Копия — тот же креатив, но строки в
// ad_name_mapping у неё не было → движок пака, референсы и DOCX её не видели (авария 16.10.2026: виннер
// «…-MAN4022-UGC - Copy» выпал из пака). Здесь копии получают маппинг базового имени. Вызывается после meta/sync и перед сборкой пака.
import type { SupabaseClient } from "@supabase/supabase-js";
import { baseAdName } from "@/lib/naming";

export async function propagateCopyMappings(sb: SupabaseClient): Promise<{ created: number }> {
  const names = new Set<string>();
  for (let off = 0; ; off += 1000) {
    const { data } = await sb.from("meta_ads").select("ad_name").eq("platform", "meta").order("id").range(off, off + 999);
    for (const r of data ?? []) if (r.ad_name && baseAdName(r.ad_name) !== r.ad_name) names.add(r.ad_name);
    if (!data || data.length < 1000) break;
  }
  if (!names.size) return { created: 0 };
  const copies = [...names];
  const bases = Array.from(new Set(copies.map(baseAdName)));
  const have = new Set<string>(); const baseMap = new Map<string, Record<string, unknown>>();
  for (let i = 0; i < copies.length; i += 200) { const { data } = await sb.from("ad_name_mapping").select("ad_name").in("ad_name", copies.slice(i, i + 200)); for (const r of data ?? []) have.add(r.ad_name); }
  for (let i = 0; i < bases.length; i += 200) { const { data } = await sb.from("ad_name_mapping").select("*").in("ad_name", bases.slice(i, i + 200)); for (const r of data ?? []) baseMap.set(r.ad_name, r as Record<string, unknown>); }
  const rows: Record<string, unknown>[] = [];
  for (const c of copies) {
    if (have.has(c)) continue;
    const b = baseMap.get(baseAdName(c)); if (!b) continue;
    const { id: _i, ad_name: _a, created_at: _c, updated_at: _u, ...rest } = b as Record<string, unknown> & { id?: unknown; ad_name: string; created_at?: string; updated_at?: string };
    rows.push({ ...rest, ad_name: c, mapped_by: "copy-of-base", mapped_at: new Date().toISOString(), note: `копия объявления ${baseAdName(c)} — маппинг унаследован автоматически` });
  }
  if (rows.length) { const { error } = await sb.from("ad_name_mapping").upsert(rows, { onConflict: "ad_name" }); if (error) throw new Error(error.message); }
  return { created: rows.length };
}
