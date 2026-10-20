import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";
import { AXES, ensureFormulation, loadFormulations, textKey, type Axis, type FormulationProduct } from "@/lib/formulations";

// ── /api/formulations — библиотека уникальных дословных формулировок ─────────
// GET  ?axis=&product=            список (+ использование по ad_name_mapping)
// POST { axis, product, text, note? }  создать; точное совпадение → 409 с существующим кодом
// PATCH { id, note }               правка заметки (текст формулировки неизменяем: новый текст = новая формулировка)
// DELETE { id }                    удалить, только если ни одно объявление её не использует

const isAxis = (v: unknown): v is Axis => typeof v === "string" && (AXES as string[]).includes(v);
const isProd = (v: unknown): v is FormulationProduct => v === "buchhalter" || v === "medadmin";

export async function GET(req: NextRequest) {
  const sb = createServiceClient();
  const axisQ = req.nextUrl.searchParams.get("axis");
  const prodQ = req.nextUrl.searchParams.get("product");
  const withUsage = req.nextUrl.searchParams.get("usage") !== "0";
  try {
    const items = await loadFormulations(sb, { axis: isAxis(axisQ) ? axisQ : undefined, product: isProd(prodQ) ? prodQ : "all" });
    const usage: Record<string, number> = {};
    if (withUsage) {
      for (let from = 0; ; from += 1000) {
        const { data, error } = await sb.from("ad_name_mapping").select("persona_code, hook_code, body_code, angle_code").order("ad_name").range(from, from + 999);
        if (error) throw new Error(error.message);
        for (const r of data ?? []) for (const c of [r.persona_code, r.hook_code, r.body_code, r.angle_code]) if (c) usage[c] = (usage[c] ?? 0) + 1;
        if (!data || data.length < 1000) break;
      }
    }
    return NextResponse.json({ ok: true, items: items.map(f => ({ ...f, adCount: usage[f.code] ?? 0 })) });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({})) as { axis?: unknown; product?: unknown; text?: unknown; note?: unknown };
  if (!isAxis(body.axis) || !isProd(body.product) || typeof body.text !== "string" || !textKey(body.text)) {
    return NextResponse.json({ error: "Нужны axis (persona|hook|body|angle), product (buchhalter|medadmin) и непустой text" }, { status: 400 });
  }
  const sb = createServiceClient();
  try {
    const { formulation, created } = await ensureFormulation(sb, {
      axis: body.axis, product: body.product, text: body.text, source: "manual", note: typeof body.note === "string" ? body.note : null,
    });
    if (!created) {
      return NextResponse.json({ error: `Такая формулировка уже есть: ${formulation.code}`, existing: formulation }, { status: 409 });
    }
    return NextResponse.json({ ok: true, formulation });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest) {
  const { id, note } = await req.json().catch(() => ({})) as { id?: string; note?: string | null };
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  const sb = createServiceClient();
  const { error } = await sb.from("formulations").update({ note: note?.trim() || null }).eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest) {
  const { id } = await req.json().catch(() => ({})) as { id?: string };
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  const sb = createServiceClient();
  const { data: f } = await sb.from("formulations").select("code").eq("id", id).maybeSingle();
  if (!f) return NextResponse.json({ error: "Не найдена" }, { status: 404 });
  const { count } = await sb.from("ad_name_mapping").select("id", { count: "exact", head: true })
    .or(`persona_code.eq.${f.code},hook_code.eq.${f.code},body_code.eq.${f.code},angle_code.eq.${f.code}`);
  if ((count ?? 0) > 0) return NextResponse.json({ error: `Формулировка ${f.code} используется в ${count} объявлениях — удалять нельзя` }, { status: 409 });
  const { error } = await sb.from("formulations").delete().eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
