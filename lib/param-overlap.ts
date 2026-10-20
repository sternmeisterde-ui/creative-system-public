/**
 * Смысловой дубль формулировок внутри одного слота (20.10.2026, пак Мед ×20):
 * персона с баннера «Живёте в Германии | Немецкий от В1 | …» и боди «Первое. Вы живёте в Германии. | Второе. Немецкий у вас от B1…»
 * — один и тот же чек-лист. Промпт требовал озвучить оба дословно → список читался дважды.
 * Здесь считаем построчное покрытие персоны/энгла словами боди и хука; что покрыто — только плашка на экране, вслух не читать.
 */
const ACUTE = "́";
// Кириллические двойники латиницы в токенах с цифрами: «В1» и «B1», «С1» и «C1» — одно и то же
const HOMO: Record<string, string> = { а: "a", в: "b", с: "c", е: "e", н: "h", к: "k", м: "m", о: "o", р: "p", т: "t", х: "x" };

export function contentTokens(s: string): string[] {
  const plain = s.normalize("NFC").replace(new RegExp(ACUTE, "g"), "").toLowerCase().replace(/ё/g, "е");
  const raw = plain.match(/[a-zа-я0-9][a-zа-я0-9\-]*/g) ?? [];
  return raw
    .map(t => (/\d/.test(t) ? t.split("").map(ch => HOMO[ch] ?? ch).join("") : t))
    .filter(t => t.length >= 3 || /\d/.test(t))
    .map(t => (t.length > 5 ? t.slice(0, 5) : t)); // грубая основа: «живёте/живете», «учиться/учитесь», «месяцев/месяца»
}

/** Доля слов строки, которые есть в пуле (0..1); строки короче 2 слов не считаются. */
export function lineCoverage(line: string, pool: Set<string>): number {
  const toks = contentTokens(line);
  if (toks.length < 2) return 0;
  return toks.filter(t => pool.has(t)).length / toks.length;
}

export type OverlapVerdict = { covered: number; total: number; screenOnly: boolean; lines: string[] };

/** Покрытие формулировки (по строкам через «|») словами других формулировок слота. screenOnly — если покрыто ≥ половины строк. */
export function overlapAgainst(text: string, others: string[]): OverlapVerdict {
  const pool = new Set(others.flatMap(contentTokens));
  const lines = text.split(/\s*\|\s*/).map(l => l.trim()).filter(Boolean);
  const coveredLines = lines.filter(l => lineCoverage(l, pool) >= 0.5);
  return { covered: coveredLines.length, total: lines.length, screenOnly: lines.length > 0 && coveredLines.length * 2 >= lines.length, lines: coveredLines };
}

/** Пояснение для промпта: какие параметры слота звучат, а какие — только плашка. */
export function overlapNotes(p: { persona?: string | null; hook: string; body: string; angle: string }): { persona: OverlapVerdict | null; angle: OverlapVerdict; text: string } {
  const persona = p.persona ? overlapAgainst(p.persona, [p.hook, p.body]) : null;
  const angle = overlapAgainst(p.angle, [p.hook, p.body, ...(p.persona ? [p.persona] : [])]);
  const out: string[] = [];
  if (persona?.screenOnly) out.push(`ПЕРСОНА дублирует боди/хук по смыслу (${persona.covered} из ${persona.total} строк: ${persona.lines.map(l => `«${l}»`).join(", ")}) → вслух НЕ читать; это чек-лист на экране одной плашкой целиком в первые секунды, речь начинается сразу с хука.`);
  if (angle.screenOnly) out.push(`ЭНГЛ дублирует уже сказанное (${angle.covered} из ${angle.total} строк) → вслух НЕ читать; только плашка-итог на экране целиком (лимит «≤ 6 слов» на неё не действует).`);
  return { persona, angle, text: out.length ? `ДУБЛИ ВНУТРИ СЛОТА (посчитано кодом, выполнять обязательно):\n- ${out.join("\n- ")}` : "" };
}
