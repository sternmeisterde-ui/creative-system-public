/**
 * Грамматический род речи от первого лица (20.10.2026, пак Мед ×20, слот с боди «А потом посчитала…» и мужским актёром).
 * Консервативно: только явные формы прошедшего времени и кратких прилагательных первого лица из списка,
 * без общих паттернов на «-ла» (сила, школа, зарплата). Смешанные/диалоговые тексты → null.
 */
export type SpeechGender = "f" | "m";

const STEMS = ["был", "стал", "устал", "работал", "посчитал", "решил", "понял", "узнал", "подумал", "сказал", "получил", "закончил", "переехал", "остал", "смог", "нашёл|нашел|нашл", "пошёл|пошел|пошл", "пришёл|пришел|пришл", "учил", "выучил", "сдал", "начал", "попробовал", "записал", "прошёл|прошел|прошл", "искал", "хотел", "мог", "жил", "приехал", "бросил", "сидел", "мыл", "убирал", "увидел", "услышал", "поверил", "сделал", "открыл", "спросил", "ответил", "вспомнил", "ушёл|ушел|ушл", "вышел|вышл", "зашёл|зашел|зашл"];
const F_SHORT = ["сама", "одна", "рада", "готова", "уверена", "должна", "довольна", "благодарна", "замужем"];
const M_SHORT = ["сам", "один", "рад", "готов", "уверен", "должен", "доволен", "благодарен", "женат"];

function buildRegex(): { f: RegExp; m: RegExp } {
  const alts = STEMS.map(s => s.split("|"));
  // женский род: основа + «ла» / «лась»; мужской: основа + «л» / «лся» или форма с «ёл/ел» (нашёл, пошёл)
  const f = alts.flatMap(a => a.map(st => st.replace(/(ёл|ел|л)$/, "") + "ла(?:сь)?"));
  const m = alts.flatMap(a => a.map(st => (/(ёл|ел)$/.test(st) ? st + "(?:ся)?" : st.replace(/л$/, "") + "л(?:ся)?")));
  const wrap = (xs: string[]) => new RegExp(`(?:^|[^а-яё])(?:${Array.from(new Set(xs)).join("|")})(?=$|[^а-яё])`, "giu");
  return { f: wrap([...f, ...F_SHORT]), m: wrap([...m, ...M_SHORT]) };
}
const RX = buildRegex();
const ACUTE = "́";

/** Число женских и мужских маркеров первого лица в тексте. */
export function genderMarkers(text: string): { f: number; m: number } {
  const t = text.normalize("NFC").replace(new RegExp(ACUTE, "g"), "").toLowerCase();
  // речь от первого лица: без «я/мне/меня/мой» маркеры могут описывать третье лицо («она посчитала») — тогда не считаем
  const firstPerson = /(^|[^а-яё])(я|мне|меня|мной|мой|моя|моё|мои)(?=$|[^а-яё])/u.test(t);
  const thirdPerson = /(^|[^а-яё])(она|он|они|его|её|ее)(?=$|[^а-яё])/u.test(t);
  if (!firstPerson && thirdPerson) return { f: 0, m: 0 };
  return { f: (t.match(RX.f) ?? []).length, m: (t.match(RX.m) ?? []).length };
}

/** Род говорящего по тексту: "f" / "m", если маркеры только одного рода; null — нет маркеров или смешано (диалог). */
export function detectSpeechGender(text: string): SpeechGender | null {
  const { f, m } = genderMarkers(text);
  if (f > 0 && m === 0) return "f";
  if (m > 0 && f === 0) return "m";
  return null;
}

/** Род набора формулировок слота (персона/хук/боди/энгл): первый однозначный; при конфликте между формулировками — null + флаг. */
export function formulationsGender(texts: Array<string | null | undefined>): { gender: SpeechGender | null; conflict: boolean } {
  const gs = texts.filter((t): t is string => !!t).map(detectSpeechGender).filter((g): g is SpeechGender => !!g);
  const set = new Set(gs);
  if (set.size > 1) return { gender: null, conflict: true };
  return { gender: gs[0] ?? null, conflict: false };
}

export const genderLabel = (g: SpeechGender) => (g === "f" ? "женского" : "мужского");
