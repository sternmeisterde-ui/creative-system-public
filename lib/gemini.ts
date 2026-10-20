import { getAiContext } from "@/lib/brief";
import type { VerbatimExtraction } from "@/lib/formulations";

// Переиспользуемые helpers для Gemini Vision (Files API) + резолв видео из Meta.
// Используется батч-разбором креативов (/api/gemini/batch).

const GEMINI_API_KEY = process.env.GEMINI_API_KEY!;
const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";
const FILES_API = "https://generativelanguage.googleapis.com/upload/v1beta/files";
const META_TOKEN = process.env.META_ACCESS_TOKEN!;

// Структурное ОПИСАНИЕ креатива для аналитики (не оценки) — кормит контекст отчёта.
const DESC_PROMPT = `Контекст: рекламный креатив.\n\n${getAiContext()}

Опиши ЭТОТ креатив МАКСИМАЛЬНО ПОДРОБНО и фактологически — так, чтобы по описанию можно было ВОСПРОИЗВЕСТИ исполнение (для размножения виннеров). Без оценок 1-10, без маркетинга, только факты о содержании.

1. ФОРМАТ/ТИП: видео или статика; UGC / студия / анимация / talking-head / интервью / квиз-карточка / скринкаст и т.п.
2. ПЕРСОНАЖ/СПИКЕР (если есть): пол, примерный возраст, этничность и внешность, одежда, эмоция, манера речи; РЕАЛЬНЫЙ человек или AI-сгенерированный/синтетический. Фиксируй точно — это часто и есть причина успеха.
3. СЦЕНА/ЛОКАЦИЯ: где происходит, фон, предметы, освещение, цветовая гамма.
4. ЧТО ПРОИСХОДИТ: для ВИДЕО — по сценам/таймингу (начало/середина/конец, действия, смена планов, движение камеры); для СТАТИКИ — композиция (что вверху/центре/внизу).
5. ХУК (первые 3 сек / первый экран): дословно что показано и сказано.
6. ТЕКСТ НА ЭКРАНЕ / РЕЧЬ: ключевые фразы дословно, язык.
7. ОФФЕР И CTA.
8. БОЛЬ/ТРИГГЕР аудитории.
9. ВИЗУАЛЬНЫЙ СТИЛЬ И ТЕМП: монтаж, динамика, общее впечатление.

На русском, подробно (10-15 предложений). Никаких догадок о метриках.`;

async function fetchBuffer(url: string): Promise<{ buffer: ArrayBuffer; mimeType: string; name: string }> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch asset failed: ${res.status}`);
  const mimeType = res.headers.get("content-type") ?? "application/octet-stream";
  const buffer = await res.arrayBuffer();
  const name = url.split("/").pop()?.split("?")[0] ?? "file";
  return { buffer, mimeType, name };
}

async function uploadToFilesApi(buffer: ArrayBuffer, mimeType: string, displayName: string): Promise<string> {
  const initRes = await fetch(`${FILES_API}?key=${GEMINI_API_KEY}`, {
    method: "POST",
    headers: {
      "X-Goog-Upload-Protocol": "resumable",
      "X-Goog-Upload-Command": "start",
      "X-Goog-Upload-Header-Content-Length": String(buffer.byteLength),
      "X-Goog-Upload-Header-Content-Type": mimeType,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ file: { display_name: displayName } }),
  });
  const uploadUrl = initRes.headers.get("x-goog-upload-url");
  if (!uploadUrl) throw new Error("Files API: не удалось инициировать загрузку");

  const uploadRes = await fetch(uploadUrl, {
    method: "POST",
    headers: { "X-Goog-Upload-Command": "upload, finalize", "X-Goog-Upload-Offset": "0", "Content-Type": mimeType },
    body: buffer,
  });
  if (!uploadRes.ok) throw new Error(`Files API upload: ${await uploadRes.text()}`);

  const uploadData = await uploadRes.json() as { file?: { uri?: string; name?: string } };
  const fileInfo = uploadData.file;
  if (!fileInfo?.uri || !fileInfo?.name) throw new Error("Files API не вернул URI");

  // Видео нужно время на обработку — ждём ACTIVE.
  for (let i = 0; i < 20; i++) {
    const stateRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/${fileInfo.name}?key=${GEMINI_API_KEY}`);
    const stateData = await stateRes.json() as { state?: string };
    if (stateData.state === "ACTIVE") return fileInfo.uri;
    if (stateData.state === "FAILED") throw new Error("Gemini отклонил файл (FAILED)");
    await new Promise(r => setTimeout(r, 3000));
  }
  throw new Error("Файл не стал ACTIVE за 60с");
}

