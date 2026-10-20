// ── Формулировки — уникальные дословные параметры креатива (06.10.2026) ──────
// Параметр (персона / хук / боди / энгл) = ТОЧНЫЙ текст из креатива со своим неизменяемым кодом.
// Любое отличие в тексте, даже минимальное, — отдельная формулировка и отдельный код.
// Никаких категорий и склеек: единственная нормализация — Unicode NFC и схлопывание пробелов.
// Код: {продукт}{ось}{6 цифр}: M = Медадмин, B = Бухгалтер; P/H/B/A. Пример: MH483920, BA102938.
import type { SupabaseClient } from "@supabase/supabase-js";

export type Axis = "persona" | "hook" | "body" | "angle";
export type FormulationProduct = "buchhalter" | "medadmin";

export const AXES: Axis[] = ["persona", "hook", "body", "angle"];
export const AXIS_LETTER: Record<Axis, string> = { persona: "P", hook: "H", body: "B", angle: "A" };
export const AXIS_LABEL: Record<Axis, string> = { persona: "Персона", hook: "Хук", body: "Боди", angle: "Энгл" };
export const AXIS_COLOR: Record<Axis, string> = { persona: "#48B8D0", hook: "#C490D1", body: "#6EC8A0", angle: "#FF8B5A" };
export const PRODUCT_LETTER: Record<FormulationProduct, string> = { medadmin: "M", buchhalter: "B" };

const LETTER_AXIS: Record<string, Axis> = { P: "persona", H: "hook", B: "body", A: "angle" };
const LETTER_PRODUCT: Record<string, FormulationProduct> = { M: "medadmin", B: "buchhalter" };
export const FORMULATION_CODE_RE = /^([MB])([PHBA])(\d{6})$/;

export interface Formulation {
  id: string;
  code: string;
  axis: Axis;
  product: FormulationProduct;
  text: string;
  textKey: string;
  source: string;
  legacyCode: string | null;
  firstAdName: string | null;
  note: string | null;
  parentCode: string | null;   // из какой формулировки отредактирована в ТЗ (039); родитель не меняется
  createdAt: string;
}

export type FormulationRow = {
  id: string; code: string; axis: Axis; product: FormulationProduct; text: string; text_key: string;
  source: string; legacy_code: string | null; first_ad_name: string | null; note: string | null; parent_code?: string | null; created_at: string;
};

export const FORMULATION_COLUMNS = "id, code, axis, product, text, text_key, source, legacy_code, first_ad_name, note, parent_code, created_at";

export function rowToFormulation(r: FormulationRow): Formulation {
  return {
    id: r.id, code: r.code, axis: r.axis, product: r.product, text: r.text, textKey: r.text_key,
    source: r.source, legacyCode: r.legacy_code, firstAdName: r.first_ad_name, note: r.note, parentCode: r.parent_code ?? null, createdAt: r.created_at,
  };
}

/** Ключ точного совпадения: NFC + trim + любые пробельные последовательности → один пробел. Больше ничего. */
export function textKey(text: string): string {
  return text.normalize("NFC").replace(/\s+/g, " ").trim();
}

export function isFormulationCode(code: string | null | undefined): boolean {
  return !!code && FORMULATION_CODE_RE.test(code.toUpperCase());
}

export function axisOfCode(code: string): Axis | null {
  const m = FORMULATION_CODE_RE.exec(code.toUpperCase());
  return m ? LETTER_AXIS[m[2]] : null;
}

export function productOfCode(code: string): FormulationProduct | null {
  const m = FORMULATION_CODE_RE.exec(code.toUpperCase());
  return m ? LETTER_PRODUCT[m[1]] : null;
}

/** Короткая подпись для таблиц: первые n символов текста. */
export function shortLabel(text: string, n = 90): string {
  const t = textKey(text);
  return t.length > n ? t.slice(0, n - 1).trimEnd() + "…" : t;
}

function randomCode(axis: Axis, product: FormulationProduct): string {
  const num = 100000 + Math.floor(Math.random() * 900000);
  return `${PRODUCT_LETTER[product]}${AXIS_LETTER[axis]}${num}`;
}

export interface EnsureInput {
  axis: Axis;
  product: FormulationProduct;
  text: string;
  source: string;
  legacyCode?: string | null;
  firstAdName?: string | null;
  note?: string | null;
  parentCode?: string | null;
}

/**
 * Находит формулировку по точному тексту (axis + product + text_key) или создаёт новую с уникальным кодом.
 * Никогда не «подбирает похожую» — только точное совпадение ключа.
 */
