import { NextRequest } from "next/server";
import { POST as ellySyncPost } from "@/app/api/pbi/elly-sync/route";

// CRM-синк TikTok (лиды/QL/выручка из Elly, SourceGroupName='TikTok') — отдельный путь
// без query-string (для Vercel cron и кнопки цикла). Спенд/крео тянет /api/tiktok/sync;
// этот роут — про CRM: pbi_metrics с ключами tiktok:<AdId>, джойн с крео по имени объявления.
export const maxDuration = 300;

export async function POST() {
  return ellySyncPost(new NextRequest("http://localhost/api/pbi/elly-sync", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ source: "tiktok" }),
  }));
}

export async function GET() {
  return POST();
}
