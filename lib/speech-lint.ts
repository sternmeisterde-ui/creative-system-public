// ── Линтер живой речи (порт .claude/skills/ru-video-brief/scripts/check_brief.py на TS) ──────
// Проверяет речь сценария против норм корпуса ru-reels (lib/speech-rules.json): длина реплик, начала,
// заполнители, адресат, «я», бан-слова и замены, триады, «не просто…, а», «который», ИИ-штампы, хук, призыв,
// ударения в трудных словах. Без морфологии (причастия по Ожегову — только в python-версии скилла).
// Используется гейтом в /api/ai/generate-briefs: красные пункты → один проход правки, итог — блок «Проверка речи».
import rules from "./speech-rules.json";
import { contentTokens } from "./param-overlap";

export interface SpeechLintReport {
  words: number;
  durationSec: number;
  sentMedian: number | null;
  sentLe5Share: number | null;
  sentGe20Share: number | null;
  startersShare: number | null;
  fillersPer100: number;
  ty: number;
  vy: number;
  yaPer100: number;
  banHits: string[];
  triads: number;
  missingStress: string[];
  issues: string[];   // красные — исправлять обязательно
  warns: string[];    // жёлтые — исправить или объяснить
}

const ACUTE = "́";
const TOK = /[а-яёА-ЯЁ][а-яёА-ЯЁ\-́]*/g;
const FILLERS = ["ну", "вот", "короче", "типа", "как бы", "слушай", "слушайте", "смотри", "смотрите", "в общем", "значит", "это самое", "блин", "честно", "прям", "реально", "кстати", "знаете", "знаешь", "так вот", "по факту", "на самом деле", "ладно", "получается", "в смысле"];
const TY = ["ты", "тебя", "тебе", "тобой", "твой", "твоя", "твои", "твоё", "твое", "твоей", "твою"];
const VY = ["вы", "вас", "вам", "вами", "ваш", "ваша", "ваши", "ваше", "вашей", "вашу"];
const YA = ["я", "мне", "меня", "мной", "мой", "моя", "мои", "моё", "мое", "моей", "мою"];
const TY_IMP = /(?<![а-яё])(смотри|слушай|представь|знаешь|понимаешь|давай|напиши|скажи|попробуй|возьми|иди|стой|видишь|подумай|запомни|сохрани|подпишись|пиши)(?![а-яё])/g;
const VY_IMP = /(?<![а-яё])(смотрите|слушайте|представьте|знаете|понимаете|давайте|напишите|скажите|попробуйте|возьмите|идите|видите|подумайте|запомните|сохраните|подпишитесь|пишите)(?![а-яё])/g;

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const median = (a: number[]) => { const s = [...a].sort((x, y) => x - y); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

/** Речь из брифа: 2-я колонка строк таблицы «Сценарий» (начинаются с таймкода) или раздел «Сценарий/Речь», иначе весь текст. */
// Ячейки таблицы режем по НЕэкранированным «|»: внутри реплик и плашек стоит «\|» (строки боди через « | »), иначе колонки съезжают и линтер читает не ту ячейку (баг 19.10.2026: 178 слов считались как 121, перебор бюджета не ловился).
export function extractSpeech(text: string): string {
  const rows: string[] = [];
  let col = 1; // колонка реплики: по заголовку «Реплика», иначе вторая
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("|") || /^\|\s*[-:| ]+\|?\s*$/.test(t)) continue;
    const cells = t.replace(/^\||\|$/g, "").split(/(?<!\\)\|/).map(c => c.replace(/\\\|/g, "|").trim());
    const hdr = cells.findIndex(c => /^реплик/i.test(c));
    if (hdr >= 0) { col = hdr; continue; }
    if (cells.length >= 2 && /^\d{1,2}:\d{2}/.test(cells[0])) rows.push((cells[col] ?? cells[1] ?? "").replace(/^[А-ЯЁA-Z][А-ЯЁA-Zа-яё]{1,14}:\s*/, ""));
  }
  if (rows.length) return rows.join(" ");
  const m = /##+\s*(Сценарий|Речь|Текст)[^\n]*\n([\s\S]*?)(?=\n##+\s|$)/i.exec(text);
  if (m) return m[2].replace(/\|[^|\n]*\|/g, " ");
  return text;
}

