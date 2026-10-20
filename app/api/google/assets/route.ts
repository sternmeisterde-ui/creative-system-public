import { NextRequest } from "next/server";
import { POST as googleSync } from "@/app/api/google/sync/route";

// ── Google Ads creative assets ───────────────────────────────────────────────
// Каталог превью (meta_creatives, platform='google') теперь пишет сам /api/google/sync
// вместе с метриками — одни и те же ad_id / ad_name у метрик и у картинок. Этот роут
// оставлен для кнопки «Подтянуть ассеты» на /mapping/google и просто дёргает синк.
export const maxDuration = 300;

export async function POST() {
  return googleSync(new NextRequest("http://localhost/api/google/sync", { method: "POST", body: "{}" }));
}

export async function GET() {
  return POST();
}
