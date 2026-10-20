// ── TikTok Marketing API — данные по КРЕАТИВАМ ────────────────────────────────
// Зеркало lib/google-creatives.ts для TikTok Business API v1.3.
//  • отчёт ad-level (Reporting API, report/integrated/get) — спенд/показы/клики/видео-метрики,
//    lifetime (query_lifetime) или за окно дат;
//  • справочник объявлений (ad/get) — имена объявления/группы/кампании, video_id / image_ids;
//  • медиа (file/video/ad/info, file/image/ad/info) — превью и временные ссылки на mp4.
// Ключи в meta_ads / meta_creatives: `tiktok:ad:<ad_id>`, platform='tiktok'.
// Активируется по TIKTOK_ACCESS_TOKEN + TIKTOK_ADVERTISER_ID (lib/platforms.ts).
// Кабинетов может быть несколько: TIKTOK_ADVERTISER_ID = "id1,id2" (один токен, авторизованный
// на оба) — все функции обходят каждый кабинет, ad_id уникальны в рамках TikTok, поэтому
// строки просто складываются; у каждой строки свой accountId.

const BASE = (process.env.TIKTOK_API_URL || "https://business-api.tiktok.com/open_api/v1.3").replace(/\/$/, "");
export const TIKTOK_ADVERTISER_IDS: string[] = (process.env.TIKTOK_ADVERTISER_ID ?? "")
  .split(/[,;\s]+/).map(s => s.trim()).filter(Boolean);
/** Первый кабинет — для совместимости; в записях используем accountId строки. */
export const TIKTOK_ADVERTISER_ID = TIKTOK_ADVERTISER_IDS[0] ?? "";
const TOKEN = process.env.TIKTOK_ACCESS_TOKEN ?? "";

interface TtEnvelope<T> { code?: number; message?: string; request_id?: string; data?: T }
interface TtPage<T> { list?: T[]; page_info?: { page?: number; page_size?: number; total_number?: number; total_page?: number } }

