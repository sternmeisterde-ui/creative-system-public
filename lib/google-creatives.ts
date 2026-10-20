// Google Ads на уровне КРЕАТИВА (а не кампании).
//
// Раньше синк тянул только campaign-grain: считалось, что PMax не отдаёт метрики по
// ассетам. В API v25 отдаёт: `asset_group_asset` с metrics.{cost,impressions,clicks,
// conversions} по каждому IMAGE / YOUTUBE_VIDEO ассету. Search / Demand Gen / Video
// объявления живут в `ad_group_ad`. Отсюда три вида строк:
//
//   google:asset:<assetId>   — картинка/видео PMax (сумма по всем кампаниям, где крутится)
//   google:ad:<adId>         — объявление Search / Demand Gen / YouTube
//   google:rest:<campaignId> — остаток спенда кампании, не привязанный к визуальному крео
//                              (текстовые форматы PMax, фиды и т.п.); нужен, чтобы итог по
//                              Google совпадал с реальным спендом аккаунта
//
// Префикс `google:` сохранён у всех — вид creative_performance фильтрует pbi по нему
// (миграция 023), новых миграций не нужно. Имя строки (ad_name) начинается с id ассета /
// объявления («asset 313931652130 · video interview ivan») — так крео сверяется с кабинетом
// Google, а имя уникально без хвостов. Оно же ключ маппинга P·H·B·A и джойна лидов из Elly.
import { googleAdsSearch } from "@/lib/google-ads";

export type Flow = "com" | "gov" | null;

export interface CampaignSlice {
  campaignId: string;
  campaignName: string;
  spend: number;
  impressions: number;
  clicks: number;
  conversions: number;   // конверсии по Google (у Lead_CRM-кампаний это импорт из CRM)
}

export interface CreativeRow {
  key: string;             // google:asset:<id> | google:ad:<id> | google:rest:<campaignId>
  kind: "asset" | "ad" | "rest";
  label: string;           // ad_name
  flow: Flow;
  objectType: "IMAGE" | "VIDEO" | "TEXT";
  channelType: string;     // PERFORMANCE_MAX | SEARCH | DEMAND_GEN | VIDEO …
  thumbnailUrl: string | null;
  imageUrl: string | null;
  videoId: string | null;  // YouTube id
  spend: number;
  impressions: number;
  clicks: number;
  conversions: number;
  slices: CampaignSlice[]; // разбивка по кампаниям — нужна для раскладки CRM-лидов
}

export interface CampaignRow {
  id: string;
  name: string;
  channelType: string;
  spend: number;
  impressions: number;
  clicks: number;
  conversions: number;
}

export interface GoogleCreativeData {
  campaigns: CampaignRow[];
  rows: CreativeRow[];
}

export function flowFromCampaign(name: string): Flow {
  const n = name.toLowerCase();
  if (n.includes("gov")) return "gov";
  if (n.includes("comm")) return "com";
  return null;
}

const num = (v: unknown) => Number(v ?? 0) || 0;
const micros = (v: unknown) => num(v) / 1e6;

function stripExt(s: string) { return s.replace(/\.(png|jpe?g|webp|gif|mp4|mov)$/i, ""); }

// Метка по ассету: имя файла без расширения / заголовок YouTube / тип+id.
function assetLabel(a: { id?: string; name?: string; type?: string; youtubeVideoAsset?: { youtubeVideoTitle?: string } }, fieldType?: string): string {
  const name = (a.name ?? "").trim();
  if (name) return stripExt(name);
  const yt = (a.youtubeVideoAsset?.youtubeVideoTitle ?? "").trim();
  if (yt) return yt;
  return `${(fieldType ?? a.type ?? "ASSET").toLowerCase()} ${a.id ?? ""}`.trim();
}

function addSlice(r: CreativeRow, s: CampaignSlice) {
  r.slices.push(s);
  r.spend += s.spend; r.impressions += s.impressions; r.clicks += s.clicks; r.conversions += s.conversions;
}

// Поток крео — по кампании с наибольшим спендом.
function dominantFlow(r: CreativeRow): Flow {
  const bySpend: Record<string, number> = {};
  for (const s of r.slices) {
    const f = flowFromCampaign(s.campaignName) ?? "—";
    bySpend[f] = (bySpend[f] ?? 0) + s.spend;
  }
  const top = Object.entries(bySpend).sort((a, b) => b[1] - a[1])[0]?.[0];
  return top === "com" || top === "gov" ? top : null;
}

