import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";
import { isPlatformConfigured } from "@/lib/platforms";
import { fetchTikTokCreativeData, TIKTOK_ADVERTISER_IDS } from "@/lib/tiktok";

// ── TikTok Ads sync — грейн КРЕАТИВ (объявление) ─────────────────────────────
// Как /api/google/sync: LIFETIME-снимок (query_lifetime) и ПОЛНАЯ ЗАМЕНА строк
// platform='tiktok' в meta_ads — одна строка-итог на объявление, иначе view суммировал бы
// дневные снимки. Ключ `tiktok:ad:<ad_id>`, ad_name = имя объявления TikTok — по нему
// view creative_performance джойнит лиды из Elly (elly-sync source=tiktok) и маппинг кодов.
//
// Видео-метрики → колонки Meta: video_plays = video_play_actions, video_3s = video_watched_2s,
// video_thruplay = video_watched_6s (прокси удержания; у TikTok нет 15-сек thruplay).
// Параллельно каталог превью в meta_creatives (platform='tiktok'): cover + временный mp4.
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  if (!isPlatformConfigured("tiktok")) {
    return NextResponse.json(
      { error: "TikTok Ads не настроен. Нужны TIKTOK_ACCESS_TOKEN (Marketing API, long-lived) и TIKTOK_ADVERTISER_ID (один или несколько через запятую)." },
      { status: 503 }
    );
  }

  const body = await req.json().catch(() => ({})) as { dateFrom?: string; dateTo?: string; lifetime?: boolean };
  const dateTo = body.dateTo ?? new Date().toISOString().slice(0, 10);
  const dateFrom = body.dateFrom ?? "2024-01-01";
  const lifetime = body.lifetime ?? !body.dateFrom;

  let data;
  try {
    data = await fetchTikTokCreativeData(dateFrom, dateTo, lifetime);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }

  const byType: Record<string, number> = {};
  const byAccount: Record<string, { rows: number; spend: number }> = {};
  let totalSpend = 0;
  const adRows = data.rows.map(r => {
    byType[r.objectType] = (byType[r.objectType] ?? 0) + 1;
    const acc = byAccount[r.accountId] ??= { rows: 0, spend: 0 };
    acc.rows += 1; acc.spend += r.spend;
    totalSpend += r.spend;
    return {
      ad_id: r.key,
      ad_name: r.label,
      campaign_id: r.campaignId,
      campaign_name: r.campaignName,
      adset_id: r.adgroupId,
      adset_name: r.adgroupName,
      flow: null,
      account_id: r.accountId,
      platform: "tiktok",
      date: dateTo,
      spend: r.spend,
      impressions: r.impressions,
      clicks: r.clicks,
      reach: r.reach,
      cpm: r.impressions ? (r.spend / r.impressions) * 1000 : 0,
      ctr: r.impressions ? (r.clicks / r.impressions) * 100 : 0,
      cpc: r.clicks ? r.spend / r.clicks : 0,
      video_plays: r.videoPlays,
      video_3s: r.videoWatched2s,
      video_thruplay: r.videoWatched6s,
    };
  });

  const supabase = createServiceClient();

  // Ссылки Storage (если ролики когда-то скачаем локально, как для Google) — переносим.
  const { data: prevCre } = await supabase.from("meta_creatives")
    .select("ad_id, asset_url").eq("platform", "tiktok").like("asset_url", "%/storage/v1/%");
  const storedAsset = new Map((prevCre ?? []).map(r => [r.ad_id as string, r.asset_url as string]));

  const creativeRows = data.rows
    .filter(r => r.thumbnailUrl || r.videoUrl || r.imageUrl)
    .map(r => ({
      ad_id: r.key,
      ad_name: r.label,
      flow: null,
      object_type: r.objectType,
      thumbnail_url: r.thumbnailUrl,
      image_url: r.imageUrl,
      video_id: r.videoId,
      // видео — mp4 из Storage, если скачан; иначе временный preview_url TikTok (протухает — резолвить заново синком)
      asset_url: storedAsset.get(r.key) ?? (r.objectType === "VIDEO" ? (r.videoUrl ?? r.thumbnailUrl) : (r.imageUrl ?? r.thumbnailUrl)),
      platform: "tiktok",
    }));

  let metaErr: string | null = null;
  let creErr: string | null = null;

  await supabase.from("meta_ads").delete().eq("platform", "tiktok");
  if (adRows.length) {
    const { error } = await supabase.from("meta_ads").upsert(adRows, { onConflict: "ad_id,date" });
    metaErr = error?.message ?? null;
  }

  await supabase.from("meta_creatives").delete().eq("platform", "tiktok");
  if (creativeRows.length) {
    const { error } = await supabase.from("meta_creatives").upsert(creativeRows, { onConflict: "ad_id" });
    creErr = error?.message ?? null;
  }

  await supabase.from("meta_sync_log").insert({
    account_id: `tiktok:${TIKTOK_ADVERTISER_IDS.join("+")}`, date_from: dateFrom, date_to: dateTo,
    ads_count: adRows.length, status: metaErr ? "error" : "ok", error: metaErr ?? creErr,
  });

  return NextResponse.json({
    ok: !metaErr && !creErr,
    platform: "tiktok",
    grain: "creative",
    lifetime, dateFrom, dateTo,
    adsInAccount: data.ads,
    reportRows: data.report,
    syncedRows: adRows.length,
    accounts: TIKTOK_ADVERTISER_IDS,
    byAccount: Object.fromEntries(Object.entries(byAccount).map(([k, v]) => [k, { rows: v.rows, spend: Math.round(v.spend) }])),
    byType,
    totalSpend: Math.round(totalSpend),
    creatives: creativeRows.length,
    metaErr, creErr,
    note: "Лиды/квал/выручка TikTok — из Elly: POST /api/tiktok/crm-sync (elly-sync source=tiktok), джойн по имени объявления.",
  });
}

export async function GET() {
  return POST(new NextRequest("http://localhost/api/tiktok/sync", { method: "POST", body: "{}" }));
}