async function ttGet<T>(path: string, params: Record<string, string>): Promise<T> {
  const url = new URL(`${BASE}/${path.replace(/^\//, "")}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url.toString(), { headers: { "Access-Token": TOKEN }, cache: "no-store" });
  const json = await res.json().catch(() => ({})) as TtEnvelope<T>;
  if (!res.ok || (json.code !== undefined && json.code !== 0)) {
    throw new Error(`TikTok API ${path}: ${json.message ?? res.statusText} (code ${json.code ?? res.status}, request ${json.request_id ?? "—"})`);
  }
  return json.data as T;
}

/** Постраничный обход list-эндпоинтов (page/page_size). */
async function ttPaged<T>(path: string, params: Record<string, string>, pageSize = 100, maxPages = 200): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const data = await ttGet<TtPage<T>>(path, { ...params, page: String(page), page_size: String(pageSize) });
    out.push(...(data.list ?? []));
    const total = data.page_info?.total_page ?? 1;
    if (page >= total || !(data.list?.length)) break;
  }
  return out;
}

// ── Reporting ────────────────────────────────────────────────────────────────
export interface TikTokReportRow {
  accountId: string;      // advertiser_id кабинета
  adId: string;
  adName: string;
  adgroupId: string;
  adgroupName: string;
  campaignId: string;
  campaignName: string;
  spend: number;
  impressions: number;
  clicks: number;
  reach: number;
  videoPlays: number;     // video_play_actions — старты видео
  videoWatched2s: number; // video_watched_2s
  videoWatched6s: number; // video_watched_6s — прокси удержания (аналог thruplay)
  videoP100: number;      // video_views_p100 — досмотры
  conversions: number;    // conversion (по пикселю/событиям TikTok — справочно, лиды берём из CRM)
}

interface RawReportRow { dimensions?: { ad_id?: string | number }; metrics?: Record<string, string | number | null> }

const num = (v: unknown) => { const n = Number(v ?? 0); return Number.isFinite(n) ? n : 0; };

/**
 * Ad-level отчёт. lifetime=true → весь срок жизни (даты игнорируются), иначе — окно [dateFrom, dateTo].
 * Имена объявления/группы/кампании TikTok отдаёт как «атрибутные метрики» прямо в отчёте.
 */
export async function fetchTikTokReport(dateFrom: string, dateTo: string, lifetime = false): Promise<TikTokReportRow[]> {
  if (!TOKEN || !TIKTOK_ADVERTISER_IDS.length) throw new Error("TikTok не настроен: TIKTOK_ACCESS_TOKEN / TIKTOK_ADVERTISER_ID");
  const out: TikTokReportRow[] = [];
  for (const accountId of TIKTOK_ADVERTISER_IDS) out.push(...await fetchTikTokReportFor(accountId, dateFrom, dateTo, lifetime));
  return out;
}

async function fetchTikTokReportFor(accountId: string, dateFrom: string, dateTo: string, lifetime: boolean): Promise<TikTokReportRow[]> {
  const metrics = [
    "spend", "impressions", "clicks", "reach",
    "video_play_actions", "video_watched_2s", "video_watched_6s", "video_views_p100", "conversion",
    "ad_name", "adgroup_id", "adgroup_name", "campaign_id", "campaign_name",
  ];
  const params: Record<string, string> = {
    advertiser_id: accountId,
    report_type: "BASIC",
    data_level: "AUCTION_AD",
    dimensions: JSON.stringify(["ad_id"]),
    metrics: JSON.stringify(metrics),
    // spend > 0 или показы > 0 — пустые объявления не тянем
    filtering: JSON.stringify([{ field_name: "ad_status", filter_type: "IN", filter_value: JSON.stringify(["STATUS_ALL"]) }]),
  };
  if (lifetime) params.query_lifetime = "true";
  else { params.start_date = dateFrom; params.end_date = dateTo; }

  const raw = await ttPaged<RawReportRow>("report/integrated/get/", params, 1000, 50);
  return raw
    .map(r => {
      const m = r.metrics ?? {};
      return {
        accountId,
        adId: String(r.dimensions?.ad_id ?? ""),
        adName: String(m.ad_name ?? "").trim(),
        adgroupId: String(m.adgroup_id ?? ""),
        adgroupName: String(m.adgroup_name ?? ""),
        campaignId: String(m.campaign_id ?? ""),
        campaignName: String(m.campaign_name ?? ""),
        spend: num(m.spend), impressions: num(m.impressions), clicks: num(m.clicks), reach: num(m.reach),
        videoPlays: num(m.video_play_actions), videoWatched2s: num(m.video_watched_2s),
        videoWatched6s: num(m.video_watched_6s), videoP100: num(m.video_views_p100), conversions: num(m.conversion),
      };
    })
    .filter(r => r.adId && (r.spend > 0 || r.impressions > 0));
}

// ── Объявления и медиа ───────────────────────────────────────────────────────
export interface TikTokAd {
  accountId: string;
  adId: string;
  adName: string;
  adgroupId: string;
  campaignId: string;
  adFormat: string;       // SINGLE_VIDEO | SINGLE_IMAGE | CAROUSEL_ADS | …
  videoId: string | null;
  imageIds: string[];
  adText: string;
  landingPageUrl: string | null;
  status: string;         // operation_status: ENABLE | DISABLE …
  createTime: string | null;
}

interface RawAd {
  ad_id?: string | number; ad_name?: string; adgroup_id?: string | number; campaign_id?: string | number;
  ad_format?: string; video_id?: string | null; image_ids?: string[] | null; ad_text?: string;
  landing_page_url?: string | null; operation_status?: string; create_time?: string;
}

export async function fetchTikTokAds(): Promise<TikTokAd[]> {
  const out: TikTokAd[] = [];
  for (const accountId of TIKTOK_ADVERTISER_IDS) out.push(...await fetchTikTokAdsFor(accountId));
  return out;
}

async function fetchTikTokAdsFor(accountId: string): Promise<TikTokAd[]> {
  const raw = await ttPaged<RawAd>("ad/get/", {
    advertiser_id: accountId,
    fields: JSON.stringify(["ad_id", "ad_name", "adgroup_id", "campaign_id", "ad_format", "video_id", "image_ids", "ad_text", "landing_page_url", "operation_status", "create_time"]),
  });
  return raw.map(a => ({
    accountId,
    adId: String(a.ad_id ?? ""), adName: String(a.ad_name ?? "").trim(),
    adgroupId: String(a.adgroup_id ?? ""), campaignId: String(a.campaign_id ?? ""),
    adFormat: a.ad_format ?? "", videoId: a.video_id ? String(a.video_id) : null,
    imageIds: (a.image_ids ?? []).map(String), adText: a.ad_text ?? "",
    landingPageUrl: a.landing_page_url ?? null, status: a.operation_status ?? "", createTime: a.create_time ?? null,
  })).filter(a => a.adId);
}

export interface TikTokVideoInfo { videoId: string; previewUrl: string | null; coverUrl: string | null; duration: number | null; width: number | null; height: number | null }
export interface TikTokImageInfo { imageId: string; imageUrl: string | null; width: number | null; height: number | null }

interface RawVideo { video_id?: string; preview_url?: string; video_cover_url?: string; duration?: number; width?: number; height?: number }
interface RawImage { image_id?: string; image_url?: string; width?: number; height?: number }

/**
 * Медиа-инфо по видео (батчами до 60 id). preview_url — временная ссылка на mp4, не хранить надолго.
 * accountId — кабинет, которому принадлежит видео; без него спрашиваем все кабинеты по очереди.
 */
export async function fetchTikTokVideos(videoIds: string[], accountId?: string): Promise<Map<string, TikTokVideoInfo>> {
  const out = new Map<string, TikTokVideoInfo>();
  const ids = [...new Set(videoIds.filter(Boolean))];
  const accounts = accountId ? [accountId] : TIKTOK_ADVERTISER_IDS;
  for (const acc of accounts) for (let i = 0; i < ids.length; i += 60) {
    const chunk = ids.slice(i, i + 60).filter(id => !out.has(id));
    if (!chunk.length) continue;
    const data = await ttGet<{ list?: RawVideo[] }>("file/video/ad/info/", {
      advertiser_id: acc, video_ids: JSON.stringify(chunk),
    }).catch(() => ({ list: [] as RawVideo[] }));
    for (const v of data.list ?? []) {
      if (!v.video_id) continue;
      out.set(String(v.video_id), {
        videoId: String(v.video_id), previewUrl: v.preview_url ?? null, coverUrl: v.video_cover_url ?? null,
        duration: v.duration ?? null, width: v.width ?? null, height: v.height ?? null,
      });
    }
  }
  return out;
}

export async function fetchTikTokImages(imageIds: string[], accountId?: string): Promise<Map<string, TikTokImageInfo>> {
  const out = new Map<string, TikTokImageInfo>();
  const ids = [...new Set(imageIds.filter(Boolean))];
  const accounts = accountId ? [accountId] : TIKTOK_ADVERTISER_IDS;
  for (const acc of accounts) for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100).filter(id => !out.has(id));
    if (!chunk.length) continue;
    const data = await ttGet<{ list?: RawImage[] }>("file/image/ad/info/", {
      advertiser_id: acc, image_ids: JSON.stringify(chunk),
    }).catch(() => ({ list: [] as RawImage[] }));
    for (const im of data.list ?? []) {
      if (!im.image_id) continue;
      out.set(String(im.image_id), { imageId: String(im.image_id), imageUrl: im.image_url ?? null, width: im.width ?? null, height: im.height ?? null });
    }
  }
  return out;
}

// ── Сборка «крео-грейна» ─────────────────────────────────────────────────────
export interface TikTokCreativeRow {
  key: string;            // tiktok:ad:<ad_id>
  accountId: string;      // кабинет (advertiser_id)
  adId: string;
  label: string;          // имя объявления (ключ джойна с лидами Elly по AdName и с маппингом кодов)
  campaignId: string | null;
  campaignName: string | null;
  adgroupId: string | null;
  adgroupName: string | null;
  objectType: "VIDEO" | "IMAGE" | "OTHER";
  videoId: string | null;
  thumbnailUrl: string | null;
  imageUrl: string | null;
  videoUrl: string | null;   // временный preview_url mp4
  adText: string;
  status: string;
  spend: number; impressions: number; clicks: number; reach: number;
  videoPlays: number; videoWatched2s: number; videoWatched6s: number; videoP100: number; conversions: number;
}

export const tiktokKey = (adId: string) => `tiktok:ad:${adId}`;

/**
 * Отчёт + справочник + медиа → одна строка на объявление. Имя объявления, если его нет в отчёте,
 * берём из справочника; если объявление удалено и справочник его не знает — оставляем id.
 */
export async function fetchTikTokCreativeData(dateFrom: string, dateTo: string, lifetime = false): Promise<{ rows: TikTokCreativeRow[]; ads: number; report: number }> {
  const [report, ads] = await Promise.all([fetchTikTokReport(dateFrom, dateTo, lifetime), fetchTikTokAds()]);
  const adById = new Map(ads.map(a => [a.adId, a]));

  // медиа спрашиваем у кабинета-владельца объявления
  const videos = new Map<string, TikTokVideoInfo>();
  const images = new Map<string, TikTokImageInfo>();
  for (const accountId of TIKTOK_ADVERTISER_IDS) {
    const own = report.filter(r => r.accountId === accountId);
    const videoIds = own.map(r => adById.get(r.adId)?.videoId).filter((v): v is string => !!v);
    const imageIds = own.flatMap(r => adById.get(r.adId)?.imageIds ?? []);
    const [v, im] = await Promise.all([fetchTikTokVideos(videoIds, accountId), fetchTikTokImages(imageIds, accountId)]);
    v.forEach((val, k) => videos.set(k, val)); im.forEach((val, k) => images.set(k, val));
  }

  const rows: TikTokCreativeRow[] = report.map(r => {
    const ad = adById.get(r.adId);
    const video = ad?.videoId ? videos.get(ad.videoId) : undefined;
    const image = ad?.imageIds?.length ? images.get(ad.imageIds[0]) : undefined;
    const objectType: TikTokCreativeRow["objectType"] = ad?.videoId ? "VIDEO" : ad?.imageIds?.length ? "IMAGE" : "OTHER";
    const label = (r.adName || ad?.adName || `tiktok ad ${r.adId}`).trim();
    return {
      key: tiktokKey(r.adId), accountId: r.accountId, adId: r.adId, label,
      campaignId: r.campaignId || ad?.campaignId || null, campaignName: r.campaignName || null,
      adgroupId: r.adgroupId || ad?.adgroupId || null, adgroupName: r.adgroupName || null,
      objectType, videoId: ad?.videoId ?? null,
      thumbnailUrl: video?.coverUrl ?? image?.imageUrl ?? null,
      imageUrl: image?.imageUrl ?? null,
      videoUrl: video?.previewUrl ?? null,
      adText: ad?.adText ?? "", status: ad?.status ?? "",
      spend: r.spend, impressions: r.impressions, clicks: r.clicks, reach: r.reach,
      videoPlays: r.videoPlays, videoWatched2s: r.videoWatched2s, videoWatched6s: r.videoWatched6s, videoP100: r.videoP100, conversions: r.conversions,
    };
  });
  return { rows, ads: ads.length, report: report.length };
}
