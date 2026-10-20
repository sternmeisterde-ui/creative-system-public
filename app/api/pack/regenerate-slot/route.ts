/**
 * POST /api/pack/regenerate-slot
 *
 * Перегенерация одного слота в выданном паке.
 * Сохраняет категорию слота (winner_family / winner_mix / discovery / competitor),
 * меняет только конкретный slot_id внутри pack_metadata.slots[].
 *
 * Body: { sessionId: string, slotId: number }
 */
import Anthropic from "@anthropic-ai/sdk";
import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";
import { getAiContext, getBusiness } from "@/lib/brief";
import { getSettings } from "@/lib/settings";
import { loadReportById, reportContextBlock } from "@/lib/report-context";
import type { PackMetadata, PackSlot } from "@/lib/types";
import { loadFormulations, type Axis } from "@/lib/formulations";

// Текст ответа Claude: у моделей 5-го поколения первый блок content может быть не text (напр. thinking/summary),
// поэтому склеиваем все text-блоки и падаем с понятной ошибкой, если текста нет.
function claudeText(msg: { content: Array<{ type: string; text?: string }>; stop_reason?: string | null }): string {
  const text = msg.content.filter(b => b.type === "text").map(b => b.text ?? "").join("");
  if (!text.trim()) throw new Error(`Модель не вернула текст (stop_reason=${msg.stop_reason ?? "?"}, блоков: ${msg.content.map(b => b.type).join(",") || "0"})`);
  return text;
}


export const maxDuration = 120;

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

interface RequestBody {
  sessionId: string;
  slotId:    number;
}