export async function fetchGoogleCreativeData(dateFrom: string, dateTo: string): Promise<GoogleCreativeData> {
  const W = `segments.date BETWEEN '${dateFrom}' AND '${dateTo}'`;

  // 1. Кампании — итог по окну (для остатка и контроля суммы).
  type CampRes = { campaign?: { id?: string; name?: string; advertisingChannelType?: string }; metrics?: Record<string, unknown> };
  const campRes = await googleAdsSearch(`
    SELECT campaign.id, campaign.name, campaign.advertising_channel_type,
           metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions
    FROM campaign WHERE ${W} AND metrics.impressions > 0`) as CampRes[];
  const campaigns: CampaignRow[] = campRes
    .filter(r => r.campaign?.id)
    .map(r => ({
      id: String(r.campaign!.id), name: r.campaign!.name ?? "", channelType: r.campaign!.advertisingChannelType ?? "UNKNOWN",
      spend: micros(r.metrics?.costMicros), impressions: num(r.metrics?.impressions), clicks: num(r.metrics?.clicks), conversions: num(r.metrics?.conversions),
    }));
  const campById = new Map(campaigns.map(c => [c.id, c]));

  const rows = new Map<string, CreativeRow>();

  // 2. PMax: визуальные ассеты с метриками (по кампаниям).
  type AgaRes = {
    campaign?: { id?: string; name?: string };
    assetGroupAsset?: { fieldType?: string };
    asset?: { id?: string; name?: string; type?: string; imageAsset?: { fullSize?: { url?: string } }; youtubeVideoAsset?: { youtubeVideoId?: string; youtubeVideoTitle?: string } };
    metrics?: Record<string, unknown>;
  };
  const aga = await googleAdsSearch(`
    SELECT campaign.id, campaign.name, asset_group_asset.field_type,
           asset.id, asset.name, asset.type,
           asset.image_asset.full_size.url,
           asset.youtube_video_asset.youtube_video_id, asset.youtube_video_asset.youtube_video_title,
           metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions
    FROM asset_group_asset
    WHERE ${W} AND asset.type IN ('IMAGE', 'YOUTUBE_VIDEO') AND metrics.impressions > 0`) as AgaRes[];
  for (const r of aga) {
    const a = r.asset ?? {}; const id = String(a.id ?? ""); const campId = String(r.campaign?.id ?? "");
    if (!id || !campId) continue;
    const key = `google:asset:${id}`;
    const isVideo = a.type === "YOUTUBE_VIDEO";
    const ytId = a.youtubeVideoAsset?.youtubeVideoId ?? null;
    const imgUrl = a.imageAsset?.fullSize?.url ?? null;
    let row = rows.get(key);
    if (!row) {
      row = {
        key, kind: "asset", label: `asset ${id} · ${assetLabel(a, r.assetGroupAsset?.fieldType)}`, flow: null,
        objectType: isVideo ? "VIDEO" : "IMAGE", channelType: campById.get(campId)?.channelType ?? "PERFORMANCE_MAX",
        thumbnailUrl: isVideo ? (ytId ? `https://img.youtube.com/vi/${ytId}/hqdefault.jpg` : null) : imgUrl,
        imageUrl: isVideo ? null : imgUrl, videoId: isVideo ? ytId : null,
        spend: 0, impressions: 0, clicks: 0, conversions: 0, slices: [],
      };
      rows.set(key, row);
    }
    addSlice(row, {
      campaignId: campId, campaignName: r.campaign?.name ?? "",
      spend: micros(r.metrics?.costMicros), impressions: num(r.metrics?.impressions), clicks: num(r.metrics?.clicks), conversions: num(r.metrics?.conversions),
    });
  }

  // 3. Search / Demand Gen / Video: объявления.
  type AdRes = {
    campaign?: { id?: string; name?: string; advertisingChannelType?: string };
    adGroup?: { id?: string; name?: string };
    adGroupAd?: { ad?: { id?: string; name?: string; type?: string } };
    metrics?: Record<string, unknown>;
  };
  const ads = await googleAdsSearch(`
    SELECT campaign.id, campaign.name, campaign.advertising_channel_type,
           ad_group.id, ad_group.name,
           ad_group_ad.ad.id, ad_group_ad.ad.name, ad_group_ad.ad.type,
           metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions
    FROM ad_group_ad WHERE ${W} AND metrics.impressions > 0`) as AdRes[];
  for (const r of ads) {
    const ad = r.adGroupAd?.ad ?? {}; const id = String(ad.id ?? ""); const campId = String(r.campaign?.id ?? "");
    if (!id || !campId) continue;
    const key = `google:ad:${id}`;
    const type = (ad.type ?? "").toUpperCase();
    const isVideo = type.includes("VIDEO");
    const isText = type.includes("SEARCH") || type.includes("TEXT");
    const adName = (ad.name ?? "").trim();
    const label = `ad ${id} · ${r.campaign?.name ?? campId} › ${r.adGroup?.name ?? ""}${adName ? ` › ${adName}` : ""}`.trim();
    let row = rows.get(key);
    if (!row) {
      row = {
        key, kind: "ad", label, flow: null,
        objectType: isVideo ? "VIDEO" : isText ? "TEXT" : "IMAGE",
        channelType: r.campaign?.advertisingChannelType ?? "UNKNOWN",
        thumbnailUrl: null, imageUrl: null, videoId: null,
        spend: 0, impressions: 0, clicks: 0, conversions: 0, slices: [],
      };
      rows.set(key, row);
    }
    addSlice(row, {
      campaignId: campId, campaignName: r.campaign?.name ?? "",
      spend: micros(r.metrics?.costMicros), impressions: num(r.metrics?.impressions), clicks: num(r.metrics?.clicks), conversions: num(r.metrics?.conversions),
    });
  }

  // 3b. Превью для объявлений Demand Gen / Video — первый визуальный ассет объявления.
  if (ads.length) {
    type ViewRes = { adGroupAd?: { ad?: { id?: string } }; asset?: { type?: string; imageAsset?: { fullSize?: { url?: string } }; youtubeVideoAsset?: { youtubeVideoId?: string } }; adGroupAdAssetView?: { fieldType?: string } };
    try {
      const views = await googleAdsSearch(`
        SELECT ad_group_ad.ad.id, ad_group_ad_asset_view.field_type, asset.type,
               asset.image_asset.full_size.url, asset.youtube_video_asset.youtube_video_id
        FROM ad_group_ad_asset_view
        WHERE asset.type IN ('IMAGE', 'YOUTUBE_VIDEO')
          AND ad_group_ad_asset_view.field_type NOT IN ('LOGO', 'LANDSCAPE_LOGO')`) as ViewRes[];
      for (const v of views) {
        const row = rows.get(`google:ad:${v.adGroupAd?.ad?.id ?? ""}`);
        if (!row || row.thumbnailUrl) continue;
        const ytId = v.asset?.youtubeVideoAsset?.youtubeVideoId;
        const img = v.asset?.imageAsset?.fullSize?.url;
        if (v.asset?.type === "YOUTUBE_VIDEO" && ytId) {
          row.thumbnailUrl = `https://img.youtube.com/vi/${ytId}/hqdefault.jpg`; row.videoId = ytId; row.objectType = "VIDEO";
        } else if (img) {
          row.thumbnailUrl = img; row.imageUrl = img; if (row.objectType === "TEXT") row.objectType = "IMAGE";
        }
      }
    } catch { /* превью — необязательная часть */ }
  }

  // 4. Остаток по кампаниям: спенд, не покрытый крео/объявлениями (текстовые форматы PMax и т.п.).
  const covered = new Map<string, CampaignSlice>();
  for (const r of rows.values()) for (const s of r.slices) {
    const c = covered.get(s.campaignId) ?? { campaignId: s.campaignId, campaignName: s.campaignName, spend: 0, impressions: 0, clicks: 0, conversions: 0 };
    c.spend += s.spend; c.impressions += s.impressions; c.clicks += s.clicks; c.conversions += s.conversions;
    covered.set(s.campaignId, c);
  }
  for (const c of campaigns) {
    const cv = covered.get(c.id);
    const rest: CampaignSlice = {
      campaignId: c.id, campaignName: c.name,
      spend: Math.max(0, c.spend - (cv?.spend ?? 0)),
      impressions: Math.max(0, c.impressions - (cv?.impressions ?? 0)),
      clicks: Math.max(0, c.clicks - (cv?.clicks ?? 0)),
      conversions: Math.max(0, c.conversions - (cv?.conversions ?? 0)),
    };
    if (rest.spend < 1 && rest.impressions < 100) continue;
    const row: CreativeRow = {
      key: `google:rest:${c.id}`, kind: "rest", label: `${c.name} · без крео (текст/фиды)`, flow: flowFromCampaign(c.name),
      objectType: "TEXT", channelType: c.channelType, thumbnailUrl: null, imageUrl: null, videoId: null,
      spend: 0, impressions: 0, clicks: 0, conversions: 0, slices: [],
    };
    addSlice(row, rest);
    rows.set(row.key, row);
  }

  const list = [...rows.values()];
  for (const r of list) if (r.kind !== "rest") r.flow = dominantFlow(r);
  return { campaigns, rows: list };
}

