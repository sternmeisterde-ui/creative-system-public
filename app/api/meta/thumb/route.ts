import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";

// Хосты превью Google/YouTube: отдаём байты через себя — блокировщики рекламы режут tpc.googlesyndication.com в <img>,
// из-за чего на /weekly по Google было «нет превью» (16.10.2026). Кеш суток: эти URL стабильные.
const PROXY_HOSTS = new Set(["tpc.googlesyndication.com", "img.youtube.com", "i.ytimg.com", "i9.ytimg.com"]);
async function nonMetaPreview(adId: string): Promise<NextResponse> {
  const sb = createServiceClient();
  const { data } = await sb.from("meta_creatives").select("thumbnail_url, image_url, asset_url, video_id, platform").eq("ad_id", adId).maybeSingle();
  const yt = data?.video_id && /^[\w-]{11}$/.test(data.video_id) ? `https://i.ytimg.com/vi/${data.video_id}/hqdefault.jpg` : null;
  const src = data?.image_url || data?.thumbnail_url || yt || data?.asset_url || null;
  if (!src) return NextResponse.json({ error: "нет превью для этого объявления" }, { status: 404 });
  let host = ""; try { host = new URL(src).hostname; } catch { /* ignore */ }
  if (!PROXY_HOSTS.has(host)) return NextResponse.redirect(src, { status: 302, headers: { "Cache-Control": "public, max-age=3600" } });
  const r = await fetch(src, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!r.ok) return NextResponse.json({ error: `источник превью ответил ${r.status}` }, { status: 502 });
  return new NextResponse(await r.arrayBuffer(), { status: 200, headers: { "Content-Type": r.headers.get("content-type") ?? "image/jpeg", "Cache-Control": "public, max-age=86400" } });
}

// GET /api/meta/thumb?adId=123 → 302 на СВЕЖИЙ thumbnail/image крео из Meta.
// Превью Meta (creative{thumbnail_url,image_url}) — временные CDN-ссылки, за
// несколько дней протухают (403). Поэтому не храним их, а резолвим по клику/загрузке
// заново по ad_id (аналогично /api/meta/video для видео).
export const maxDuration = 30;

const TOKEN = process.env.META_ACCESS_TOKEN;

export async function GET(req: NextRequest) {
  const adId = req.nextUrl.searchParams.get("adId");
  if (!adId) return NextResponse.json({ error: "adId обязателен" }, { status: 400 });
  if (!/^\d{6,}$/.test(adId)) return nonMetaPreview(adId); // Google / TikTok — не Graph
  if (!TOKEN) return NextResponse.json({ error: "META_ACCESS_TOKEN не задан" }, { status: 503 });

  try {
    const url = new URL(`https://graph.facebook.com/v21.0/${adId}`);
    url.searchParams.set("fields", "creative{thumbnail_url,image_url}");
    url.searchParams.set("access_token", TOKEN);
    const res = await fetch(url.toString());
    const j = await res.json() as { creative?: { thumbnail_url?: string; image_url?: string }; error?: { message: string } };
    if (j.error) return NextResponse.json({ error: j.error.message }, { status: 502 });

    const src = j.creative?.image_url || j.creative?.thumbnail_url;
    if (!src) return NextResponse.json({ error: "нет превью (объявление удалено?)" }, { status: 404 });

    // Кешируем редирект ненадолго — свежий CDN-URL живёт часами, повторные загрузки
    // в рамках сессии не дёргают Graph заново.
    return NextResponse.redirect(src, { status: 302, headers: { "Cache-Control": "public, max-age=3600" } });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
