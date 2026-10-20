import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";
// GET ?job= — статус фонового экспорта ТЗ (pending | ready | error)
export async function GET(req: NextRequest) {
  const job = req.nextUrl.searchParams.get("job");
  if (!job) return NextResponse.json({ error: "job обязателен" }, { status: 400 });
  const { data } = await createServiceClient().from("brief_exports").select("id, kind, status, url, title, error, created_at, updated_at").eq("id", job).maybeSingle();
  if (!data) return NextResponse.json({ error: "задание не найдено" }, { status: 404 });
  return NextResponse.json(data, { headers: { "Cache-Control": "no-store" } });
}