// Page access token (кешируем): рекламные видео — это Reels страницы, и source
// отдаётся только PAGE-токеном (не system-user токеном). Страница назначена системному
// пользователю → токен страницы получаем из me/accounts.
let _pageToken: string | null = null;
async function getPageToken(): Promise<string | null> {
  if (_pageToken) return _pageToken;
  if (!META_TOKEN) return null;
  try {
    const res = await fetch(`https://graph.facebook.com/v21.0/me/accounts?fields=access_token&access_token=${META_TOKEN}`);
    const j = await res.json() as { data?: { access_token?: string }[] };
    _pageToken = j.data?.[0]?.access_token ?? null;
  } catch { _pageToken = null; }
  return _pageToken;
}

// Резолв прямой ссылки на видео (.mp4) из Meta по video_id (временный CDN-URL).
export async function resolveMetaVideoSource(videoId: string): Promise<string | null> {
  if (!META_TOKEN) return null;
  const token = (await getPageToken()) ?? META_TOKEN; // page-токен открывает source у Reels
  const res = await fetch(`https://graph.facebook.com/v21.0/${videoId}?fields=source&access_token=${token}`);
  const json = await res.json() as { source?: string; error?: unknown };
  return json.source ?? null;
}

// Свежая ссылка на картинку/превью крео по ad_id: creative{image_url,thumbnail_url} — CDN-URL временные.
export async function resolveMetaImageSource(adId: string): Promise<string | null> {
  if (!META_TOKEN) return null;
  const res = await fetch(`https://graph.facebook.com/v21.0/${adId}?fields=creative{image_url,thumbnail_url}&access_token=${META_TOKEN}`);
  const j = await res.json() as { creative?: { image_url?: string; thumbnail_url?: string } };
  return j.creative?.image_url ?? j.creative?.thumbnail_url ?? null;
}

// Разбор одного креатива Gemini Vision → текстовое описание.
export async function describeCreative(assetUrl: string): Promise<string> {
  if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY не задан");
  const { buffer, mimeType, name } = await fetchBuffer(assetUrl);
  const fileUri = await uploadToFilesApi(buffer, mimeType, name);
  const res = await fetch(`${GEMINI_URL}?key=${GEMINI_API_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: DESC_PROMPT }, { file_data: { mime_type: mimeType, file_uri: fileUri } }] }],
      // На видео gemini-2.5-flash тратит много на "thinking" → даём большой бюджет и
      // отключаем thinking, чтобы output не обрезался на 1-й секции (был баг: 270 симв).
      generationConfig: { temperature: 0.3, maxOutputTokens: 8192, thinkingConfig: { thinkingBudget: 0 } },
    }),
  });
  if (!res.ok) throw new Error(`Gemini error: ${await res.text()}`);
  const data = await res.json() as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
  const text = data.candidates?.[0]?.content?.parts?.map(p => p.text ?? "").join("") ?? "";
  if (!text) throw new Error("Gemini не вернул описание");
  return text;
}

// Структурный разбор по параметрам (для «полной картины» и шторма на /weekly).
export interface CreativeParams {
  format:     string;  // тип креатива
  persona:    string;  // на кого нацелен / кто в кадре
  hook:       string;  // суть хука (первые 3 сек / первый экран)
  angle:      string;  // угол/позиционирование
  body:       string;  // основная структура/содержание
  strength:   string;  // чем силён (что копировать при размножении)
  brainstorm: string;  // над чем штормить по этому крео
}

const PARAMS_PROMPT = `Контекст: рекламный креатив.\n\n${getAiContext()}

Разбери ЭТОТ креатив по параметрам — для аналитики и мозгового штурма. Только факты о содержании, без метрик и оценок 1-10. На русском, каждое поле кратко и конкретно (1-2 предложения):
- format: тип (UGC / интервью / talking-head / студия / анимация / квиз-карточка / статика / скринкаст)
- persona: на кого нацелен и/или кто в кадре (пол, возраст, роль)
- hook: суть хука — что показано и сказано в первые 3 сек (первый экран), по возможности дословно
- angle: угол/позиционирование (боль, выгода, соц.доказательство, страх, любопытство, авторитет и т.п.)
- body: основная структура/содержание — что и в каком порядке
- strength: чем этот креатив силён (что стоит копировать при размножении)
- brainstorm: над чем штормить по этому крео — какие варианты хука/энгла/персоны/боди протестировать дальше`;

const PARAMS_SCHEMA = {
  type: "object",
  properties: {
    format:     { type: "string" },
    persona:    { type: "string" },
    hook:       { type: "string" },
    angle:      { type: "string" },
    body:       { type: "string" },
    strength:   { type: "string" },
    brainstorm: { type: "string" },
  },
  required: ["format", "persona", "hook", "angle", "body", "strength", "brainstorm"],
} as const;

// Разбор одного креатива Gemini → структурные параметры (JSON по схеме).
export async function analyzeCreativeParams(assetUrl: string): Promise<CreativeParams> {
  if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY не задан");
  const { buffer, mimeType, name } = await fetchBuffer(assetUrl);
  const fileUri = await uploadToFilesApi(buffer, mimeType, name);
  const res = await fetch(`${GEMINI_URL}?key=${GEMINI_API_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: PARAMS_PROMPT }, { file_data: { mime_type: mimeType, file_uri: fileUri } }] }],
      generationConfig: {
        temperature: 0.3, maxOutputTokens: 4096, thinkingConfig: { thinkingBudget: 0 },
        responseMimeType: "application/json", responseSchema: PARAMS_SCHEMA,
      },
    }),
  });
  if (!res.ok) throw new Error(`Gemini error: ${await res.text()}`);
  const data = await res.json() as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
  const text = data.candidates?.[0]?.content?.parts?.map(p => p.text ?? "").join("") ?? "";
  if (!text) throw new Error("Gemini не вернул параметры");
  try {
    return JSON.parse(text) as CreativeParams;
  } catch {
    throw new Error("Gemini вернул невалидный JSON параметров");
  }
}

