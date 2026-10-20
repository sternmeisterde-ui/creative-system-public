// ── Референсы: где уже стояли коды параметров и как показали себя (метрики + ссылка на медиа) ──
// Общая логика для ТЗ (lib/brief-docx.ts) и экрана «Следующий пак» (было → стало с референсами).
import type { SupabaseClient } from "@supabase/supabase-js";
import { detectProduct } from "@/lib/product";

export interface CreativeRef {
  adName: string; status: string; spend: number; leads: number; cpl: number | null; cpql: number | null;
  media: { url: string; label: string } | null;
}
export interface ReferenceSet { byCode: Record<string, CreativeRef[]>; byAd: Record<string, CreativeRef> }

const k = (s: string) => (s ?? "").trim().toLowerCase();
const num = (v: unknown) => (v == null ? 0 : Number(v));

export async function loadReferences(sb: SupabaseClient, opts: { codes: string[]; adNames?: string[]; origin: string; perCode?: number; product?: "buchhalter" | "medadmin" | null }): Promise<ReferenceSet> {
  const want = new Set(opts.codes);
  const adsByCode = new Map<string, Set<string>>();
  if (want.size) {
    for (let from = 0; ; from += 1000) {
      const { data } = await sb.from("ad_name_mapping").select("ad_name, persona_code, hook_code, body_code, angle_code, actor_code, concept_code, product").order("ad_name").range(from, from + 999);
      for (const m of data ?? []) for (const c of [m.persona_code, m.hook_code, m.body_code, m.angle_code, m.actor_code, m.concept_code]) {
        // концепции и актёры общие для продуктов — референсы берём только из крео своего продукта
        if (opts.product && detectProduct(m.ad_name, null, null, m.product) !== opts.product) continue;
        if (c && want.has(c)) { if (!adsByCode.has(c)) adsByCode.set(c, new Set()); adsByCode.get(c)!.add(m.ad_name); }
      }
      if (!data || data.length < 1000) break;
    }
  }
  const names = Array.from(new Set([...Array.from(adsByCode.values()).flatMap(s => [...s]), ...(opts.adNames ?? [])]));
  type Perf = { ad_id: string | null; ad_name: string; spend: unknown; leads: unknown; qual_leads: unknown; cpl: unknown; cpql: unknown; auto_status: string | null };
  type Asset = { ad_id: string | null; ad_name: string; video_id: string | null; asset_url: string | null };
  const perf = new Map<string, Perf>(); const asset = new Map<string, Asset>();
  for (let i = 0; i < names.length; i += 150) {
    const chunk = names.slice(i, i + 150);
    const [{ data: p }, { data: a }] = await Promise.all([
      sb.from("creative_performance").select("ad_id, ad_name, spend, leads, qual_leads, cpl, cpql, auto_status").in("ad_name", chunk).eq("platform", "meta"),
      sb.from("meta_creatives").select("ad_id, ad_name, video_id, asset_url").in("ad_name", chunk),
    ]);
    for (const r of (p ?? []) as Perf[]) {
      const cur = perf.get(k(r.ad_name));
      if (!cur) perf.set(k(r.ad_name), { ...r });
      else { cur.spend = num(cur.spend) + num(r.spend); cur.leads = num(cur.leads) + num(r.leads); cur.qual_leads = num(cur.qual_leads) + num(r.qual_leads); cur.cpl = num(cur.leads) ? num(cur.spend) / num(cur.leads) : null; cur.cpql = num(cur.qual_leads) ? num(cur.spend) / num(cur.qual_leads) : null; }
    }
    for (const r of (a ?? []) as Asset[]) if (!asset.has(k(r.ad_name)) || (r.video_id && !asset.get(k(r.ad_name))?.video_id)) asset.set(k(r.ad_name), r);
  }
  const media = (name: string) => {
    const a = asset.get(k(name)); if (!a) return null;
    if (a.video_id) return { url: `${opts.origin}/api/meta/video?videoId=${a.video_id}`, label: "видео" };
    if (a.ad_id) return { url: `${opts.origin}/api/meta/thumb?adId=${a.ad_id}`, label: "картинку" };
    return a.asset_url ? { url: a.asset_url, label: "медиа" } : null;
  };
  const toRef = (name: string): CreativeRef => {
    const p = perf.get(k(name));
    return { adName: name, status: p?.auto_status ?? "unknown", spend: p ? num(p.spend) : 0, leads: p ? num(p.leads) : 0, cpl: p?.cpl == null ? null : num(p.cpl), cpql: p?.cpql == null ? null : num(p.cpql), media: media(name) };
  };
  const byCode: Record<string, CreativeRef[]> = {};
  for (const [code, set] of adsByCode) byCode[code] = [...set].map(toRef).sort((a, b) => b.spend - a.spend).slice(0, opts.perCode ?? 4);
  const byAd: Record<string, CreativeRef> = {};
  for (const n of opts.adNames ?? []) byAd[n] = toRef(n);
  return { byCode, byAd };
}
