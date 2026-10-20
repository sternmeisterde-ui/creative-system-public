import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";
import { extractVerbatim, resolveMetaVideoSource, resolveMetaImageSource } from "@/lib/gemini";
import { applyExtraction, isFormulationCode, type FormulationProduct } from "@/lib/formulations";
import { detectProduct } from "@/lib/product";
import { fetchAll } from "@/lib/paged";

// POST { limit?, product?, minSpend? } — пачка объявлений Meta без кодов формулировок (нет маппинга или
// в маппинге ещё старые групповые коды), по убыванию спенда. Возвращает остаток — фронт/скрипт зовёт в цикле.
export const maxDuration = 300;

const k = (s: string) => (s ?? "").trim().toLowerCase();

export async function POST(req: NextRequest) {
  // shard {i, n}: параллельные циклы берут непересекающиеся объявления (hash имени mod n)
  // exclude: имена, уже упавшие в этом прогоне (цикл передаёт их, чтобы не крутиться на одних и тех же)
  const body = await req.json().catch(() => ({})) as { limit?: number; product?: string; minSpend?: number; dryRun?: boolean; shard?: { i: number; n: number }; exclude?: string[] };
  const exclude = new Set((body.exclude ?? []).map(k));
  const shard = body.shard && body.shard.n > 1 ? body.shard : null;
  const hash = (s: string) => { let h = 0; for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return h; };
  const limit = Math.min(Math.max(body.limit ?? 4, 1), 12);
  const minSpend = Number(body.minSpend ?? 0);
  const wantProduct = body.product === "buchhalter" || body.product === "medadmin" ? body.product : null;
  const sb = createServiceClient();

  const [perfRes, mapRes, creRes] = await Promise.all([
    fetchAll((f, t) => sb.from("creative_performance").select("ad_name, campaign_name, adset_name, spend").eq("platform", "meta").not("ad_name", "is", null).order("ad_id").range(f, t)),
    fetchAll((f, t) => sb.from("ad_name_mapping").select("ad_name, persona_code, hook_code, body_code, angle_code").order("ad_name").range(f, t)),
    fetchAll((f, t) => sb.from("meta_creatives").select("ad_id, ad_name, asset_url, video_id, thumbnail_url, platform, object_type").order("ad_id").range(f, t)),
  ]);
  if (perfRes.error) return NextResponse.json({ error: perfRes.error }, { status: 500 });

  type Perf = { ad_name: string; campaign_name: string | null; adset_name: string | null; spend: string | number | null };
  const agg = new Map<string, { adName: string; campaign: string | null; adset: string | null; spend: number }>();
  for (const r of (perfRes.data ?? []) as Perf[]) {
    const cur = agg.get(k(r.ad_name)) ?? { adName: r.ad_name, campaign: r.campaign_name, adset: r.adset_name, spend: 0 };
    cur.spend += Number(r.spend ?? 0); agg.set(k(r.ad_name), cur);
  }
  const hasFormulations = new Set<string>();
  for (const m of (mapRes.data ?? []) as { ad_name: string; persona_code: string | null; hook_code: string | null; body_code: string | null; angle_code: string | null }[]) {
    if ([m.persona_code, m.hook_code, m.body_code, m.angle_code].some(isFormulationCode)) hasFormulations.add(k(m.ad_name));
  }
  type Cre = { ad_id: string | null; ad_name: string; asset_url: string | null; video_id: string | null; thumbnail_url: string | null; platform: string | null; object_type: string | null };
  const assets = new Map<string, Cre>();
  for (const c of (creRes.data ?? []) as Cre[]) if ((c.asset_url || c.video_id) && c.platform !== "google" && !assets.has(k(c.ad_name))) assets.set(k(c.ad_name), c);

  const pending = [...agg.values()]
    .filter(a => a.spend >= minSpend && !hasFormulations.has(k(a.adName)) && assets.has(k(a.adName)))
    .map(a => ({ ...a, product: detectProduct(a.adName, a.campaign, a.adset) as FormulationProduct }))
    .filter(a => !wantProduct || a.product === wantProduct)
    .filter(a => !shard || hash(k(a.adName)) % shard.n === shard.i)
    .filter(a => !exclude.has(k(a.adName)))
    .sort((a, b) => b.spend - a.spend);
  const noAsset = [...agg.values()].filter(a => a.spend >= minSpend && !hasFormulations.has(k(a.adName)) && !assets.has(k(a.adName))).length;
  if (body.dryRun) return NextResponse.json({ ok: true, pending: pending.length, noAsset, sample: pending.slice(0, 10) });

  let processed = 0; const failed: { adName: string; error: string }[] = []; let createdCodes = 0;
  for (const a of pending.slice(0, limit)) {
    try {
      const cre = assets.get(k(a.adName))!;
      let assetUrl = cre.asset_url;
      if (cre.video_id) assetUrl = (await resolveMetaVideoSource(String(cre.video_id))) ?? cre.thumbnail_url ?? cre.asset_url;
      else if (cre.ad_id && !(assetUrl ?? "").includes("/storage/v1/")) {
        // статика: сохранённый CDN-URL Meta протухает (403) → берём свежий по ad_id
        assetUrl = (await resolveMetaImageSource(cre.ad_id).catch(() => null)) ?? assetUrl;
      }
      if (!assetUrl) throw new Error("нет доступного ассета");
      const ex = await extractVerbatim(assetUrl);
      const format = cre.object_type === "VIDEO" || cre.video_id ? "ugc" : "static";
      const { created } = await applyExtraction(sb, a.adName, a.product, ex, "gemini", { format });
      createdCodes += created.length;
      await sb.from("gemini_analyses").delete().eq("mode", "verbatim").eq("ad_name", a.adName);
      await sb.from("gemini_analyses").insert({ mode: "verbatim", ad_name: a.adName, analysis: JSON.stringify(ex) });
      processed++;
    } catch (e) {
      failed.push({ adName: a.adName, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return NextResponse.json({ ok: true, processed, createdCodes, failed, remaining: Math.max(pending.length - processed, 0), noAsset });
}