export async function ensureFormulation(sb: SupabaseClient, inp: EnsureInput): Promise<{ formulation: Formulation; created: boolean }> {
  const key = textKey(inp.text);
  if (!key) throw new Error("Пустая формулировка");
  const { data: found, error: findErr } = await sb.from("formulations").select(FORMULATION_COLUMNS)
    .eq("axis", inp.axis).eq("product", inp.product).eq("text_key", key).maybeSingle();
  if (findErr) throw new Error(findErr.message);
  if (found) return { formulation: rowToFormulation(found as FormulationRow), created: false };

  for (let attempt = 0; attempt < 8; attempt++) {
    const code = randomCode(inp.axis, inp.product);
    const { data, error } = await sb.from("formulations").insert({
      code, axis: inp.axis, product: inp.product, text: key, text_key: key, source: inp.source,
      legacy_code: inp.legacyCode ?? null, first_ad_name: inp.firstAdName ?? null, note: inp.note ?? null, parent_code: inp.parentCode ?? null,
    }).select(FORMULATION_COLUMNS).single();
    if (!error && data) return { formulation: rowToFormulation(data as FormulationRow), created: true };
    // 23505 — коллизия: либо кода (повторяем с новым), либо текста (кто-то успел вставить — перечитываем)
    if (error?.code === "23505") {
      const { data: again } = await sb.from("formulations").select(FORMULATION_COLUMNS)
        .eq("axis", inp.axis).eq("product", inp.product).eq("text_key", key).maybeSingle();
      if (again) return { formulation: rowToFormulation(again as FormulationRow), created: false };
      continue;
    }
    throw new Error(error?.message ?? "insert formulations failed");
  }
  throw new Error("Не удалось подобрать свободный код формулировки");
}

/** Все формулировки (страницами — PostgREST режет 1000 строк). */
export async function loadFormulations(sb: SupabaseClient, filter?: { axis?: Axis; product?: FormulationProduct | "all" }): Promise<Formulation[]> {
  const out: Formulation[] = [];
  for (let from = 0; ; from += 1000) {
    let q = sb.from("formulations").select(FORMULATION_COLUMNS).order("created_at").range(from, from + 999);
    if (filter?.axis) q = q.eq("axis", filter.axis);
    if (filter?.product && filter.product !== "all") q = q.eq("product", filter.product);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    out.push(...((data ?? []) as FormulationRow[]).map(rowToFormulation));
    if (!data || data.length < 1000) break;
  }
  return out;
}

export type LabelMap = Record<string, { name: string; color: string }>;

/** Подписи кодов для аналитики: формулировки (текст целиком) + концепции + актёры. */
export async function loadLabelMap(sb: SupabaseClient): Promise<LabelMap> {
  const [forms, conceptsRes, actorsRes] = await Promise.all([
    loadFormulations(sb),
    sb.from("concepts").select("code, name, color"),
    sb.from("actors").select("code, name"),
  ]);
  const map: LabelMap = {};
  for (const f of forms) map[f.code] = { name: f.text, color: AXIS_COLOR[f.axis] };
  for (const r of (conceptsRes.data ?? []) as { code: string | null; name: string; color: string | null }[]) if (r.code) map[r.code] = { name: r.name, color: r.color ?? "#7B8CDE" };
  for (const r of (actorsRes.data ?? []) as { code: string | null; name: string }[]) if (r.code) map[r.code] = { name: r.name, color: "#D9A86B" };
  return map;
}

// ── Результат дословного извлечения из креатива (Gemini) ─────────────────────
export interface VerbatimExtraction {
  persona_text: string | null;  // дословное обращение к аудитории; null если его нет
  hook_text: string | null;     // первые 3 секунды / первый экран дословно
  body_text: string | null;     // основной текст дословно (блоки через « | »)
  angle_text: string | null;    // дословная формулировка выгоды/оффера
  full_text: string;            // весь текст креатива дословно
  confidence: "high" | "medium" | "low";
  notes: string;
}

export const EXTRACTION_FIELD: Record<Axis, keyof VerbatimExtraction> = {
  persona: "persona_text", hook: "hook_text", body: "body_text", angle: "angle_text",
};

/** Привязывает извлечённые дословные тексты к объявлению: формулировки → коды → ad_name_mapping. */
export async function applyExtraction(
  sb: SupabaseClient, adName: string, product: FormulationProduct, ex: VerbatimExtraction,
  source: string, extra?: { format?: string | null; note?: string | null },
): Promise<{ codes: Record<Axis, string | null>; created: string[] }> {
  const codes: Record<Axis, string | null> = { persona: null, hook: null, body: null, angle: null };
  const created: string[] = [];
  for (const axis of AXES) {
    const raw = ex[EXTRACTION_FIELD[axis]];
    const text = typeof raw === "string" ? textKey(raw) : "";
    if (!text || /^\(без текста/i.test(text) || /^null$/i.test(text)) continue;
    const { formulation, created: isNew } = await ensureFormulation(sb, { axis, product, text, source, firstAdName: adName });
    codes[axis] = formulation.code;
    if (isNew) created.push(formulation.code);
  }
  const { data: prev } = await sb.from("ad_name_mapping").select("format, flow, concept_code, actor_code, note").eq("ad_name", adName).maybeSingle();
  const { error } = await sb.from("ad_name_mapping").upsert({
    ad_name: adName,
    persona_code: codes.persona, hook_code: codes.hook, body_code: codes.body, angle_code: codes.angle,
    format: extra?.format ?? prev?.format ?? null, flow: prev?.flow ?? null,
    concept_code: prev?.concept_code ?? null, actor_code: prev?.actor_code ?? null,
    product, mapped_by: source, mapped_at: new Date().toISOString(),
    note: extra?.note ?? `${source}: уверенность ${ex.confidence}${ex.notes ? ` · ${ex.notes.slice(0, 160)}` : ""}`,
  }, { onConflict: "ad_name" });
  if (error) throw new Error(error.message);
  return { codes, created };
}
