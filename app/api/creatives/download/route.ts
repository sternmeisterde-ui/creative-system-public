import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";
import { resolveParamRefs } from "@/lib/param-lookup";

// GET /api/creatives/download?id={generationId}
export async function GET(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

  const supabase = createServiceClient();
  const { data: gen } = await supabase
    .from("creative_generations")
    .select(`
      result_url, format, is_static,
      briefs (
        persona_id, hook_id, body_id, angle_id,
        constructor_sessions:session_id (flow)
      )
    `)
    .eq("id", id)
    .single();

  if (!gen?.result_url) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const brief = gen.briefs as {
    persona_id?: string | null; hook_id?: string | null; body_id?: string | null; angle_id?: string | null;
    constructor_sessions?: { flow?: string } | null;
  } | null;
  const refs = await resolveParamRefs(supabase, [brief?.persona_id, brief?.hook_id, brief?.body_id, brief?.angle_id]);
  const codeOf = (idv: string | null | undefined, fb: string) => (idv && refs[idv]?.code) || fb;

  const p = codeOf(brief?.persona_id, "");
  const h = codeOf(brief?.hook_id, "H?");
  const b = codeOf(brief?.body_id, "B?");
  const a = codeOf(brief?.angle_id, "A?");
  const fmt = (gen.format as string ?? "static").toUpperCase();
  const ext = gen.is_static ? "png" : "mp4";

  const filename = [p, h, b, a, fmt].filter(Boolean).join("·") + "." + ext;

  const imageRes = await fetch(gen.result_url as string);
  if (!imageRes.ok) return NextResponse.json({ error: "Failed to fetch file" }, { status: 502 });

  const buffer = await imageRes.arrayBuffer();
  const contentType = gen.is_static ? "image/png" : "video/mp4";

  return new NextResponse(buffer, {
    headers: {
      "Content-Type": contentType,
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
