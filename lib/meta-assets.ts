// ── Догрузка ассетов крео из Meta по ad_id (превью/видео) ───────────────────────────────────────
// Полный ингест /api/meta/creatives обходит все аккаунты раз в сутки (крон). Между прогонами новые объявления
// не имеют строки в meta_creatives → снапшот недели/отчёта замораживался без videoId и видео не играло
// (авария 14.10.2026: 273 из 292 мед-объявлений с 20.09 без ассетов). Здесь — точечная догрузка только недостающих.
import type { SupabaseClient } from "@supabase/supabase-js";
import { getMetaAccountsMap } from "@/lib/brief";

const TOKEN = process.env.META_ACCESS_TOKEN;
type GraphAd = { id: string; name?: string; account_id?: string; creative?: { thumbnail_url?: string; image_url?: string; video_id?: string; object_type?: string } };

export async function ensureCreativeAssets(sb: SupabaseClient, adIds: string[]): Promise<{ checked: number; fetched: number }> {
  const ids = Array.from(new Set(adIds.filter(id => /^\d{6,}$/.test(id))));
  if (!ids.length || !TOKEN) return { checked: ids.length, fetched: 0 };
  const have = new Set<string>();
  for (let i = 0; i < ids.length; i += 500) {
    const { data } = await sb.from("meta_creatives").select("ad_id, video_id, asset_url").in("ad_id", ids.slice(i, i + 500));
    for (const r of data ?? []) if (r.video_id || r.asset_url) have.add(String(r.ad_id));
  }
  const missing = ids.filter(id => !have.has(id));
  if (!missing.length) return { checked: ids.length, fetched: 0 };
  const flowByAccount: Record<string, string> = {};
  for (const [flow, acc] of Object.entries(getMetaAccountsMap())) flowByAccount[acc.replace(/^act_/, "")] = flow;
  const rows: Record<string, unknown>[] = [];
  for (let i = 0; i < missing.length; i += 50) {
    const chunk = missing.slice(i, i + 50);
    const url = new URL("https://graph.facebook.com/v21.0/");
    url.searchParams.set("ids", chunk.join(","));
    url.searchParams.set("fields", "id,name,account_id,creative{thumbnail_url,image_url,video_id,object_type}");
    url.searchParams.set("access_token", TOKEN);
    const j = await fetch(url.toString()).then(r => r.json()).catch(() => null) as Record<string, GraphAd> | { error?: unknown } | null;
    if (!j || "error" in j) continue;
    for (const a of Object.values(j as Record<string, GraphAd>)) {
      if (!a?.id) continue;
      const c = a.creative ?? {};
      rows.push({
        ad_id: a.id, ad_name: a.name ?? "", flow: a.account_id ? flowByAccount[a.account_id] ?? "mixed" : null, platform: "meta",
        object_type: c.object_type ?? null, thumbnail_url: c.thumbnail_url ?? null, image_url: c.image_url ?? null, video_id: c.video_id ?? null,
        asset_url: c.image_url || c.thumbnail_url || null, fetched_at: new Date().toISOString(),
      });
    }
  }
  if (rows.length) await sb.from("meta_creatives").upsert(rows, { onConflict: "ad_id" });
  return { checked: ids.length, fetched: rows.length };
}