export function lintSpeech(speechRaw: string, opts?: { wpm?: number; dialog?: boolean; protectedTexts?: string[] }): SpeechLintReport {
  const wpm = opts?.wpm ?? 130;
  // Неизменяемые формулировки (параметры) из проверки слов исключаем — их править нельзя
  let speech = speechRaw;
  for (const p of opts?.protectedTexts ?? []) if (p) speech = speech.split(p.normalize("NFC")).join(" ");
  const plain = speech.replace(new RegExp(ACUTE, "g"), "");
  const toks = (plain.match(TOK) ?? []).map(t => t.toLowerCase());
  const n = toks.length;
  const sents = plain.split(/(?<=[.!?…])\s+|\n+/).map(s => s.trim()).filter(s => /[а-яёА-ЯЁ]/.test(s));
  const lens = sents.map(s => (s.match(TOK) ?? []).length);
  const low = ` ${toks.join(" ")} `;
  const issues: string[] = [], warns: string[] = [];
  const rep: SpeechLintReport = {
    words: n, durationSec: n ? Math.round((n / wpm) * 600) / 10 : 0, sentMedian: null, sentLe5Share: null, sentGe20Share: null, startersShare: null,
    fillersPer100: 0, ty: 0, vy: 0, yaPer100: 0, banHits: [], triads: 0, missingStress: [], issues, warns,
  };
  if (n === 0) { issues.push("речь не найдена: нужна таблица «Сценарий» с таймкодами в 1-й колонке и репликами во 2-й"); return rep; }

  // Предложения
  if (lens.length) {
    rep.sentMedian = median(lens);
    rep.sentLe5Share = Math.round(lens.filter(l => l <= 5).length / lens.length * 100);
    rep.sentGe20Share = Math.round(lens.filter(l => l >= 20).length / lens.length * 100);
    if (rep.sentMedian > 9) issues.push(`предложения длинные: медиана ${rep.sentMedian} слов (в живой речи 6)`);
    else if (rep.sentMedian < 4) warns.push(`предложения очень короткие: медиана ${rep.sentMedian} (норма 6)`);
    if (rep.sentLe5Share < 30) issues.push(`мало коротких реплик: ${rep.sentLe5Share}% ≤5 слов (в речи 48%)`);
    if (rep.sentGe20Share > 12) issues.push(`много длинных: ${rep.sentGe20Share}% ≥20 слов (в речи 5%)`);
    const maxLen = Math.max(...lens);
    if (maxLen > 28) warns.push(`самое длинное предложение ${maxLen} слов — разбить`);
    const starters = sents.filter(s => /^(и|а|ну|вот|да)(?![а-яёА-ЯЁ])/i.test(s)).length;
    rep.startersShare = Math.round(starters / sents.length * 100);
    const q = (plain.match(/\?/g) ?? []).length;
    if (q / n * 100 > 3) warns.push(`вопросов ${q} на ${n} слов — многовато (норма ~1 на 100)`);
  }

  // Заполнители
  const fillers = FILLERS.reduce((a, f) => a + low.split(` ${f} `).length - 1, 0);
  rep.fillersPer100 = Math.round(fillers / n * 1000) / 10;
  if (n >= 40) {
    if (rep.fillersPer100 < 0.5) issues.push(`заполнителей ${rep.fillersPer100}/100 — звучит как читка (норма 1–2: ну, короче, честно)`);
    else if (rep.fillersPer100 > 4) warns.push(`заполнителей ${rep.fillersPer100}/100 — много (правка редактора 11.10: 1–2 на 100, не больше одного на реплику)`);
  }
  // Эхо-повторы ради эмоции («прям… прям», «много, много», «Тысячи. Тысячи.») — максимум один на ролик; отдельное «Вот.» — не начало реплики
  const echo = (plain.toLowerCase().match(/(?<![а-яё])([а-яё]{3,})(?:[\s,.!…—–-]+)(?:[а-яё]{1,3}\s+)?\1(?![а-яё])/g) ?? []).length;
  if (echo > 1) warns.push(`эхо-повторов ${echo} («прям… прям», «много, много») — оставить максимум один`);
  const vot = sents.filter(s => /^вот[.!…]$/i.test(s.trim())).length;
  if (vot) warns.push(`реплики, начинающиеся с отдельного «Вот.» — ${vot}; убрать`);
  const transcribed = plain.match(/(?<![а-яё])(а-два|бэ-один|бэ-два|цэ-один|эс-эн-гэ|да-тэ-эф)(?![а-яё])/gi) ?? [];
  if (transcribed.length) warns.push(`транскрипция аббревиатур (${Array.from(new Set(transcribed.map(t => t.toLowerCase()))).join(", ")}) — писать как есть: A2, B1, СНГ`);

  // Адресат и «я»
  const cnt = (ws: string[]) => ws.reduce((a, w) => a + low.split(` ${w} `).length - 1, 0);
  rep.ty = cnt(TY) + (low.match(TY_IMP) ?? []).length;
  rep.vy = cnt(VY) + (low.match(VY_IMP) ?? []).length;
  rep.yaPer100 = Math.round(cnt(YA) / n * 1000) / 10;
  if (rep.ty && rep.vy && !opts?.dialog && Math.min(rep.ty, rep.vy) / Math.max(rep.ty, rep.vy) > 0.25) issues.push(`смешано «ты» (${rep.ty}) и «вы» (${rep.vy}) — выбрать одно`);
  if (!rep.ty && !rep.vy) issues.push("нет адресата: ни «ты», ни «вы», ни императива 2-го лица");
  if (n >= 40 && rep.yaPer100 < 1) warns.push(`«я/мне/меня» ${rep.yaPer100}/100 — говорящего нет в тексте (в корпусе медиана 3)`);

  // Бан-слова и замены
  const prefer = rules.prefer_map as Record<string, string>;
  const hits = new Set<string>();
  for (const b of [...rules.ban_words, ...Object.keys(prefer)]) {
    const bb = b.toLowerCase();
    const found = bb.includes(" ") ? low.includes(bb) : new RegExp(`(?<![а-яё])${esc(bb)}`).test(low);
    if (found) hits.add(`${b} → ${prefer[b] ?? "убрать / сказать проще"}`);
  }
  rep.banHits = [...hits].sort();
  if (rep.banHits.length) issues.push("книжные/ИИ-слова: " + rep.banHits.slice(0, 12).join("; "));

  // ИИ-конструкции
  let triads = 0;
  for (const s of sents) for (const clause of s.split(/[;:]/)) {
    if (clause.includes(",") && /\sи\s/.test(clause)) { const items = clause.split(/,|\sи\s/).filter(x => x.trim()); if (items.length === 3) triads++; }
  }
  rep.triads = triads;
  if (triads >= 2) issues.push(`перечислений по три: ${triads} — в живой речи триады редки, оставить одно или разбить`);
  const np = (low.match(/не просто[^.!?]{0,40},\s*а(?![а-яё])/g) ?? []).length;
  if (np) warns.push(`«не просто…, а…» ×${np} — ИИ-каркас, в речи редок`);
  const kot = (low.match(/(?<![а-яё])котор(ый|ая|ое|ые|ого|ому|ом|ой|ую|ых|ым|ыми)(?![а-яё])/g) ?? []).length;
  if (kot > Math.max(2, Math.floor(n / 60))) warns.push(`«который» ×${kot} — многовато, дробить на реплики`);
  if (/важно (отметить|понимать|помнить)|давайте разбер[её]мся|в современном мире/.test(low)) issues.push("ИИ-штамп: «важно отметить/понимать», «давайте разберёмся», «в современном мире»");

  // Хук: первая фраза ≤ 12 слов, без приветствия/анонса
  const first = sents[0] ?? "";
  const firstLen = (first.match(TOK) ?? []).length;
  if (firstLen > 12) issues.push(`хук ${firstLen} слов — первая фраза должна быть ≤ 12`);
  if (/^(всем привет|привет|здравствуйте|меня зовут|в этом видео|сегодня я расскажу|сегодня поговорим)/i.test(first.trim())) issues.push("хук начинается с приветствия/анонса — так не говорят сильные ролики");

  // Призыв
  if (/перейди(те)? по ссылке|ссылк[аеиу] в (описании|шапке|профиле|био)|жми(те)? на ссылку/.test(low)) issues.push("призыв «переходи по ссылке» — по вовлечению проигрывает в разы; комментарий, подписка, директ или панч");
  if (/сохрани(те)? (это )?видео|сохраняй(те)?(?![а-яё])/.test(low)) warns.push("призыв «сохрани» — слабый (4/23 в корпусе), заменить");

  // Ударения в трудных словах и заимствованиях (знак U+0301 должен стоять)
  const trouble = { ...(rules.stress_trouble as Record<string, string>), ...(rules.stress_loans as Record<string, string>) };
  const withAcute = new Set((speech.match(TOK) ?? []).filter(t => t.includes(ACUTE)).map(t => t.replace(new RegExp(ACUTE, "g"), "").toLowerCase()));
  const missing = Object.keys(trouble).filter(w => toks.includes(w.toLowerCase()) && !withAcute.has(w.toLowerCase()));
  rep.missingStress = missing.slice(0, 12);
  if (missing.length) warns.push(`нет знака ударения в трудных словах: ${missing.slice(0, 8).map(w => `${w} → ${trouble[w]}`).join(", ")}`);

  return rep;
}

