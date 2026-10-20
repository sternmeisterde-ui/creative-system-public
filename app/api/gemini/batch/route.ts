import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";
import { describeCreative, resolveMetaVideoSource } from "@/lib/gemini";
import { fetchTikTokVideos } from "@/lib/tiktok";

// Батч-разбор креативов Gemini Vision. Берёт значимые крео (winner/fake/loser по умолч.),
// у которых есть ассет и ещё нет описания, обрабатывает ЧАНК (limit) и возвращает остаток.
// Видео грузим целиком (source по video_id → Files API). Чанк мал — каждое видео медленно.
export const maxDuration = 300;

const k = (s: string) => (s ?? "").trim().toLowerCase();

interface CreativeRow { ad_name: string; asset_url: string | null; video_id: string | null; thumbnail_url: string | null; platform: string | null }

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({})) as { limit?: number; statuses?: string[]; platform?: string };
  const platform = body.platform && body.platform !== "all" ? body.platform : null;
  const limit = Math.min(Math.max(body.limit ?? 6, 1), 20);
  const statuses = body.statuses ?? ["winner", "fake_winner", "loser"];
  const sb = createServiceClient();

  // целевые имена (значимые статусы)
  let perfQ = sb.from("creative_performance").select("ad_name, auto_status").in("auto_status", statuses);
  if (platform) perfQ = perfQ.eq("platform", platform);
  const { data: perf, error: perfErr } = await perfQ;
  if (perfErr) return NextResponse.json({ error: perfErr.message }, { status: 500 });
  const targetNames = new Set((perf ?? []).map(r => k(r.ad_name)));

  // уже разобранные
  const { data: done } = await sb.from("gemini_analyses").select("ad_name").eq("mode", "creative_desc").not("ad_name", "is", null);
  const doneNames = new Set((done ?? []).map(r => k(r.ad_name)));

  // ассеты (один на имя, приоритет — с video_id или asset_url)
  const { data: creatives } = await sb
    .from("meta_creatives").select("ad_name, asset_url, video_id, thumbnail_url, platform");
  const byName = new Map<string, CreativeRow>();
  for (const c of (creatives ?? []) as CreativeRow[]) {
    const key = k(c.ad_name);
    if (!targetNames.has(key) || doneNames.has(key)) continue;
    if (!(c.asset_url || c.video_id)) continue;
    if (!byName.has(key)) byName.set(key, c);
  }

  // Google-ролики без скачанного файла в чанк не берём — иначе они занимали бы слоты ошибками.
  const ready = [...byName.values()].filter(c => !(c.platform === "google" && c.video_id && !(c.asset_url ?? "").includes("/storage/v1/")));
  const waitingGoogleVideos = byName.size - ready.length;
  const worklist = ready.slice(0, limit);
  const totalPending = ready.length;

  let processed = 0;
  const failed: { ad_name: string; error: string }[] = [];
  for (const c of worklist) {
    try {
      let assetUrl = c.asset_url;
      if (c.platform === "google") {
        // Google: картинка — прямой URL; видео (YouTube unlisted) — только скачанный mp4 из Storage,
        // по превью ролик не описываем (это был бы разбор одного кадра под видом видео).
        if (c.video_id && !(assetUrl ?? "").includes("/storage/v1/")) {
          throw new Error("ролик YouTube не скачан — прогнать scripts/google-video-backfill.py");
        }
      } else if (c.platform === "tiktok") {
        // TikTok: preview_url mp4 временный — перед разбором берём свежую ссылку из Marketing API,
        // иначе Storage-копия / то, что лежит в asset_url (картинки — постоянные URL).
        if (c.video_id && !(assetUrl ?? "").includes("/storage/v1/")) {
          const fresh = (await fetchTikTokVideos([c.video_id]).catch(() => new Map())).get(c.video_id);
          assetUrl = fresh?.previewUrl ?? assetUrl ?? c.thumbnail_url;
        }
      } else if (c.video_id) {
        assetUrl = (await resolveMetaVideoSource(c.video_id)) ?? c.thumbnail_url ?? c.asset_url;
      }
      if (!assetUrl) throw new Error("нет доступного ассета");
      const desc = await describeCreative(assetUrl);
      const { error } = await sb.from("gemini_analyses").insert({ mode: "creative_desc", ad_name: c.ad_name, analysis: desc });
      if (error) throw new Error(error.message);
      processed++;
    } catch (e) {
      failed.push({ ad_name: c.ad_name, error: e instanceof Error ? e.message : String(e) });
    }
  }

  return NextResponse.json({
    ok: true,
    processed,
    failed,
    remaining: Math.max(totalPending - processed, 0),
    waitingGoogleVideos,
  });
}

export async function GET() {
  return POST(new NextRequest("http://localhost/api/gemini/batch", { method: "POST", body: "{}" }));
}
