import { NextRequest, NextResponse, after } from "next/server";
import { createServiceClient } from "@/lib/supabase";
import { buildBriefDocx } from "@/lib/brief-docx";
import { isDriveConfigured, uploadDocxAsGoogleDoc } from "@/lib/gdrive";

// ТЗ в Google Docs — ФОНОВОЕ задание (brief_exports, миграция 040). Раньше синхронный запрос собирал DOCX,
// считал таймкоды и грузил в Drive 1–3 минуты и падал 502 / пустой вкладкой (16.10.2026). Теперь:
// POST { id? | sessionId? } → сразу { jobId, pageUrl }, сборка продолжается после ответа (after()),
// страница /briefs/export?job= опрашивает /api/briefs/export-status и переходит в документ.
export const maxDuration = 300;

async function runJob(jobId: string, id: string | undefined, sessionId: string | undefined, origin: string) {
  const sb = createServiceClient();
  try {
    const built = await buildBriefDocx(sb, { id, sessionId, origin });
    const key = id ? `brief:${id}` : `session:${built.sessionId}`;
    const doc = await uploadDocxAsGoogleDoc(built.buffer, built.fname, key);
    await sb.from("brief_exports").update({ status: "ready", url: doc.url, title: built.title, updated_at: new Date().toISOString() }).eq("id", jobId);
  } catch (e) {
    await sb.from("brief_exports").update({ status: "error", error: e instanceof Error ? e.message : String(e), updated_at: new Date().toISOString() }).eq("id", jobId);
  }
}

async function startJob(req: NextRequest, id?: string, sessionId?: string): Promise<{ jobId: string; pageUrl: string } | { error: string; status: number }> {
  if (!isDriveConfigured()) return { error: "Google Drive не подключён: нужен GOOGLE_DRIVE_REFRESH_TOKEN (node scripts/google-oauth.mjs --drive) в env Vercel", status: 503 };
  if (!id && !sessionId) return { error: "id или sessionId обязателен", status: 400 };
  const origin = `${req.headers.get("x-forwarded-proto") ?? "https"}://${req.headers.get("host") ?? "localhost:3000"}`;
  const sb = createServiceClient();
  const { data, error } = await sb.from("brief_exports").insert({ kind: "gdoc", brief_id: id ?? null, session_id: sessionId ?? null, status: "pending" }).select("id").single();
  if (error || !data) return { error: error?.message ?? "не удалось создать задание", status: 500 };
  after(() => runJob(data.id, id, sessionId, origin));
  return { jobId: data.id, pageUrl: `${origin}/briefs/export?job=${data.id}` };
}

export async function POST(req: NextRequest) {
  const { id, sessionId } = await req.json().catch(() => ({})) as { id?: string; sessionId?: string };
  const r = await startJob(req, id, sessionId);
  if ("error" in r) return NextResponse.json({ error: r.error }, { status: r.status });
  return NextResponse.json({ ok: true, ...r });
}

// GET ?id= | ?sessionId= — ссылки из кнопок: сразу уводим на страницу ожидания, она сама откроет документ
export async function GET(req: NextRequest) {
  const r = await startJob(req, req.nextUrl.searchParams.get("id") ?? undefined, req.nextUrl.searchParams.get("sessionId") ?? undefined);
  if ("error" in r) return NextResponse.json({ error: r.error }, { status: r.status });
  return NextResponse.redirect(r.pageUrl, { status: 302 });
}