/** Сменяемость кадров: две подряд сцены с одинаковой локацией/фоном/планом — красный пункт (роняет досматриваемость). */
export function lintScenes(fullBrief: string): string[] {
  const sec = /##\s*СЦЕНАРИЙ[^\n]*\n([\s\S]*?)(?=\n##\s|$)/i.exec(fullBrief)?.[1] ?? "";
  const rows: string[][] = [];
  let sceneCol = 1;
  for (const line of sec.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("|") || /^\|\s*[-:| ]+\|?\s*$/.test(t)) continue;
    const cells = t.replace(/^\||\|$/g, "").split(/(?<!\\)\|/).map(c => c.replace(/\\\|/g, "|").trim());
    const hdr = cells.findIndex(c => /^сцена/i.test(c));
    if (hdr >= 0) { sceneCol = hdr; continue; }
    if (/^\d{1,2}:\d{2}/.test(cells[0] ?? "")) rows.push(cells);
  }
  const issues: string[] = [];
  if (rows.length < 2) return issues;
  const norm = (s: string) => s.toLowerCase().replace(/[^а-яёa-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  const words = (s: string) => new Set(norm(s).split(" ").filter(w => w.length > 3));
  let repeats = 0;
  for (let i = 1; i < rows.length; i++) {
    const a = words(rows[i - 1][sceneCol] ?? ""), b = words(rows[i][sceneCol] ?? "");
    if (!a.size || !b.size) continue;
    const inter = [...a].filter(w => b.has(w)).length;
    const sim = inter / Math.min(a.size, b.size);
    if (sim >= 0.8) repeats++;
  }
  if (repeats) issues.push(`кадры повторяются: ${repeats} пар(ы) подряд идущих сцен с той же локацией/фоном/планом — смени план/ракурс или локацию`);
  const total = rows.length;
  const last = rows[rows.length - 1][0] ?? "";
  const m = /(\d{1,2}):(\d{2})\s*[–-]\s*(\d{1,2}):(\d{2})/.exec(last);
  const endSec = m ? Number(m[3]) * 60 + Number(m[4]) : 0;
  // Каденция: смена кадра каждые 5–7 с (правка 19.10.2026: 3-секундные сцены дробили мысль в кашу)
  if (endSec >= 20) {
    const avg = endSec / total;
    if (avg < 4) issues.push(`монтаж дробный: ${total} сцен на ${endSec} с (${avg.toFixed(1)} с/сцена) — нужна смена кадра каждые 5–7 с, одна мысль на сцену (${Math.round(endSec / 6)}±1 сцен)`);
    else if (avg > 9) issues.push(`сцены затянуты: ${avg.toFixed(1)} с/сцена — смена кадра каждые 5–7 с`);
  }
  // Бюджет слов: ≤ 2.2 слова/с (130 сл/мин). Реплика — колонка «Реплика» (по заголовку), иначе 4-я
  const speechCol = (() => { for (const line of sec.split("\n")) { const t = line.trim(); if (!t.startsWith("|")) continue; const cells = t.replace(/^\||\|$/g, "").split(/(?<!\\)\|/).map(c => c.replace(/\\\|/g, "|").trim()); const h = cells.findIndex(c => /^реплик/i.test(c)); if (h >= 0) return h; } return 3; })();
  const speech = rows.map(r => (r[speechCol] ?? "").replace(/\u0301/g, "")).join(" ");
  const nWords = (speech.match(/[а-яёА-ЯЁa-zA-Z0-9]+/g) ?? []).length;
  if (endSec >= 20 && nWords > endSec * 2.2 * 1.1) issues.push(`слов больше бюджета: ${nWords} слов на ${endSec} с (≈${Math.round(nWords / 2.2)} с речи при 130 сл/мин) — вырезать связки/итоги/повторы или поднять хронометраж до 60 с`);
  // Повтор мысли: одно и то же предложение (≥3 значимых слов) в разных местах речи — не только дословно, но и перефразом
  // («Немецкий от В1» ↔ «Немецкий у вас от B1»: вложенность слов ≥ 0.8; правка 20.10.2026, чек-лист персоны читался дважды)
  const sentRaw = speech.split(/[.!?…]+/).map(s => s.trim()).filter(Boolean);
  const sentToks = sentRaw.map(s => contentTokens(s)).filter(t => t.length >= 3);
  const dupPairs: string[] = [];
  for (let i = 0; i < sentToks.length; i++) for (let j = i + 1; j < sentToks.length; j++) {
    const a = new Set(sentToks[i]), b = new Set(sentToks[j]);
    const inter = [...a].filter(t => b.has(t)).length;
    if (inter / Math.min(a.size, b.size) >= 0.8) { dupPairs.push(sentToks[i].join(" ")); break; }
  }
  if (dupPairs.length) issues.push(`повтор мысли: ${dupPairs.length} фраз(ы) звучат дважды — дословно или другими словами («${dupPairs[0].slice(0, 50)}…») — одна мысль звучит один раз; персона или энгл, повторяющие боди, идут только плашкой на экране`);
  return issues;
}

/** Блок «Проверка речи» для вставки в бриф. */
export function formatLintBlock(r: SpeechLintReport, pass: number): string {
  const line = (k: string, v: string) => `- ${k}: ${v}`;
  return [
    "## ПРОВЕРКА РЕЧИ (линтер корпуса ru-reels)",
    line("слов / длительность при 130 сл/мин", `${r.words} / ~${r.durationSec} с`),
    line("предложения", `медиана ${r.sentMedian ?? "—"}, ≤5 слов ${r.sentLe5Share ?? "—"}%, ≥20 слов ${r.sentGe20Share ?? "—"}%`),
    line("начала с и/а/ну/вот/да", `${r.startersShare ?? "—"}%`),
    line("заполнители /100", `${r.fillersPer100}`),
    line("обращение", `ты ${r.ty} / вы ${r.vy} · «я» /100: ${r.yaPer100}`),
    line("бан-слова", r.banHits.length ? r.banHits.join("; ") : "нет"),
    line("триады", String(r.triads)),
    line("ударения", r.missingStress.length ? `не расставлены: ${r.missingStress.join(", ")}` : "расставлены"),
    line("итог", r.issues.length ? `❌ ${r.issues.length} красных после ${pass} прохода(ов): ${r.issues.join(" · ")}` : `✅ 0 красных (${pass} проход${pass > 1 ? "а" : ""})`),
    ...(r.warns.length ? [line("жёлтые", r.warns.join(" · "))] : []),
  ].join("\n");
}
