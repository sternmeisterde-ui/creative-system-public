// Нечёткое сравнение дословных текстов (06.11.2026, прокладка Google → коды).
// Расшифровки одного ролика расходятся в мелочах: «3.500 евро» / «3 500 €», «|» в разных местах, где кончается хук и
// начинается боди. Точное совпадение textKey для них даёт новые коды на тот же ролик — проверено на тесте
// (ролик с Татьяной: хук совпал, боди и энгл ушли в новые коды). Поэтому сравниваем нормализованный текст по триграммам.

export function normText(s: string): string {
  return s.toLowerCase().replace(/ё/g, "е")
    .replace(/€/g, " евро ").replace(/%/g, " процентов ")
    .replace(/(\d)[.\s ](?=\d{3}\b)/g, "$1")        // 3.500 / 3 500 → 3500
    .replace(/[^\p{L}\p{N}]+/gu, " ").replace(/\s+/g, " ").trim();
}

export function trigrams(s: string): Set<string> {
  const t = ` ${normText(s)} `; const out = new Set<string>();
  for (let i = 0; i + 3 <= t.length; i++) out.add(t.slice(i, i + 3));
  return out;
}

function inter(a: Set<string>, b: Set<string>): number { let n = 0; const [s, l] = a.size < b.size ? [a, b] : [b, a]; for (const x of s) if (l.has(x)) n++; return n; }

/** Dice по триграммам: 1 — одинаковый текст. */
export function dice(a: Set<string>, b: Set<string>): number { return a.size + b.size ? (2 * inter(a, b)) / (a.size + b.size) : 0; }

/** Доля текста `part`, найденная в `whole` (боди Meta внутри полной расшифровки Google с призывом и т.п.). */
export function containment(part: Set<string>, whole: Set<string>): number { return part.size ? inter(part, whole) / part.size : 0; }

/** Пороги, подобранные на расшифровках одного ролика: шум ≈ 0,9+, разные ролики одной темы ≤ 0,6. */
export const SAME_FORMULATION_MIN = 0.86;   // одна ось: формулировка та же
export const SAME_CREATIVE_MIN = 0.85;      // весь текст Meta-креатива содержится в расшифровке Google
export const SAME_CREATIVE_REVERSE_MIN = 0.55; // и расшифровка Google не намного длиннее (не другой ролик с цитатой)
