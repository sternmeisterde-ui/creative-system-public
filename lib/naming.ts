import { supabase } from "./supabase";
import { brief, getFlows } from "./brief";
import { FORMULATION_CODE_RE, axisOfCode, isFormulationCode } from "./formulations";

// ── Префиксы параметров (из brief.config.ts) ─────────────────────────────────
// Сохраняем плюральные ключи под имена таблиц (personas/hooks/bodies/angles),
// чтобы не ломать существующий код. Сами буквы (P/H/B/A) и порядок берём из brief.
export const CODE_PREFIX = Object.fromEntries(
  brief.creative_matrix.params.map(p => [`${p.key}s`, p.letter])
) as Record<string, string>;

export type ParamTable = string;  // 'personas' | 'hooks' | 'bodies' | 'angles' | ...

const PARAM_KEYS_IN_ORDER = brief.creative_matrix.params.map(p => p.key);
const LETTER_TO_KEY: Record<string, string> = Object.fromEntries(
  brief.creative_matrix.params.map(p => [p.letter, p.key])
);
const FLOW_CODES = getFlows().map(f => f.code.toUpperCase());

// ── Формат имени объявления ───────────────────────────────────────────────────
// Новый (06.10.2026): MP483920-MH120394-MB558201-MA903311-V19-UGC — коды формулировок (lib/formulations.ts)
// Старый: P2-H1-B3-A5-UGC-COM — парсер понимает

export interface AdNameParts {
  personaCode:  string | null;  // P2
  hookCode:     string | null;  // H1
  bodyCode:     string | null;  // B3
  angleCode:    string | null;  // A5
  conceptCode:  string | null;  // V12 — концепция видео (type of video)
  actorCode:    string | null;  // ANNA / WOM1987 — конкретный актёр
  format:       string | null;  // UGC
  flow:         string | null;  // устаревший хвост COM/GOV в старых именах; в новых именах нет
}

export interface AdNameMapping {
  adName:      string;
  personaCode: string | null;
  hookCode:    string | null;
  bodyCode:    string | null;
  angleCode:   string | null;
  format:      string | null;
  flow:        string | null;
  conceptCode?: string | null;
  actorCode?:   string | null;
}

// Актёр в имени: ИИ-персонажи WOM1987 / MAN17645, реальные — из brief.creative_matrix.real_actor_codes.
const REAL_ACTOR_CODES = new Set((brief.creative_matrix.real_actor_codes ?? []).map(c => c.toUpperCase()));
export function isActorCode(token: string): boolean {
  const t = token.toUpperCase();
  return /^(WOM|MAN)\d+$/.test(t) || REAL_ACTOR_CODES.has(t);
}

/**
 * Сначала пробует стандартный parseAdName, при отсутствии кодов — ищет в маппинге.
 */
/** Имя без суффиксов дублирования Meta: « - Copy», « - Copy 2», « (1)», « - копия», «_copy2». Копия = тот же креатив. */
export function baseAdName(adName: string): string {
  let s = adName.trim(); let prev = "";
  while (s !== prev) { prev = s; s = s.replace(/\s*[-–—]\s*Copy(\s*\d+)?$/i, "").replace(/\s*\(\d+\)$/, "").replace(/\s*[-–—]\s*копия(\s*\d+)?$/i, "").replace(/_copy\d*$/i, "").trim(); }
  return s;
}

