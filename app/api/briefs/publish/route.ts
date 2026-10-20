import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";
import { buildAdName } from "@/lib/naming";
import { resolveParamRefs } from "@/lib/param-lookup";

// POST /api/briefs/publish
// Takes all approved briefs from a session, builds ad names, creates creatives
export async function POST(req: NextRequest) {
  const { sessionId } = await req.json() as { sessionId: string };
  if (!sessionId) return NextResponse.json({ error: "sessionId required" }, { status: 400 });

  const supabase = createServiceClient();

  // Get session for flow
  const { data: session } = await supabase
    .from("constructor_sessions")
    .select("flow, format, pack_metadata")
    .eq("id", sessionId)
    .single();

  const flow = (session?.flow as string) ?? "com";
  const sessionFormat = (session?.format as string) ?? "ugc";
  // концепция видео пака → V-код в имени объявления (P-H-B-A-V{n}-FORMAT)
  const conceptCode = ((session?.pack_metadata as { concept?: { code?: string } | null } | null)?.concept?.code) ?? undefined;
  // актёр слота → в имя объявления (ось «актёр» в аналитике): ищем слот по кодам P/H/B/A брифа
  const slots = ((session?.pack_metadata as { slots?: Array<{ codes: { persona: string | null; hook: string | null; body: string | null; angle: string | null; actor?: string | null } }> } | null)?.slots) ?? [];
  const actorFor = (p: string, h: string, b: string, a: string) =>
    slots.find(s => (s.codes.persona ?? "") === p && s.codes.hook === h && s.codes.body === b && s.codes.angle === a)?.codes.actor ?? undefined;

  // Get approved briefs
  const { data: briefs } = await supabase
    .from("briefs")
    .select("*")
    .eq("session_id", sessionId)
    .eq("status", "approved");

  if (!briefs || briefs.length === 0) {
    return NextResponse.json({ ok: true, created: 0, creatives: [], message: "Нет одобренных брифов" });
  }

  // Коды формулировок по id (старые брифы — из прежней библиотеки)
  const refs = await resolveParamRefs(supabase, briefs.flatMap(b => [b.persona_id, b.hook_id, b.body_id, b.angle_id]));
  const codeOf = (id: string | null): string => (id ? refs[id]?.code ?? "?" : "");

  const created: { adName: string; briefId: string; creativeId: string }[] = [];

  for (const brief of briefs) {
    const pCode = codeOf(brief.persona_id);   // "" — персона не задана, в имени пропускается
    const hCode = codeOf(brief.hook_id);
    const bCode = codeOf(brief.body_id);
    const aCode = codeOf(brief.angle_id);
    const fmt   = (brief.format ?? sessionFormat).toUpperCase();

    // Хук, боди и энгл обязательны
    if ([pCode, hCode, bCode, aCode].includes("?") || !hCode || !bCode || !aCode) continue;

    const adName = buildAdName(pCode, hCode, bCode, aCode, fmt, undefined, conceptCode, actorFor(pCode, hCode, bCode, aCode));

    // Check if creative with this ad name already exists
    const { data: existing } = await supabase
      .from("creatives")
      .select("id")
      .eq("meta_ad_name", adName)
      .maybeSingle();

    if (existing) {
      created.push({ adName, briefId: brief.id, creativeId: existing.id });
      continue;
    }

    const { data: creative } = await supabase
      .from("creatives")
      .insert({
        source: "internal",
        flow,
        persona_id: brief.persona_id,
        hook_id: brief.hook_id,
        body_id: brief.body_id,
        angle_id: brief.angle_id,
        format: brief.format ?? sessionFormat,
        status: "testing",
        meta_ad_name: adName,
        description: brief.full_brief?.slice(0, 500) ?? null,
      })
      .select("id")
      .single();

    if (creative) {
      created.push({ adName, briefId: brief.id, creativeId: creative.id });
    }
  }

  return NextResponse.json({ ok: true, created: created.length, creatives: created });
}