// ── Раскладка CRM-лидов (Elly) по креативам ──────────────────────────────────
// Elly знает AdId только у Search / Demand Gen / Video (кликовая атрибуция). У PMax
// в клике объявления нет — лиды приходят на уровне кампании. Их раскладываем по
// крео кампании пропорционально конверсиям Google (Lead_CRM-кампании оптимизируются
// на импортированные из CRM конверсии, так что это атрибуция самого Google), при
// нуле конверсий — по кликам, иначе всё на строку остатка. Округление — по наибольшему
// остатку, чтобы сумма по кампании сходилась с Elly до лида.
export interface EllyLike { adId: string; adName: string; leads: number; qualLeads: number; spend: number; revenue: number }
export interface Allocated { key: string; label: string; leads: number; qualLeads: number; spend: number; revenue: number; estimated: boolean }

function splitInt(total: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (!weights.length) return [];
  if (sum <= 0) { const out = weights.map(() => 0); out[0] = total; return out; }
  const raw = weights.map(w => total * w / sum);
  const base = raw.map(Math.floor);
  let left = Math.round(total) - base.reduce((a, b) => a + b, 0);
  const order = raw.map((v, i) => [v - base[i], i] as const).sort((a, b) => b[0] - a[0]);
  for (let k = 0; left > 0 && k < order.length; k++, left--) base[order[k][1]]++;
  return base;
}
function splitFloat(total: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (!weights.length) return [];
  if (sum <= 0) { const out = weights.map(() => 0); out[0] = total; return out; }
  return weights.map(w => total * w / sum);
}

