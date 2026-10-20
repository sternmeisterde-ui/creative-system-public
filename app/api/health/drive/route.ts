import { NextResponse } from "next/server";
// Ежедневная проверка токена Google Drive (крон 06:40). Refresh-токен OAuth-приложения в статусе «Testing» живёт 7 дней —
// 16.10.2026 он протух молча, и ТЗ в Google Docs перестали открываться. При ошибке — алерт в Telegram с командой починки.
export const maxDuration = 30;
export async function GET() {
  const id = process.env.GOOGLE_DRIVE_CLIENT_ID, secret = process.env.GOOGLE_DRIVE_CLIENT_SECRET, rt = process.env.GOOGLE_DRIVE_REFRESH_TOKEN;
  if (!id || !secret || !rt) return NextResponse.json({ ok: false, error: "GOOGLE_DRIVE_* не заданы" }, { status: 503 });
  const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: id, client_secret: secret, refresh_token: rt, grant_type: "refresh_token" }) });
  const j = await r.json() as { access_token?: string; error?: string; error_description?: string };
  if (j.access_token) return NextResponse.json({ ok: true, checkedAt: new Date().toISOString() });
  const msg = `⚠️ Creative System: токен Google Drive не работает (${j.error ?? r.status}: ${j.error_description ?? ""}). ТЗ в Google Docs не откроются.\nПочинить: в папке проекта выполнить  node scripts/google-oauth.mjs --drive  (откроется браузер, после входа токен сам уедет в Vercel и задеплоится).\nЧтобы не повторялось: OAuth consent screen вашего проекта Google Cloud → Publishing status = In production.`;
  const tg = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.TELEGRAM_CHAT_ID;
  if (tg && chat) await fetch(`https://api.telegram.org/bot${tg}/sendMessage`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: chat, text: msg }) }).catch(() => undefined);
  return NextResponse.json({ ok: false, error: j.error, description: j.error_description }, { status: 502 });
}