export function parseAdNameWithMapping(
  adName: string,
  mapping: AdNameMapping[]
): AdNameParts {
  const parts = parseAdName(adName);
  const key = adName.trim().toLowerCase();
  const baseKey = baseAdName(adName).toLowerCase();
  // точное имя, иначе базовое без суффикса копии (« - Copy» и т.п. — тот же креатив)
  const mapped = mapping.find(m => m.adName.trim().toLowerCase() === key) ?? (baseKey !== key ? mapping.find(m => m.adName.trim().toLowerCase() === baseKey) : undefined);
  if (!mapped) return parts;

  // Маппинг с кодами ФОРМУЛИРОВОК всегда сильнее догадки по имени: в старых именах встречаются обрывки
  // вроде «B2» (уровень немецкого), «A2_billboard», «P05», которые парсер принимает за коды параметров.
  const mappedHasFormulations = [mapped.personaCode, mapped.hookCode, mapped.bodyCode, mapped.angleCode].some(isFormulationCode);
  const nameHasFormulations = [parts.personaCode, parts.hookCode, parts.bodyCode, parts.angleCode].some(isFormulationCode);
  if (!mappedHasFormulations || nameHasFormulations) {
    // Старое поведение: коды из имени приоритетнее; концепция и актёр — из имени, иначе из маппинга.
    if (parts.personaCode || parts.hookCode || parts.bodyCode || parts.angleCode) {
      return { ...parts, conceptCode: parts.conceptCode ?? mapped.conceptCode ?? null, actorCode: parts.actorCode ?? mapped.actorCode ?? null };
    }
  }
  return {
    personaCode: mapped.personaCode,
    hookCode:    mapped.hookCode,
    bodyCode:    mapped.bodyCode,
    angleCode:   mapped.angleCode,
    conceptCode: parts.conceptCode ?? mapped.conceptCode ?? null,
    actorCode:   parts.actorCode ?? mapped.actorCode ?? null,
    format:      mapped.format ?? parts.format,
    flow:        mapped.flow ?? parts.flow,
  };
}

const FORMAT_VALUES = brief.creative_matrix.formats.map(f => f.toUpperCase());

/**
 * Разбирает имя объявления и извлекает коды параметров.
 * Формат и список параметров задаются в brief.config.ts.
 * Пример: P2-H1-B3-A5-UGC-COM
 */
export function parseAdName(adName: string): AdNameParts {
  const parts = adName.toUpperCase().split(/[-_\s]+/);

  const result: AdNameParts = {
    personaCode: null, hookCode: null, bodyCode: null, angleCode: null,
    conceptCode: null, actorCode: null,
    format: null, flow: null,
  };
  // dynamic codes — на случай custom param keys
  const dynamicCodes: Record<string, string | null> = {};

  for (const part of parts) {
    // Код формулировки (06.10.2026): {M|B}{P|H|B|A}{6 цифр} — уникальная дословная формулировка.
    if (FORMULATION_CODE_RE.test(part)) {
      const axis = axisOfCode(part);
      if (axis) { (result as unknown as Record<string, string | null>)[`${axis}Code`] = part; continue; }
    }
    // Старый формат: буква + число (P3, H1, V12 …) по brief
    const letterMatch = part.match(/^([A-Z])(\d+)$/);
    if (letterMatch) {
      const letter = letterMatch[1];
      const key = LETTER_TO_KEY[letter];
      if (key) {
        const fieldName = `${key}Code`;
        if (fieldName in result) {
          (result as unknown as Record<string, string | null>)[fieldName] = part;
        } else {
          dynamicCodes[fieldName] = part;
        }
        continue;
      }
    }
    if (FORMAT_VALUES.includes(part)) { result.format = part; continue; }
    if (FLOW_CODES.includes(part))    { result.flow = part.toLowerCase(); continue; }
    if (isActorCode(part))            { result.actorCode = part; continue; }
  }

  return result;
}

// Список ключей параметров в порядке brief — используется внешними потребителями.
export function getParamKeysInOrder(): string[] {
  return PARAM_KEYS_IN_ORDER;
}

/**
 * Строит имя объявления из кодов параметров.
 * P2-H1-B3-A5-V12-ANNA-UGC  (концепция V{n} и актёр — опциональны)
 * С 28.09.2026 креативы не делятся на потоки (COM/GOV): хвост потока в имени
 * больше не пишется. Парсер старые имена с COM/GOV на конце понимает (parseAdName).
 */
