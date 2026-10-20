import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";

// GET /api/library/counts — счётчики осей концепций и актёров для вкладок библиотеки
export async function GET() {
  const sb = createServiceClient();
  const [c, a] = await Promise.all([
    sb.from("concepts").select("id", { count: "exact", head: true }),
    sb.from("actors").select("id", { count: "exact", head: true }),
  ]);
  return NextResponse.json({ concepts: c.count ?? 0, actors: a.count ?? 0 });
}
