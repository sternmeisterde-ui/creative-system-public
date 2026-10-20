// ── Срез креативов за произвольное окно дат ──────────────────────────────────
// Вынесен из /api/analytics/weekly, чтобы тот же расчёт использовали недельный срез
// (окно = неделя) и отчёт за период (окно любое: неделя, месяц, свой диапазон).
//
// Источники за окно:
//   Meta   — дневные строки meta_ads (страницами; google/tiktok там — lifetime-снимки, их не берём)
//   Google — Google Ads API по крео за окно (lib/google-creatives) + Elly source=google (PMax раскладка)
//   TikTok — Marketing API отчёт за окно (lib/tiktok) + Elly source=tiktok
//   Лиды   — Plurio/Elly за ИМЕННО ЭТО окно (дневной истории лидов в БД нет)
import type { SupabaseClient } from "@supabase/supabase-js";
import { ensureCreativeAssets } from "@/lib/meta-assets";
import { parseAdNameWithMapping, type AdNameMapping } from "@/lib/naming";
import { syncElly } from "@/app/api/pbi/elly-sync/route";
import { isPlatformConfigured } from "@/lib/platforms";
import { fetchGoogleCreativeData, allocateGoogleLeads, type GoogleCreativeData } from "@/lib/google-creatives";
import { fetchTikTokCreativeData, type TikTokCreativeRow } from "@/lib/tiktok";

export type WindowPlatform = "meta" | "google" | "tiktok" | "all";

// ── Замороженный per-креатив снапшот окна ──
export interface WeeklyCreativeRow {
  adId:        string;
  adName:      string;
  campaignName?: string | null;  // для разводки по продукту (lib/product.ts)
  flow:        string | null;
  format:      string | null;
  // превью из meta_creatives
  thumbnailUrl: string | null;
  assetUrl:     string | null;
  videoId:      string | null;
  objectType:   string | null;
  // метрики за окно
  spend:        number;
  impressions:  number;
  cpm:          number | null;
  clicks:       number;
  cpc:          number | null;
  ctr:          number | null;
  crClickLead:  number | null;
  leads:        number;
  cpl:          number | null;
  qualLeads:    number;
  cpql:         number | null;
  hookRate:     number | null;
  holdRate:     number | null;
  // видео-сырьё (для бивариата по хукам за окно)
  videoPlays?:    number;
  videoThruplay?: number;
  status:       "winner" | "loser" | "testing";
}

export interface WindowResult {
  rows: WeeklyCreativeRow[];
  mapping: AdNameMapping[];
  thresholds: { cplTarget: number; cpqlTarget: number; minImpr: number };
}

export class WindowError extends Error {
  status: number;
  constructor(message: string, status = 500) { super(message); this.status = status; }
}

const key = (s: string) => s.trim().toLowerCase();
const div = (a: number, b: number): number | null => (b > 0 ? a / b : null);

