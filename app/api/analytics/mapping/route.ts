import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";

export interface AdNameMapping {
  id: string;
  adName: string;
  personaCode: string | null;
  hookCode: string | null;
  bodyCode: string | null;
  angleCode: string | null;
  format: string | null;
  flow: string | null;
  conceptCode: string | null;   // V{n} — концепция видео
  actorCode: string | null;     // ANNA / WOM1987 — актёр
  note: string | null;
  product: string | null;       // buchhalter | medadmin — продукт формулировок
  mappedBy: string | null;      // gemini | gemini-quotes | manual
  legacy: { persona: string | null; hook: string | null; body: string | null; angle: string | null }; // старые групповые коды (провенанс)
}

function toClient(r: Record<string, unknown>): AdNameMapping {
  return {
    id:          r.id as string,
    adName:      r.ad_name as string,
    personaCode: r.persona_code as string | null,
    hookCode:    r.hook_code as string | null,
    bodyCode:    r.body_code as string | null,
    angleCode:   r.angle_code as string | null,
    format:      r.format as string | null,
    flow:        r.flow as string | null,
    conceptCode: (r.concept_code as string | null) ?? null,
    actorCode:   (r.actor_code as string | null) ?? null,
    note:        r.note as string | null,
    product:     (r.product as string | null) ?? null,
    mappedBy:    (r.mapped_by as string | null) ?? null,
    legacy: {
      persona: (r.legacy_persona_code as string | null) ?? null, hook: (r.legacy_hook_code as string | null) ?? null,
      body: (r.legacy_body_code as string | null) ?? null, angle: (r.legacy_angle_code as string | null) ?? null,
    },
  };
}

// GET — все маппинги
export async function GET() {
  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("ad_name_mapping")
    .select("*")
    .order("ad_name");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, mappings: (data ?? []).map(toClient) });
}

// POST — upsert маппинга по ad_name
export async function POST(req: NextRequest) {
  const body = await req.json() as Partial<AdNameMapping>;
  if (!body.adName?.trim()) {
    return NextResponse.json({ error: "adName required" }, { status: 400 });
  }

  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("ad_name_mapping")
    .upsert({
      ad_name:      body.adName.trim(),
      persona_code: body.personaCode?.trim().toUpperCase() || null,
      hook_code:    body.hookCode?.trim().toUpperCase() || null,
      body_code:    body.bodyCode?.trim().toUpperCase() || null,
      angle_code:   body.angleCode?.trim().toUpperCase() || null,
      format:       body.format?.trim().toLowerCase() || null,
      flow:         body.flow?.trim().toLowerCase() || null,
      concept_code: body.conceptCode?.trim().toUpperCase() || null,
      actor_code:   body.actorCode?.trim().toUpperCase() || null,
      note:         body.note?.trim() || null,
      product:      body.product === "buchhalter" || body.product === "medadmin" ? body.product : null,
      mapped_by:    body.mappedBy?.trim() || "manual",
      mapped_at:    new Date().toISOString(),
    }, { onConflict: "ad_name" })
    .select("*")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, mapping: toClient(data as Record<string, unknown>) });
}

// DELETE — удалить маппинг по id
export async function DELETE(req: NextRequest) {
  const { id } = await req.json() as { id: string };
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

  const supabase = createServiceClient();
  const { error } = await supabase.from("ad_name_mapping").delete().eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
