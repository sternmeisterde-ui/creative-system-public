import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";
import { isPlatformConfigured } from "@/lib/platforms";
import { GOOGLE_CUSTOMER_ID } from "@/lib/google-ads";
import { fetchGoogleCreativeData } from "@/lib/google-creatives";

// ── Google Ads sync — грейн КРЕАТИВ ──────────────────────────────────────────
// Строки в meta_ads (platform='google'):
//   google:asset:<id>  — картинка / YouTube-ролик PMax (сумма по всем кампаниям)
//   google:ad:<id>     — объявление Search / Demand Gen / Video
//   google:rest:<cid>  — остаток спенда кампании без визуального крео (текст/фиды)
// Итог по трём видам = спенд аккаунта. Подробности и раскладка лидов — lib/google-creatives.ts.
//
// Параллельно обновляем каталог превью в meta_creatives (platform='google') с теми же
// ad_id / ad_name — по ним страница /mapping/google вешает коды P·H·B·A, а вид
// creative_performance джойнит лиды из Elly (elly-sync source=google) по ad_name.
//
// LIFETIME по умолчанию (как elly-sync) и ПОЛНАЯ ЗАМЕНА google-строк: один снимок-итог
// на крео, иначе view суммировал бы дневные снимки.
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  if (!isPlatformConfigured("google")) {
    return NextResponse.json(
      { error: "Google Ads не настроен. Нужны GOOGLE_ADS_DEVELOPER_TOKEN / CLIENT_ID / CLIENT_SECRET / REFRESH_TOKEN / LOGIN_CUSTOMER_ID / CUSTOMER_ID." },
      { status: 503 }
    );
  }

  const body = await req.json().catch(() => ({})) as { dateFrom?: string; dateTo?: string };
  const dateTo = body.dateTo ?? new Date().toISOString().slice(0, 10);
  const dateFrom = body.dateFrom ?? "2024-01-01";

  let data;
  try {
    data = await fetchGoogleCreativeData(dateFrom, dateTo);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }

  const byKind: Record<string, number> = {};
  const byChannelType: Record<string, number> = {};
  let totalSpend = 0;

  const adRows = data.rows
    .filter(r => r.spend > 0 || r.impressions > 0)
    .map(r => {
      byKind[r.kind] = (byKind[r.kind] ?? 0) + 1;
      byChannelType[r.channelType] = (byChannelType[r.channelType] ?? 0) + 1;
      totalSpend += r.spend;
      const top = [...r.slices].sort((a, b) => b.spend - a.spend)[0];
      return {
        ad_id: r.key,
        ad_name: r.label,
        campaign_id: top?.campaignId ?? null,
        campaign_name: top?.campaignName ?? null,
        adset_name: r.kind === "asset" ? `PMax · ${r.slices.length} камп.` : null,
        flow: r.flow,
        account_id: GOOGLE_CUSTOMER_ID,
        platform: "google",
        date: dateTo,
        spend: r.spend,
        impressions: r.impressions,
        clicks: r.clicks,
        cpm: r.impressions ? (r.spend / r.impressions) * 1000 : 0,
        ctr: r.impressions ? (r.clicks / r.impressions) * 100 : 0,
        cpc: r.clicks ? r.spend / r.clicks : 0,
      };
    });

  const supabase = createServiceClient();
  let metaErr: string | null = null;
  let creErr: string | null = null;

  // Рекламные ролики на YouTube — unlisted, Gemini их по ссылке не читает (403). Их скачивает
  // scripts/google-video-backfill.py и кладёт в Supabase Storage, ссылка живёт в asset_url.
  // Полная замена каталога не должна её терять — переносим из текущих строк.
  const { data: prevCre } = await supabase.from("meta_creatives")
    .select("ad_id, asset_url").eq("platform", "google").like("asset_url", "%/storage/v1/%");
  const storedAsset = new Map((prevCre ?? []).map(r => [r.ad_id as string, r.asset_url as string]));

  const creativeRows = data.rows
    .filter(r => r.kind !== "rest" && r.thumbnailUrl)
    .map(r => ({
      ad_id: r.key,
      ad_name: r.label,
      flow: r.flow,
      object_type: r.objectType,
      thumbnail_url: r.thumbnailUrl,
      image_url: r.imageUrl,
      video_id: r.videoId,
      // картинка — прямой URL Google (скачивается), видео — mp4 из Storage, если уже скачан, иначе превью
      asset_url: storedAsset.get(r.key) ?? (r.objectType === "IMAGE" ? (r.imageUrl ?? r.thumbnailUrl) : r.thumbnailUrl),
      platform: "google",
    }));

  await supabase.from("meta_ads").delete().eq("platform", "google");
  if (adRows.length) {
    const { error } = await supabase.from("meta_ads").upsert(adRows, { onConflict: "ad_id,date" });
    metaErr = error?.message ?? null;
  }

  await supabase.from("meta_creatives").delete().eq("platform", "google");
  if (creativeRows.length) {
    const { error } = await supabase.from("meta_creatives").upsert(creativeRows, { onConflict: "ad_id" });
    creErr = error?.message ?? null;
  }

  const campaignSpend = data.campaigns.reduce((s, c) => s + c.spend, 0);

  return NextResponse.json({
    ok: !metaErr && !creErr,
    platform: "google",
    grain: "creative",
    dateFrom,
    dateTo,
    campaigns: data.campaigns.length,
    syncedRows: adRows.length,
    byKind,
    byChannelType,
    totalSpend: Math.round(totalSpend),
    campaignSpend: Math.round(campaignSpend),
    creatives: creativeRows.length,
    videosWithFile: creativeRows.filter(c => c.object_type === "VIDEO" && String(c.asset_url).includes("/storage/v1/")).length,
    metaErr,
    creErr,
    note: "Лиды/выручка Google приходят из Elly (elly-sync source=google) и раскладываются по крео; см. lib/google-creatives.ts.",
  });
}

export async function GET() {
  return POST(new NextRequest("http://localhost/api/google/sync", { method: "POST", body: "{}" }));
}