export function allocateGoogleLeads(elly: EllyLike[], data: GoogleCreativeData): { rows: Allocated[]; unmatched: EllyLike[] } {
  const byKey = new Map(data.rows.map(r => [r.key, r]));
  const campByName = new Map(data.campaigns.map(c => [c.name.trim().toLowerCase(), c]));
  const acc = new Map<string, Allocated>();
  const unmatched: EllyLike[] = [];
  const add = (key: string, label: string, v: { leads: number; qualLeads: number; spend: number; revenue: number }, estimated: boolean) => {
    const a = acc.get(key) ?? { key, label, leads: 0, qualLeads: 0, spend: 0, revenue: 0, estimated: false };
    a.leads += v.leads; a.qualLeads += v.qualLeads; a.spend += v.spend; a.revenue += v.revenue; a.estimated = a.estimated || estimated;
    acc.set(key, a);
  };

  for (const e of elly) {
    // 1) прямое попадание в объявление
    const adKey = /^\d+$/.test(e.adId) ? `google:ad:${e.adId}` : "";
    if (adKey && byKey.has(adKey)) { add(adKey, byKey.get(adKey)!.label, e, false); continue; }

    // 2) кампания → раскладка по её крео
    const camp = campByName.get(e.adName.trim().toLowerCase());
    if (!camp) { unmatched.push(e); continue; }
    const parts = data.rows
      .map(r => ({ r, s: r.slices.find(s => s.campaignId === camp.id) }))
      .filter((x): x is { r: CreativeRow; s: CampaignSlice } => !!x.s);
    if (!parts.length) { unmatched.push(e); continue; }
    let weights = parts.map(p => p.s.conversions);
    if (weights.every(w => w <= 0)) weights = parts.map(p => p.s.clicks);
    if (weights.every(w => w <= 0)) weights = parts.map(p => p.r.kind === "rest" ? 1 : 0);
    const leads = splitInt(Math.round(e.leads), weights);
    const ql = splitInt(Math.round(e.qualLeads), weights);
    const sp = splitFloat(e.spend, weights);
    const rv = splitFloat(e.revenue, weights);
    parts.forEach((p, i) => {
      if (!leads[i] && !ql[i] && !rv[i] && !sp[i]) return;
      add(p.r.key, p.r.label, { leads: leads[i], qualLeads: ql[i], spend: sp[i], revenue: rv[i] }, true);
    });
  }
  return { rows: [...acc.values()], unmatched };
}
