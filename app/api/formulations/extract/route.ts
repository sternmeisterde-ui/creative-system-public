import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";
import { extractVerbatim, resolveMetaVideoSource, resolveMetaImageSource } from "@/lib/gemini";
import { applyExtraction, type FormulationProduct } from "@/lib/formulations";
import { detectProduct } from "@/lib/product";

// POST { adName, product? } — Gemini выписывает из креатива ДОСЛОВНЫЕ персону/хук/боди/энгл,
// каждый текст становится формулировкой (точное совпадение или новый код), коды пишутся в ad_name_mapping.
// Это замена старого маппера «выбери ближайший код из списка»: никакой классификации, только текст как есть.
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  const { adName, product: productQ } = await req.json().catch(() => ({})) as { adName?: string; product?: string };
  if (!adName) return NextResponse.json({ error: "adName обязателен" }, { status: 400 });
  const sb = createServiceClient();

  const [{ data: creatives }, { data: perf }] = await Promise.all([
    sb.from("meta_creatives").select("ad_id, ad_name, asset_url, video_id, thumbnail_url, platform, object_type").eq("ad_name", adName).limit(5),
    sb.from("creative_performance").select("campaign_name, adset_name").eq("ad_name", adName).limit(1),
  ]);
  const cre = (creatives ?? []).find(c => c.asset_url || c.video_id);
  if (!cre) return NextResponse.json({ error: "нет ассета в meta_creatives — сначала «Ассеты Meta»" }, { status: 404 });

  let assetUrl = cre.asset_url as string | null;
  if (cre.video_id && cre.platform !== "google") assetUrl = (await resolveMetaVideoSource(String(cre.video_id))) ?? cre.thumbnail_url ?? cre.asset_url;
  else if (cre.ad_id && cre.platform !== "google" && !(assetUrl ?? "").includes("/storage/v1/")) assetUrl = (await resolveMetaImageSource(String(cre.ad_id)).catch(() => null)) ?? assetUrl;
  if (!assetUrl) return NextResponse.json({ error: "не удалось получить ассет (видео удалено?)" }, { status: 404 });

  const product: FormulationProduct = productQ === "buchhalter" || productQ === "medadmin"
    ? productQ
    : detectProduct(adName, perf?.[0]?.campaign_name ?? null, perf?.[0]?.adset_name ?? null);

  try {
    const extraction = await extractVerbatim(assetUrl);
    const format = cre.object_type === "VIDEO" || cre.video_id ? "ugc" : "static";
    const { codes, created } = await applyExtraction(sb, adName, product, extraction, "gemini", { format });
    await sb.from("gemini_analyses").delete().eq("mode", "verbatim").eq("ad_name", adName);
    await sb.from("gemini_analyses").insert({ mode: "verbatim", ad_name: adName, analysis: JSON.stringify(extraction) });
    return NextResponse.json({ ok: true, adName, product, codes, created, extraction });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