const TRANSCRIPT_PROMPT = `Транскрибируй это рекламное видео ДОСЛОВНО (verbatim), на языке оригинала (русский).
Выдай в формате:
1. ХУК (первые 3 секунды) — ровно та фраза/слова, что звучат/показаны в самом начале.
2. ПОЛНАЯ РАСШИФРОВКА речи с таймкодами [мм:сс] — дословно, без пересказа и сокращений.
3. ТЕКСТ НА ЭКРАНЕ — все плашки/субтитры/титры дословно (если есть), с таймкодами.
Не придумывай и не перефразируй. Если речи нет — напиши «речи нет». Без преамбулы.`;

// Дословная транскрибация одного видео-креатива (для ручной разметки хуков).
export async function transcribeCreative(assetUrl: string): Promise<string> {
  if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY не задан");
  const { buffer, mimeType, name } = await fetchBuffer(assetUrl);
  const fileUri = await uploadToFilesApi(buffer, mimeType, name);
  const res = await fetch(`${GEMINI_URL}?key=${GEMINI_API_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: TRANSCRIPT_PROMPT }, { file_data: { mime_type: mimeType, file_uri: fileUri } }] }],
      generationConfig: { temperature: 0.1, maxOutputTokens: 8192, thinkingConfig: { thinkingBudget: 0 } },
    }),
  });
  if (!res.ok) throw new Error(`Gemini error: ${await res.text()}`);
  const data = await res.json() as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
  const text = data.candidates?.[0]?.content?.parts?.map(p => p.text ?? "").join("") ?? "";
  if (!text) throw new Error("Gemini не вернул транскрипт");
  return text;
}

// ── Дословное извлечение параметров (формулировки, 06.10.2026) ──────────────
// Параметр = точный текст из креатива. Модель НЕ классифицирует и НЕ пересказывает —
// только выписывает дословно. Результат идёт в lib/formulations.ts → коды формулировок.

const VERBATIM_PROMPT = `Контекст: рекламный креатив (видео или статика) онлайн-школы для русскоязычных в Германии.

Выпиши из креатива ДОСЛОВНО четыре текстовых параметра. Ничего не пересказывай, не обобщай, не исправляй ошибки, не переводи, сохраняй регистр, пунктуацию, цифры, немецкие слова как есть. Если фразы нет — null.

1. persona_text — фраза, которой креатив обращается к зрителю или называет, кто он (например «Вы работаете в Pflege?», «Вам 42, и вы думаете…», «Бухгалтер с опытом в СНГ?»). Только прямое обращение/называние аудитории. Нет — null.
2. hook_text — первые 3 секунды видео или первый экран/заголовок статики: всё, что звучит и показано в самом начале, дословно. Несколько элементов разделяй « | ».
3. body_text — основной текст предложения после хука и до призыва: что предлагают, условия, структура. Дословно, блоки/предложения через « | ». Без хука и без CTA.
4. angle_text — дословная формулировка главной выгоды/обещания/оффера (зарплата, срок, язык обучения, сертификат, оплата Jobcenter, «без опыта» и т.п.) — ровно та фраза, что есть в креативе.
5. full_text — весь текст креатива дословно (речь + текст на экране) в порядке появления, через « | ».
6. confidence — high/medium/low: насколько уверенно текст прочитан/расслышан.
7. notes — коротко: что не удалось разобрать (или пусто).

Язык — как в креативе. Никаких выдумок: если текста нет, ставь null.`;

const VERBATIM_SCHEMA = {
  type: "object",
  properties: {
    persona_text: { type: "string", nullable: true },
    hook_text:    { type: "string", nullable: true },
    body_text:    { type: "string", nullable: true },
    angle_text:   { type: "string", nullable: true },
    full_text:    { type: "string" },
    confidence:   { type: "string", enum: ["high", "medium", "low"] },
    notes:        { type: "string" },
  },
  required: ["persona_text", "hook_text", "body_text", "angle_text", "full_text", "confidence", "notes"],
} as const;

export async function extractVerbatim(assetUrl: string): Promise<VerbatimExtraction> {
  if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY не задан");
  const { buffer, mimeType, name } = await fetchBuffer(assetUrl);
  const fileUri = await uploadToFilesApi(buffer, mimeType, name);
  const res = await fetch(`${GEMINI_URL}?key=${GEMINI_API_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: VERBATIM_PROMPT }, { file_data: { mime_type: mimeType, file_uri: fileUri } }] }],
      generationConfig: {
        temperature: 0.1, maxOutputTokens: 8192, thinkingConfig: { thinkingBudget: 0 },
        responseMimeType: "application/json", responseSchema: VERBATIM_SCHEMA,
      },
    }),
  });
  if (!res.ok) throw new Error(`Gemini error: ${await res.text()}`);
  const data = await res.json() as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
  const text = data.candidates?.[0]?.content?.parts?.map(p => p.text ?? "").join("") ?? "";
  if (!text) throw new Error("Gemini не вернул извлечение");
  try {
    return JSON.parse(text) as VerbatimExtraction;
  } catch {
    throw new Error("Gemini вернул невалидный JSON извлечения");
  }
}

