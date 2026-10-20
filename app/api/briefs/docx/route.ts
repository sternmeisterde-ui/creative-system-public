import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";
import { buildBriefDocx, BriefDocxError } from "@/lib/brief-docx";

// GET /api/briefs/docx?id=<briefId>  |  ?sessionId=<sessionId> — скачать ТЗ (бриф + референсы) в DOCX
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  const origin = `${req.headers.get("x-forwarded-proto") ?? "https"}://${req.headers.get("host") ?? "localhost:3000"}`;
  try {
    const { buffer, fname } = await buildBriefDocx(createServiceClient(), { id: req.nextUrl.searchParams.get("id"), sessionId: req.nextUrl.searchParams.get("sessionId"), origin });
    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "Content-Disposition": `attachment; filename="brief.docx"; filename*=UTF-8''${encodeURIComponent(fname)}`,
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    const status = e instanceof BriefDocxError ? e.status : 500;
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status });
  }
}