export async function POST(req: NextRequest) {
  const { sessionId, slotId } = (await req.json()) as RequestBody;
  if (!sessionId || slotId == null) {
    return NextResponse.json({ error: "sessionId и slotId обязательны" }, { status: 400 });
  }

  const supabase = createServiceClient();
  const settings = await getSettings();

  // Загружаем текущий pack
  const { data: session, error: sessErr } = await supabase
    .from("constructor_sessions")
    .select("id, flow, format, pack_metadata")
    .eq("id", sessionId)
    .single();
  if (sessErr || !session?.pack_metadata) {
    return NextResponse.json({ error: "Session не найдена или без pack_metadata" }, { status: 404 });
  }

  const meta = session.pack_metadata as PackMetadata;
  const baseReport = meta.report?.id ? await loadReportById(supabase, meta.report.id) : null;
  const slot = meta.slots.find(s => s.slotId === slotId);
  if (!slot) {
    return NextResponse.json({ error: `Slot #${slotId} не найден в паке` }, { status: 404 });
  }

  // Библиотека формулировок продукта пака (уникальные дословные тексты)
  const forms = await loadFormulations(supabase, { product: meta.product === "buchhalter" || meta.product === "medadmin" ? meta.product : "all" });
  const known = new Set(forms.map(f => f.code));
  const lib = (axis: Axis) => forms.filter(f => f.axis === axis).slice(0, 150).map(f => ({ code: f.code, name: f.text }));
  const pRes = { data: lib("persona") }, hRes = { data: lib("hook") }, bRes = { data: lib("body") }, aRes = { data: lib("angle") };
  const { data: actorRows } = await supabase.from("actors").select("code, name, kind");
  const actorCodes = new Set(((actorRows ?? []) as { code: string }[]).map(a => a.code.toUpperCase()));
  const actorsBlock = ((actorRows ?? []) as { code: string; name: string; kind: string }[]).slice(0, 60).map(a => `  ${a.code} [${a.kind}]: ${a.name}`).join("\n");

  // Уже использованные комбинации в паке — чтобы не повторяться
  const usedCombos = new Set(
    meta.slots
      .filter(s => s.slotId !== slotId)
      .map(s => `${s.codes.persona}|${s.codes.hook}|${s.codes.body}|${s.codes.angle}`)
  );

  const codesBlock = (rows: Array<{ code: string | null; name: string }>) =>
    rows.length ? rows.map(r => `  ${r.code}: «${r.name.replace(/\s+/g, " ").slice(0, 200)}»`).join("\n") : "  (нет)";

  const prompt = `Ты — стратег рекламных креативов Meta Ads.

${getBusiness().name}
${getAiContext()}

Цели: CPL ≤ €${settings.cplTarget}, CPQL ≤ €${settings.cpqlTarget}.
Формат производства: ${meta.format.toUpperCase()}${meta.concept ? `
Концепция видео всего пака: ${meta.concept.code} — ${meta.concept.name} (слот должен раскрываться в этой концепции)` : ""}

${baseReport ? `## ОСНОВА ПАКА — ОТЧЁТ
${reportContextBlock(baseReport, "short")}
` : ""}
ЗАДАЧА: перегенерируй ТОЛЬКО один слот пака с сохранением его категории.

Категория слота: ${slot.category}
Текущее содержимое (мы его выкидываем):
  codes: P=${slot.codes.persona ?? "?"} H=${slot.codes.hook ?? "?"} B=${slot.codes.body ?? "?"} A=${slot.codes.angle ?? "?"}
  rationale: ${slot.rationale}
${slot.basedOnAd ? `  based_on_ad: ${slot.basedOnAd}\n` : ""}${slot.fromWinners?.length ? `  from_winners: ${slot.fromWinners.join(", ")}\n` : ""}

УЖЕ ИСПОЛЬЗОВАННЫЕ КОМБИНАЦИИ В ПАКЕ (избегай повтора):
${Array.from(usedCombos).slice(0, 20).map(c => `  ${c}`).join("\n") || "  (нет)"}

## БИБЛИОТЕКА ФОРМУЛИРОВОК (код = одна уникальная дословная формулировка, не категория)
Персоны (может быть null — без прямого обращения):
${codesBlock((pRes.data ?? []) as Array<{ code: string | null; name: string }>)}
Хуки:
${codesBlock((hRes.data ?? []) as Array<{ code: string | null; name: string }>)}
Боди:
${codesBlock((bRes.data ?? []) as Array<{ code: string | null; name: string }>)}
Энглы:
${codesBlock((aRes.data ?? []) as Array<{ code: string | null; name: string }>)}
Актёры (кто в кадре):
${actorsBlock || "  (нет)"}

ПРАВИЛА:
- ВСЕ параметры обязательны: persona, hook, body, angle${meta.format !== "static" ? ", actor" : ""} — слот с пропуском не принимается
- Сохрани категорию слота: ${slot.category}
- Используй ТОЛЬКО существующие коды формулировок из библиотеки (новые не создаём — это перегенерация слота)
- Комбинация должна отличаться от уже использованных в паке

Верни СТРОГО JSON, без markdown:
{
  "slot_id": ${slotId},
  "category": "${slot.category}",
  "codes": { "persona": "<код>", "hook": "<код>", "body": "<код>", "angle": "<код>", "actor": "<код актёра>" },
  "rationale": "короткое объяснение почему эта комбинация"${slot.category === "winner_family" ? ',\n  "based_on_ad": "ad_name", "varied_param": "persona|hook|body|angle"' : ""}${slot.category === "winner_mix" ? ',\n  "from_winners": ["ad_name1", "ad_name2"]' : ""}${slot.category === "discovery" ? ',\n  "helps_codes": ["H3", "B4"]' : ""}
}`;

  const msg = await anthropic.messages.create({
    model: "claude-fable-5-1",
    max_tokens: 1500,
    messages: [{ role: "user", content: prompt }],
  });

  const text = claudeText(msg);
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return NextResponse.json({ error: `Claude вернул не-JSON: ${text.slice(0, 500)}` }, { status: 502 });
  }

  let newSlot: Record<string, unknown>;
  try {
    newSlot = JSON.parse(jsonMatch[0]);
  } catch (e) {
    return NextResponse.json({ error: `JSON parse fail: ${(e as Error).message}` }, { status: 502 });
  }

  // Обновляем pack_metadata
  const nc = (newSlot.codes ?? {}) as Record<string, unknown>;
  const complete = ["persona", "hook", "body", "angle"].every(k => typeof nc[k] === "string" && known.has(String(nc[k]).trim().toUpperCase()));
  if (!complete) return NextResponse.json({ error: "Модель вернула слот без одного из параметров (персона/хук/боди/энгл) — повтори перегенерацию" }, { status: 502 });

  const updatedSlot: PackSlot = {
    slotId,
    category: slot.category,
    codes: (() => { // только реальные коды формулировок; выдуманные → null
      const raw = (newSlot.codes ?? slot.codes) as Record<string, unknown>;
      const pick = (a: Axis) => { const v = typeof raw[a] === "string" ? String(raw[a]).trim().toUpperCase() : ""; return known.has(v) ? v : null; };
      const act = typeof raw.actor === "string" ? String(raw.actor).trim().toUpperCase() : "";
      return { persona: pick("persona"), hook: pick("hook"), body: pick("body"), angle: pick("angle"), concept: slot.codes.concept ?? meta.concept?.code ?? null, actor: actorCodes.has(act) ? act : slot.codes.actor ?? null };
    })(),
    rationale: String(newSlot.rationale ?? slot.rationale),
    basedOnAd: newSlot.based_on_ad as string | undefined,
    variedParam: newSlot.varied_param as PackSlot["variedParam"],
    fromWinners: newSlot.from_winners as string[] | undefined,
    helpsCodes: newSlot.helps_codes as string[] | undefined,
    sourceConceptId: slot.sourceConceptId,        // сохраняем для competitor
    newCodesCreated: slot.newCodesCreated,        // сохраняем для competitor
  };

  const updatedMeta: PackMetadata = {
    ...meta,
    slots: meta.slots.map(s => s.slotId === slotId ? updatedSlot : s),
  };

  const { error: updErr } = await supabase
    .from("constructor_sessions")
    .update({ pack_metadata: updatedMeta })
    .eq("id", sessionId);

  if (updErr) {
    return NextResponse.json({ error: `DB update error: ${updErr.message}` }, { status: 500 });
  }

  return NextResponse.json({ ok: true, slot: updatedSlot });
}