// ── Таймкоды параметров в видео: где именно звучит/показан хук, боди, энгл, персона ──────────────────
// Нужно для референсов в ТЗ: ссылка на фрагмент донора (#t=start,end), а не на весь ролик. Результат кешируется в
// gemini_analyses(mode='timings') — см. lib/param-timings.ts.
export type ParamTimings = Record<"persona" | "hook" | "body" | "angle", [number, number] | null>;
export async function extractTimings(assetUrl: string, texts: Partial<Record<"persona" | "hook" | "body" | "angle", string | null>>): Promise<ParamTimings> {
  if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY не задан");
  const { buffer, mimeType, name } = await fetchBuffer(assetUrl);
  const fileUri = await uploadToFilesApi(buffer, mimeType, name);
  const list = (["persona", "hook", "body", "angle"] as const).filter(a => texts[a]).map(a => `${a}: «${String(texts[a]).replace(/\s+/g, " ").slice(0, 600)}»`).join("\n");
  const prompt = `Это рекламное видео. Ниже тексты его параметров (дословно). Для каждого параметра укажи, в какие секунды он ЗВУЧИТ или ПОКАЗАН на экране: start_sec и end_sec (числа, секунды от начала). Боди может быть длинным — укажи от первой до последней фразы. Если параметра в видео нет — null. Не выдумывай: если не уверен — null.\n${list}`;
  const num = { type: "number", nullable: true };
  const seg = { type: "object", properties: { start_sec: num, end_sec: num }, required: ["start_sec", "end_sec"] };
  const res = await fetch(`${GEMINI_URL}?key=${GEMINI_API_KEY}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }, { file_data: { mime_type: mimeType, file_uri: fileUri } }] }], generationConfig: { temperature: 0, maxOutputTokens: 1024, thinkingConfig: { thinkingBudget: 0 }, responseMimeType: "application/json", responseSchema: { type: "object", properties: { persona: seg, hook: seg, body: seg, angle: seg }, required: ["persona", "hook", "body", "angle"] } } }),
  });
  if (!res.ok) throw new Error(`Gemini error: ${await res.text()}`);
  const data = await res.json() as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
  const j = JSON.parse(data.candidates?.[0]?.content?.parts?.map(p => p.text ?? "").join("") ?? "{}") as Record<string, { start_sec: number | null; end_sec: number | null } | null>;
  const out: ParamTimings = { persona: null, hook: null, body: null, angle: null };
  for (const a of ["persona", "hook", "body", "angle"] as const) { const s = j[a]; if (s && s.start_sec != null && s.end_sec != null && s.end_sec >= s.start_sec) out[a] = [Math.max(0, Math.floor(s.start_sec)), Math.ceil(s.end_sec)]; }
  return out;
}
