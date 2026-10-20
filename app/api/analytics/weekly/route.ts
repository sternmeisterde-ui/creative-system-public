import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";
import { collectWindowRows, WindowError, type WindowPlatform } from "@/lib/window-rows";
import { ensureCreativeAssets } from "@/lib/meta-assets";
import { matchesProduct, isProduct, type Product } from "@/lib/product";

// Сборка недели дёргает Plurio (SSE + poll) за окно — как lifetime elly-sync.
export const maxDuration = 800; // Plurio (LLM-агент) отвечает 3–4 мин; 300 с не хватало (19.10.2026)

// Сбор строк окна — lib/window-rows.ts (общий с отчётом за период). Тип строки — оттуда.
export type { WeeklyCreativeRow } from "@/lib/window-rows";
import type { WeeklyCreativeRow } from "@/lib/window-rows";

export interface WeeklyReport {
  id:          string;
  createdAt:   string;
  weekStart:   string;
  weekEnd:     string;
  label:       string;
  rows:        WeeklyCreativeRow[];
  summary:     string;   // AI-разбор недели (markdown)
  summaryNote: string;   // командный шторм уровня недели
  document:    string;   // итоговый док «Что делаем» (направления → ТЗ)
}

export interface WeeklyReportSummary {
  id:        string;
  createdAt: string;
  weekStart: string;
  weekEnd:   string;
  label:     string;
  adCount:   number;
}


// GET /api/analytics/weekly            → список снапшотов
// GET /api/analytics/weekly?id=UUID    → один снапшот + заметки
type WeeklyRowLike = { adId?: string | null; adName?: string | null; videoId?: string | null; thumbnailUrl?: string | null; assetUrl?: string | null; objectType?: string | null; hookRate?: number | null; holdRate?: number | null; impressions?: number; videoPlays?: number; hookFixed?: boolean } & Record<string, unknown>;
// Снапшоты до 14.10.2026 считали hook = плеи/показы (автоплей, 93–97 %). Пересчитываем по video_3s из meta_ads за окно один раз и помечаем hookFixed.
async function fixHookRates(sb: ReturnType<typeof createServiceClient>, reportId: string, weekStart: string, weekEnd: string, rows: WeeklyRowLike[]): Promise<WeeklyRowLike[]> {
  const need = rows.filter(r => r.adName && !r.hookFixed);
  if (!need.length) return rows;
  const agg: Record<string, { imp: number; v3: number; thru: number }> = {};
  for (let off = 0; ; off += 1000) {
    const { data } = await sb.from("meta_ads").select("ad_name, impressions, video_3s, video_thruplay").gte("date", weekStart).lte("date", weekEnd).not("platform", "in", "(google,tiktok)").order("id").range(off, off + 999);
    for (const r of data ?? []) { const k = String(r.ad_name).trim().toLowerCase(); const a = agg[k] ??= { imp: 0, v3: 0, thru: 0 }; a.imp += Number(r.impressions ?? 0); a.v3 += Number(r.video_3s ?? 0); a.thru += Number(r.video_thruplay ?? 0); }
    if (!data || data.length < 1000) break;
  }
  const out = rows.map(r => {
    if (r.hookFixed) return r;
    const a = agg[String(r.adName).trim().toLowerCase()];
    const hookRate = a && a.v3 > 0 && a.imp > 0 ? (a.v3 / a.imp) * 100 : null;
    const holdRate = a && a.v3 > 0 ? (a.thru / a.v3) * 100 : null;
    return { ...r, hookRate, holdRate, hookFixed: true };
  });
  await sb.from("weekly_creative_reports").update({ rows: out }).eq("id", reportId);
  return out;
}
// Снапшот замораживает превью/videoId на момент сборки. Если ингест ассетов тогда отставал (нет крона до 14.10.2026),
// видео в снапшоте нет навсегда → при чтении добираем из meta_creatives (сначала догрузив недостающие из Graph) и сохраняем обратно.
async function hydrateAssets(sb: ReturnType<typeof createServiceClient>, reportId: string, rows: WeeklyRowLike[]): Promise<WeeklyRowLike[]> {
  const need = rows.filter(r => r.adId && !r.videoId && !(r.assetUrl && r.objectType));
  if (!need.length) return rows;
  const ids = need.map(r => String(r.adId));
  await ensureCreativeAssets(sb, ids).catch(() => undefined);
  const { data } = await sb.from("meta_creatives").select("ad_id, thumbnail_url, image_url, asset_url, video_id, object_type").in("ad_id", ids);
  const byId = new Map((data ?? []).map(c => [String(c.ad_id), c]));
  let changed = 0;
  const out = rows.map(r => {
    const c = r.adId ? byId.get(String(r.adId)) : undefined;
    if (!c || (!c.video_id && !c.asset_url)) return r;
    if (r.videoId === (c.video_id ?? null) && r.assetUrl) return r;
    changed++;
    return { ...r, videoId: c.video_id ?? r.videoId ?? null, objectType: c.object_type ?? r.objectType ?? null, thumbnailUrl: r.thumbnailUrl ?? c.thumbnail_url ?? null, assetUrl: r.assetUrl ?? c.asset_url ?? c.image_url ?? c.thumbnail_url ?? null };
  });
  if (changed) await sb.from("weekly_creative_reports").update({ rows: out }).eq("id", reportId);
  return out;
}