export function buildAdName(
  personaCode: string,
  hookCode: string,
  bodyCode: string,
  angleCode: string,
  format: string,
  _flow?: string | null,
  conceptCode?: string | null,
  actorCode?: string | null
): string {
  // Персона может отсутствовать (нет прямого обращения к аудитории) — пустые коды пропускаем.
  return [
    personaCode?.toUpperCase(),
    hookCode?.toUpperCase(),
    bodyCode?.toUpperCase(),
    angleCode?.toUpperCase(),
    ...(conceptCode ? [conceptCode.toUpperCase()] : []),
    ...(actorCode ? [actorCode.toUpperCase()] : []),
    format.toUpperCase(),
  ].filter(Boolean).join("-");
}

/**
 * Получает следующий свободный код для таблицы параметров.
 * Например: если есть P1, P2, P4 → вернёт P3 (первый пропуск) или P5 (следующий)
 */
export async function getNextCode(table: ParamTable): Promise<string> {
  const prefix = CODE_PREFIX[table];
  const { data } = await supabase
    .from(table)
    .select("code")
    .not("code", "is", null)
    .order("code");

  const existing = (data ?? [])
    .map(r => r.code as string)
    .filter(Boolean)
    .map(c => parseInt(c.replace(prefix, ""), 10))
    .filter(n => !isNaN(n))
    .sort((a, b) => a - b);

  // Найти первый пропуск или взять следующий после максимального
  let next = 1;
  for (const n of existing) {
    if (n === next) next++;
    else break;
  }

  return `${prefix}${next}`;
}

/**
 * Автоматически назначает коды всем параметрам без кода.
 * Вызывать один раз при миграции существующих данных.
 */
export async function assignMissingCodes(): Promise<Record<string, number>> {
  const counts: Record<string, number> = Object.fromEntries(
    Object.keys(CODE_PREFIX).map(k => [k, 0])
  );

  for (const table of Object.keys(CODE_PREFIX) as ParamTable[]) {
    const prefix = CODE_PREFIX[table];

    // Берём все без кода
    const { data } = await supabase
      .from(table)
      .select("id, code")
      .is("code", null)
      .order("created_at");

    if (!data || data.length === 0) continue;

    // Берём максимальный существующий номер
    const { data: existing } = await supabase
      .from(table)
      .select("code")
      .not("code", "is", null);

    const maxNum = (existing ?? [])
      .map(r => parseInt((r.code as string).replace(prefix, ""), 10))
      .filter(n => !isNaN(n))
      .reduce((max, n) => Math.max(max, n), 0);

    let counter = maxNum;
    for (const row of data) {
      counter++;
      const code = `${prefix}${counter}`;
      await supabase.from(table).update({ code }).eq("id", row.id);
      counts[table]++;
    }
  }

  return counts;
}

/**
 * Разбирает имя объявления и возвращает UUID параметров (через коды).
 */
export async function resolveAdName(adName: string): Promise<{
  personaId: string | null;
  hookId:    string | null;
  bodyId:    string | null;
  angleId:   string | null;
  format:    string | null;
  flow:      string | null;
}> {
  const parts = parseAdName(adName);

  const [personas, hooks, bodies, angles] = await Promise.all([
    parts.personaCode
      ? supabase.from("personas").select("id").eq("code", parts.personaCode).single()
      : Promise.resolve({ data: null }),
    parts.hookCode
      ? supabase.from("hooks").select("id").eq("code", parts.hookCode).single()
      : Promise.resolve({ data: null }),
    parts.bodyCode
      ? supabase.from("bodies").select("id").eq("code", parts.bodyCode).single()
      : Promise.resolve({ data: null }),
    parts.angleCode
      ? supabase.from("angles").select("id").eq("code", parts.angleCode).single()
      : Promise.resolve({ data: null }),
  ]);

  return {
    personaId: (personas.data as { id: string } | null)?.id ?? null,
    hookId:    (hooks.data as { id: string } | null)?.id ?? null,
    bodyId:    (bodies.data as { id: string } | null)?.id ?? null,
    angleId:   (angles.data as { id: string } | null)?.id ?? null,
    format:    parts.format?.toLowerCase() ?? null,
    flow:      parts.flow ?? null,
  };
}