export async function collectWindowRows(
  supabase: SupabaseClient,
  platform: WindowPlatform,
  from: string,
  to: string,
): Promise<WindowResult> {
  type MetaRow = { ad_id: string; ad_name: string; campaign_name: string | null; flow: string | null; spend: number | null; impressions: number | null; clicks: number | null; video_plays: number | null; video_3s: number | null; video_thruplay: number | null };
  const metaRows: MetaRow[] = [];
  for (let off = 0; platform === "meta" || platform === "all"; off += 1000) {
    const { data, error } = await supabase.from("meta_ads")
      .select("ad_id, ad_name, campaign_name, flow, spend, impressions, clicks, video_plays, video_3s, video_thruplay")
      .gte("date", from).lte("date", to)
      .not("platform", "in", "(google,tiktok)") // google/tiktok в meta_ads — lifetime-снимки, не дневные
      .order("id").range(off, off + 999);
    if (error) throw new WindowError(error.message, 500);
    metaRows.push(...((data ?? []) as MetaRow[]));
    if (!data || data.length < 1000) break;
  }

  const [settingsRes, mappingRes] = await Promise.all([
    supabase.from("app_settings").select("cpl_target, cpql_target, min_impressions_for_status").eq("id", 1).maybeSingle(),
    supabase.from("ad_name_mapping").select("ad_name, persona_code, hook_code, body_code, angle_code, format, flow, concept_code, actor_code"),
  ]);

  // Google за окно — напрямую из API по крео (опционально)
  let google: GoogleCreativeData | null = null;
  if ((platform === "google" || platform === "all") && isPlatformConfigured("google")) {
    try { google = await fetchGoogleCreativeData(from, to); } catch { google = null; }
  }
  // TikTok за окно — отчёт Marketing API (не lifetime)
  let tiktok: TikTokCreativeRow[] = [];
  const wantTikTok = (platform === "tiktok" || platform === "all") && isPlatformConfigured("tiktok");
  if (wantTikTok) {
    try { tiktok = (await fetchTikTokCreativeData(from, to, false)).rows; } catch { tiktok = []; }
  }

  // ── Лиды/квал за ИМЕННО ЭТО ОКНО — из Plurio. Meta обязателен; Google/TikTok опциональны.
  let ellyRows: Awaited<ReturnType<typeof syncElly>>;
  let googleLeads: ReturnType<typeof allocateGoogleLeads>["rows"] = [];
  try {
    const none = Promise.resolve([] as Awaited<ReturnType<typeof syncElly>>);
    const [meta, ellyGoogle, ellyTikTok] = await Promise.all([
      platform === "meta" || platform === "all" ? syncElly(from, to, "meta") : none,
      google ? syncElly(from, to, "google").catch(() => []) : none,
      wantTikTok ? syncElly(from, to, "tiktok").catch(() => []) : none,
    ]);
    ellyRows = [...meta, ...ellyTikTok];
    if (google && ellyGoogle.length) {
      googleLeads = allocateGoogleLeads(ellyGoogle.map(r => ({
        adId: /^\d+$/.test(r.adId) ? r.adId : "", adName: (r.campaign || r.adName).trim(),
        leads: r.leads, qualLeads: r.qualLeads, spend: r.spend, revenue: r.revenue,
      })), google).rows;
    }
  } catch (e) {
    throw new WindowError(`Elly: ${e instanceof Error ? e.message : String(e)}`, 502);
  }

  const cplTarget  = Number(settingsRes.data?.cpl_target ?? 20);
  const cpqlTarget = Number(settingsRes.data?.cpql_target ?? 28);
  const minImpr    = Number(settingsRes.data?.min_impressions_for_status ?? 8000);

  const mapping: AdNameMapping[] = (mappingRes.data ?? []).map(r => ({
    adName: r.ad_name, personaCode: r.persona_code, hookCode: r.hook_code,
    bodyCode: r.body_code, angleCode: r.angle_code, format: r.format, flow: r.flow, conceptCode: r.concept_code ?? null, actorCode: r.actor_code ?? null,
  }));

  // ── агрегируем по имени объявления (грань view = ad_name) ──
  type MetaAgg = {
    adId: string; adName: string; campaignName: string | null; flow: string | null; topSpend: number;
    spend: number; impressions: number; clicks: number; videoPlays: number; video3s: number; videoThruplay: number;
  };
  const meta: Record<string, MetaAgg> = {};
  const windowAdIds = new Set<string>();
  for (const r of metaRows) {
    const k = key(r.ad_name);
    const spend = Number(r.spend ?? 0);
    if (r.ad_id) windowAdIds.add(r.ad_id);
    const cur = meta[k] ??= {
      adId: r.ad_id, adName: r.ad_name, campaignName: r.campaign_name ?? null, flow: r.flow ?? null,
      topSpend: -1, spend: 0, impressions: 0, clicks: 0, videoPlays: 0, video3s: 0, videoThruplay: 0,
    };
    cur.spend += spend;
    cur.impressions += Number(r.impressions ?? 0);
    cur.clicks += Number(r.clicks ?? 0);
    cur.videoPlays += Number(r.video_plays ?? 0);
    cur.video3s += Number(r.video_3s ?? 0);
    cur.videoThruplay += Number(r.video_thruplay ?? 0);
    if (spend > cur.topSpend) { cur.topSpend = spend; cur.adId = r.ad_id; cur.adName = r.ad_name; cur.campaignName = r.campaign_name ?? null; cur.flow = r.flow ?? null; }
  }
  for (const g of google?.rows ?? []) {
    if (g.spend <= 0 && g.impressions <= 0) continue;
    windowAdIds.add(g.key);
    meta[key(g.label)] = {
      adId: g.key, adName: g.label, campaignName: [...g.slices].sort((a, b) => b.spend - a.spend)[0]?.campaignName ?? null, flow: g.flow, topSpend: g.spend,
      spend: g.spend, impressions: g.impressions, clicks: g.clicks, videoPlays: 0, video3s: 0, videoThruplay: 0,
    };
  }
  for (const t of tiktok) {
    if (t.spend <= 0 && t.impressions <= 0) continue;
    windowAdIds.add(t.key);
    meta[key(t.label)] = {
      adId: t.key, adName: t.label, campaignName: t.campaignName, flow: null, topSpend: t.spend,
      spend: t.spend, impressions: t.impressions, clicks: t.clicks, videoPlays: t.videoPlays, video3s: t.videoWatched2s, videoThruplay: t.videoWatched6s,
    };
  }

  // ── лиды по имени ──
  const pbi: Record<string, { leads: number; qualLeads: number }> = {};
  for (const r of ellyRows) {
    if (!r.adName) continue;
    const cur = pbi[key(r.adName)] ??= { leads: 0, qualLeads: 0 };
    cur.leads += Number(r.leads ?? 0);
    cur.qualLeads += Number(r.qualLeads ?? 0);
  }
  for (const g of googleLeads) {
    const cur = pbi[key(g.label)] ??= { leads: 0, qualLeads: 0 };
    cur.leads += Math.round(g.leads);
    cur.qualLeads += Math.round(g.qualLeads);
  }

  // ── ассеты только по нужным ad_id/именам; недостающие в meta_creatives догружаем из Graph прямо сейчас ──
  if (platform === "meta") await ensureCreativeAssets(supabase, [...windowAdIds]).catch(() => undefined);
  const names = Object.values(meta).map(m => m.adName);
  const [byIdRes, byNameRes] = await Promise.all([
    supabase.from("meta_creatives").select("ad_id, ad_name, thumbnail_url, image_url, asset_url, video_id, object_type").in("ad_id", [...windowAdIds]),
    supabase.from("meta_creatives").select("ad_id, ad_name, thumbnail_url, image_url, asset_url, video_id, object_type").in("ad_name", names),
  ]);
  type Creative = NonNullable<typeof byIdRes.data>[number];
  const assetByAdId: Record<string, Creative> = {};
  const assetByName: Record<string, Creative> = {};
  for (const c of [...(byIdRes.data ?? []), ...(byNameRes.data ?? [])]) {
    if (c.ad_id) assetByAdId[c.ad_id] = c;
    if (c.ad_name) assetByName[key(c.ad_name)] ??= c;
  }

  const rows: WeeklyCreativeRow[] = Object.entries(meta).map(([k, m]) => {
    const p = pbi[k] ?? { leads: 0, qualLeads: 0 };
    const asset = assetByAdId[m.adId] ?? assetByName[k] ?? null;
    const parts = parseAdNameWithMapping(m.adName, mapping);
    const cpl  = div(m.spend, p.leads);
    const cpql = div(m.spend, p.qualLeads);
    // hook = 3-сек просмотры (Meta action video_view; TikTok video_watched_2s) / показы, hold = thruplay / 3-сек.
    // НЕ плеи: video_play_actions = автоплей ≈ показы, давало 93–97 % у любого видео (баг недели до 14.10.2026).
    const hookRate = m.video3s > 0 && m.impressions > 0 ? (m.video3s / m.impressions) * 100 : null;
    const holdRate = m.video3s > 0 ? (m.videoThruplay / m.video3s) * 100 : null;

    let status: WeeklyCreativeRow["status"] = "testing";
    if (m.impressions >= minImpr) {
      if (p.leads > 0 && cpl != null && cpl <= cplTarget && p.qualLeads > 0 && cpql != null && cpql <= cpqlTarget) status = "winner";
      else if ((p.leads > 0 && cpl != null && cpl > cplTarget) || (p.qualLeads > 0 && cpql != null && cpql > cpqlTarget)) status = "loser";
    }

    return {
      adId: m.adId, adName: m.adName, campaignName: m.campaignName, flow: m.flow, format: parts.format,
      thumbnailUrl: asset?.thumbnail_url ?? null,
      assetUrl:     asset?.asset_url ?? asset?.image_url ?? asset?.thumbnail_url ?? null,
      videoId:      asset?.video_id ?? null,
      objectType:   asset?.object_type ?? null,
      spend: m.spend, impressions: m.impressions,
      cpm: m.impressions > 0 ? (m.spend / m.impressions) * 1000 : null,
      clicks: m.clicks,
      cpc: div(m.spend, m.clicks),
      ctr: m.impressions > 0 ? (m.clicks / m.impressions) * 100 : null,
      crClickLead: m.clicks > 0 ? (p.leads / m.clicks) * 100 : null,
      leads: p.leads, cpl,
      qualLeads: p.qualLeads, cpql,
      hookRate, holdRate,
      videoPlays: m.videoPlays, videoThruplay: m.videoThruplay,
      status,
    };
  }).sort((a, b) => b.spend - a.spend);

  return { rows, mapping, thresholds: { cplTarget, cpqlTarget, minImpr } };
}