export async function GET(req: NextRequest) {
  const supabase = createServiceClient();
  const id = req.nextUrl.searchParams.get("id");

  if (id) {
    const { data: report, error } = await supabase
      .from("weekly_creative_reports").select("*").eq("id", id).maybeSingle();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (!report) return NextResponse.json({ error: "not found" }, { status: 404 });

    const { data: notes } = await supabase
      .from("weekly_creative_notes").select("ad_id, note, ai_note, todo").eq("report_id", id);
    let rows = await hydrateAssets(supabase, report.id, Array.isArray(report.rows) ? report.rows as WeeklyRowLike[] : []);
    if ((report.platform ?? "meta") === "meta") rows = await fixHookRates(supabase, report.id, report.week_start, report.week_end, rows);

    return NextResponse.json({
      report: {
        id: report.id, createdAt: report.created_at,
        weekStart: report.week_start, weekEnd: report.week_end,
        label: report.label, rows: rows as unknown as WeeklyReport["rows"],
        summary: report.summary ?? "", summaryNote: report.summary_note ?? "",
        document: report.document ?? "",
      } as WeeklyReport,
      notes: notes ?? [],
    });
  }

  const platform = req.nextUrl.searchParams.get("platform") ?? "meta";
  const prodQ = req.nextUrl.searchParams.get("product"); const product: Product = isProduct(prodQ) ? prodQ : "all";
  const { data, error } = await supabase
    .from("weekly_creative_reports")
    .select("id, created_at, week_start, week_end, label, rows, platform, product")
    .eq("platform", platform).eq("product", product)
    .order("week_start", { ascending: false });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const list: WeeklyReportSummary[] = (data ?? []).map(r => ({
    id: r.id, createdAt: r.created_at,
    weekStart: r.week_start, weekEnd: r.week_end, label: r.label,
    adCount: Array.isArray(r.rows) ? r.rows.length : 0,
  }));
  return NextResponse.json({ reports: list });
}

// POST /api/analytics/weekly  { weekStart, weekEnd, label? }
// Собирает срез из meta_ads + pbi_metrics за окно [weekStart, weekEnd],
// join meta_creatives за превью, замораживает снапшотом (upsert по окну).
export async function POST(req: NextRequest) {
  const supabase = createServiceClient();
  const body = await req.json().catch(() => ({})) as { weekStart?: string; weekEnd?: string; label?: string; platform?: string; product?: string };
  const product: Product = isProduct(body.product) ? body.product : "all"; // Бухгалтер / Медадмин / оба
  const { weekStart, weekEnd } = body;
  // канал среза: meta (по умолчанию) | google | tiktok | all (общий)
  const platform = body.platform && ["meta", "google", "tiktok", "all"].includes(body.platform) ? body.platform : "meta";
  if (!weekStart || !weekEnd) {
    return NextResponse.json({ error: "weekStart и weekEnd обязательны (YYYY-MM-DD)" }, { status: 400 });
  }

  // Сбор строк окна: Meta (дневные строки) / Google / TikTok за окно + лиды Elly за окно.
  let rows: WeeklyCreativeRow[];
  try {
    rows = (await collectWindowRows(supabase, platform as WindowPlatform, weekStart, weekEnd)).rows.filter(r => matchesProduct(r, product));
  } catch (e) {
    const status = e instanceof WindowError ? e.status : 500;
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status });
  }

  const label = body.label?.trim() || `${weekStart} – ${weekEnd}`;

  const { data: saved, error: saveErr } = await supabase
    .from("weekly_creative_reports")
    .upsert(
      { platform, product, week_start: weekStart, week_end: weekEnd, label, rows, created_at: new Date().toISOString() },
      { onConflict: "platform,product,week_start,week_end" }
    )
    .select("id, created_at, week_start, week_end, label, rows, summary, summary_note, document")
    .single();

  if (saveErr) return NextResponse.json({ error: saveErr.message }, { status: 500 });

  return NextResponse.json({
    report: {
      id: saved.id, createdAt: saved.created_at,
      weekStart: saved.week_start, weekEnd: saved.week_end,
      label: saved.label, rows: saved.rows,
      summary: saved.summary ?? "", summaryNote: saved.summary_note ?? "",
      document: saved.document ?? "",
    } as WeeklyReport,
    notes: [],
  });
}
