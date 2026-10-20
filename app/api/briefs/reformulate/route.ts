import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";
import { ensureFormulation, FORMULATION_COLUMNS, rowToFormulation, type Axis, type FormulationRow } from "@/lib/formulations";

// POST { briefId, axis, text } — правка формулировки в брифе = НОВАЯ формулировка (решение 11.10.2026).
// Родительский текст в библиотеке не меняется; новая получает свой код и parent_code. Бриф переводится на новый
// код: id оси, adapted_*, текст и код в full_brief (без учёта ударений), слот пака в constructor_sessions.pack_metadata.
const AXES: Axis[] = ["persona", "hook", "body", "angle"];
const ACUTE = "́";

/** Замена без учёта ударений/вариантов тире и пробелов: текст в сценарии несёт U+0301 и «—/–/-». */
function replaceLoose(haystack: string, oldText: string, newText: string): string {
  const body = oldText.normalize("NFC").replace(new RegExp(ACUTE, "g"), "").trim();
  if (!body) return haystack;
  let pat = "";
  for (const ch of body) {
    if (/\s/.test(ch)) { if (!pat.endsWith("\\s+")) pat += "\\s+"; continue; }
    if ("—–-".includes(ch)) { pat += "[—–-]"; continue; }
    if ("«»\"“”".includes(ch)) { pat += "[«»\"“”]?"; continue; }
    pat += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + (/[а-яёА-ЯЁa-zA-Z]/.test(ch) ? `${ACUTE}?` : "");
  }
  return haystack.replace(new RegExp(pat, "g"), newText);
}

export async function POST(req: NextRequest) {
  const b = await req.json().catch(() => null) as { briefId?: string; axis?: Axis; text?: string } | null;
  if (!b?.briefId || !b.axis || !AXES.includes(b.axis) || !b.text?.trim()) return NextResponse.json({ error: "briefId, axis и text обязательны" }, { status: 400 });
  const sb = createServiceClient();
  const { data: brief } = await sb.from("briefs").select("*").eq("id", b.briefId).maybeSingle();
  if (!brief) return NextResponse.json({ error: "Бриф не найден" }, { status: 404 });
  const oldId = brief[`${b.axis}_id`] as string | null;
  if (!oldId) return NextResponse.json({ error: "У брифа нет формулировки этой оси" }, { status: 400 });
  const { data: oldRow } = await sb.from("formulations").select(FORMULATION_COLUMNS).eq("id", oldId).maybeSingle();
  if (!oldRow) return NextResponse.json({ error: "Исходная формулировка не найдена в библиотеке" }, { status: 404 });
  const old = rowToFormulation(oldRow as FormulationRow);

  const { formulation: nf, created } = await ensureFormulation(sb, {
    axis: b.axis, product: old.product, text: b.text, source: "brief-edit", parentCode: old.code,
    note: `Правка формулировки ${old.code} в ТЗ (бриф ${b.briefId.slice(0, 8)})`,
  });
  if (nf.code === old.code) return NextResponse.json({ error: "Текст не изменился — формулировка та же" }, { status: 400 });

  // Бриф → новый код: id оси, adapted_*, full_brief (построчно для боди «a | b | c», иначе целиком), код в имени/таблицах
  let full = (brief.full_brief as string | null) ?? "";
  const oldLines = old.text.split(" | ").map(s => s.trim()), newLines = nf.text.split(" | ").map(s => s.trim());
  if (oldLines.length > 1 && oldLines.length === newLines.length) {
    for (let i = 0; i < oldLines.length; i++) if (oldLines[i] !== newLines[i]) full = replaceLoose(full, oldLines[i], newLines[i]);
  }
  full = replaceLoose(full, old.text, nf.text);
  full = full.split(old.code).join(nf.code);
  const patch: Record<string, unknown> = { [`${b.axis}_id`]: nf.id, full_brief: full };
  if (b.axis !== "persona") patch[`adapted_${b.axis}`] = nf.text;
  const { error: upErr } = await sb.from("briefs").update(patch).eq("id", b.briefId);
  if (upErr) return NextResponse.json({ error: upErr.message }, { status: 500 });

  // Слот пака: те же четыре кода, что были у брифа → меняем код оси + след правки
  const { data: session } = await sb.from("constructor_sessions").select("id, pack_metadata").eq("id", brief.session_id).maybeSingle();
  const pm = (session?.pack_metadata ?? null) as { slots?: Array<{ codes: Record<string, string | null>; edits?: unknown[] }> } | null;
  if (pm?.slots?.length) {
    const ids: Record<Axis, string | null> = { persona: brief.persona_id, hook: brief.hook_id, body: brief.body_id, angle: brief.angle_id };
    const idList = AXES.map(a => ids[a]).filter((x): x is string => !!x);
    const { data: fr } = await sb.from("formulations").select("id, code").in("id", idList);
    const codeOf: Record<string, string> = {}; for (const f of fr ?? []) codeOf[f.id] = f.code;
    let touched = 0;
    for (const s of pm.slots) {
      const same = AXES.every(a => (s.codes[a] ?? "") === (ids[a] ? codeOf[ids[a]!] ?? "" : ""));
      if (!same) continue;
      s.codes[b.axis] = nf.code;
      s.edits = [...(s.edits ?? []), { axis: b.axis, from: old.code, to: nf.code, briefId: b.briefId, at: new Date().toISOString() }];
      touched++;
    }
    if (touched) await sb.from("constructor_sessions").update({ pack_metadata: pm }).eq("id", session!.id);
  }
  return NextResponse.json({ ok: true, created, from: { code: old.code, text: old.text }, to: { id: nf.id, code: nf.code, text: nf.text } });
}
