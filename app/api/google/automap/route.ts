import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";
import { automapGoogle } from "@/lib/google-automap";

// POST { limit? } — прокладка Google → коды (lib/google-automap.ts): статика по визуалу (dHash) от размеченных
// Meta/Google, иначе тексты Gemini → формулировки; видео — тексты + актёр/концепция только при совпадении визуала.
// Работает порциями в пределах времени функции; цикл на панели зовёт до remaining = 0.
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({})) as { limit?: number };
  try {
    const stats = await automapGoogle(createServiceClient(), { deadlineMs: Date.now() + 280_000, limit: body.limit });
    return NextResponse.json(stats);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
