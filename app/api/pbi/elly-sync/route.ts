import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";
import { runAlertCheck } from "@/lib/alert-check";
import { fetchGoogleCreativeData, allocateGoogleLeads } from "@/lib/google-creatives";

// Plurio sync = MCP-SSE + LLM-обработка + опциональный polling.
// Hobby plan cap = 300s. При длинных запросах синкаем помесячно, чтобы укладываться.
export const maxDuration = 800; // Plurio (LLM-агент) отвечает 3–4 мин; 300 с не хватало (19.10.2026)

// Мост Plurio MCP переезжал: mcp-ryen.onrender.com умер 19.10.2026 (404 на всё, синк лидов и /weekly падали «SSE connect failed: 404»).
// Основной адрес берём из env, дальше перебираем запасные — чтобы переезд провайдера не ронял сбор недели.
const MCP_BASES = Array.from(new Set([process.env.PLURIO_MCP_BASE, "https://mcp.plurio.ai", "https://mcp-ryen.onrender.com"].filter((x): x is string => !!x)));
let MCP_BASE = MCP_BASES[0];
const ELLY_BASE  = "https://agi.ellyanalytics.com";
const PLURIO_KEY = process.env.PLURIO_API_KEY!;
const PROJECT_ID = process.env.PLURIO_PROJECT_ID ?? "569543d3-d4ff-497d-873c-5de47c3385ee";

// ── SSE reader ────────────────────────────────────────────────────────────────

class SseReader {
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private decoder = new TextDecoder();
  private buf = "";

  constructor(res: Response) {
    this.reader = res.body!.getReader();
  }

  async next(): Promise<{ type: string; data: string } | null> {
    let evt = { type: "message", data: "" };
    while (true) {
      const end = this.buf.indexOf("\n\n");
      if (end !== -1) {
        const block = this.buf.slice(0, end);
        this.buf = this.buf.slice(end + 2);
        for (const line of block.split("\n")) {
          if (line.startsWith("event: ")) evt.type = line.slice(7).trim();
          else if (line.startsWith("data: ")) evt.data = line.slice(6).trim();
        }
        if (evt.data) return evt;
        evt = { type: "message", data: "" };
        continue;
      }
      const { done, value } = await this.reader.read();
      if (done) return null;
      this.buf += this.decoder.decode(value, { stream: true });
    }
  }

  close() { this.reader.cancel().catch(() => {}); }
}

// ── MCP helpers ───────────────────────────────────────────────────────────────

async function mcpConnect(): Promise<{ sse: SseReader; sessionUrl: string }> {
  // Сначала короткая проверка адреса (с таймаутом, тело сразу закрываем), потом настоящее SSE-соединение БЕЗ таймаута:
  // AbortSignal.timeout на самом SSE-запросе обрывал поток через 20 с («The operation was aborted due to timeout», 19.10.2026).
  const errors: string[] = []; let chosen: string | null = null;
  for (const base of MCP_BASES) {
    try {
      const probe = await fetch(`${base}/sse?base_url=${ELLY_BASE}&api_key=${PLURIO_KEY}`, { headers: { Accept: "text/event-stream" }, signal: AbortSignal.timeout(15000) });
      await probe.body?.cancel().catch(() => undefined);
      if (probe.ok) { chosen = base; break; }
      errors.push(`${base} → ${probe.status}`);
    } catch (e) { errors.push(`${base} → ${e instanceof Error ? e.message : String(e)}`); }
  }
  if (!chosen) throw new Error(`Plurio MCP недоступен (${errors.join("; ")}). Проверь адрес моста: PLURIO_MCP_BASE в env или новый адрес у Plurio.`);
  MCP_BASE = chosen;
  const sseRes = await fetch(`${MCP_BASE}/sse?base_url=${ELLY_BASE}&api_key=${PLURIO_KEY}`, { headers: { Accept: "text/event-stream" } });
  if (!sseRes.ok || !sseRes.body) throw new Error(`SSE connect failed: ${sseRes.status} (${MCP_BASE})`);

  const sse = new SseReader(sseRes);
  const endpointEvt = await sse.next();
  if (!endpointEvt || endpointEvt.type !== "endpoint") throw new Error("No endpoint event");
  const sessionUrl = `${MCP_BASE}${endpointEvt.data}`;

  await rpc(sessionUrl, 1, "initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "creative-system-sync", version: "1.0.0" },
  });
  await sse.next(); // consume initialize response
  await rpc(sessionUrl, 0, "notifications/initialized", {});

  return { sse, sessionUrl };
}

async function rpc(sessionUrl: string, id: number, method: string, params: unknown) {
  const res = await fetch(sessionUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  if (!res.ok) throw new Error(`MCP POST ${method} → ${res.status}`);
}

// ── Collect SSE result for a single tool call (id: 2) ────────────────────────

async function collectToolResult(sse: SseReader, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  const texts: string[] = [];

  while (Date.now() < deadline) {
    const evt = await sse.next();
    if (!evt) break;
    if (evt.type !== "message") continue;

    let msg: { id?: number; result?: { content?: { type: string; text: string }[] }; params?: unknown };
    try { msg = JSON.parse(evt.data); } catch { continue; }

    const content =
      msg.result?.content ??
      (msg.params as { content?: { type: string; text: string }[] } | undefined)?.content ?? [];
    for (const c of content) {
      if (c.type === "text" && c.text) texts.push(c.text);
    }

    if (msg.id === 2 && msg.result) return texts.join("\n");
  }

  return texts.join("\n");
}

// ── Parse Plurio table response ───────────────────────────────────────────────

export interface EllyRow {
  date: string;          // конкретный день YYYY-MM-DD (дневная разбивка), "" если Plurio не отдал
  campaign: string;      // CampaignName (нужен Google: у PMax AdId пустой, лиды на уровне кампании)
  adId: string;
  adName: string;
  leads: number;
  qualLeads: number;
  spend: number;
  revenue: number;
}

// Date из ответа Plurio → строгий YYYY-MM-DD (или "" если не распознан).
function parseDate(v: unknown): string {
  const m = String(v ?? "").match(/(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : "";
}

function parseNum(v: unknown): number {
  if (typeof v === "number") return v;
  return parseFloat(String(v ?? "").replace(/[€\s\u00a0]/g, "").replace(",", ".")) || 0;
}

// ── Поиск колонок по нестабильным заголовкам ──────────────────────────────────
// Plurio — LLM-агент, и заголовки он формирует каждый раз немного иначе:
// "Leads" / "сумма Leads" / "Leads (Last Ad Click)", "Revenue" / "Revenue (€)".
// Раньше искали ТОЧНОЕ совпадение нормализованного заголовка, и любой префикс
// молча превращал колонку в 0: 31 августа ответ пришёл с "сумма Leads" →
// на /weekly записался снапшот со спендом и нулевыми лидами, без ошибки.
// Теперь: сначала точное совпадение, потом вхождение подстроки.
const NORM = (s: string) => s.toLowerCase().replace(/[^a-zа-я0-9]/gi, "");

interface ColIdx {
  date: number; campaign: number; adId: number; adName: number;
  leads: number; qualLeads: number; spend: number; revenue: number;
}

function columnIndexes(headers: string[]): ColIdx {
  const find = (pats: string[], skip: number[] = []): number => {
    const free = (i: number) => !skip.includes(i);
    for (const p of pats) {
      const exact = headers.findIndex((h, i) => free(i) && h === p);
      if (exact >= 0) return exact;
    }
    for (const p of pats) {
      const part = headers.findIndex((h, i) => free(i) && h.includes(p));
      if (part >= 0) return part;
    }
    return -1;
  };
  // QL ищем ДО leads: "qualified leads" содержит "lead" и иначе занял бы
  // колонку лидов, а настоящие лиды остались бы нулями.
  const qualLeads = find(["ql", "qual", "квал"]);
  const campaign = find(["campaignname", "campaign", "кампания"]);
  return {
    date:      find(["date", "дата"]),
    campaign,
    adId:      find(["adid", "id"], campaign >= 0 ? [campaign] : []),
    adName:    find(["adname", "name", "название"], campaign >= 0 ? [campaign] : []),
    leads:     find(["leads", "лиды", "lead", "лид"], qualLeads >= 0 ? [qualLeads] : []),
    qualLeads,
    spend:     find(["advspend", "spend", "бюджет", "затраты", "расход"]),
    revenue:   find(["revenue", "выручка", "выручк", "доход"]),
  };
}

// Колонка лидов — единственная, без которой синк бессмысленен. Если её нет,
// падаем громко: пусть /weekly покажет ошибку, а не тихий нулевой снапшот.
function assertLeadsColumn(idx: ColIdx, headers: string[], where: string): void {
  if (idx.leads >= 0) return;
  throw new Error(`PARSE_FAIL:нет колонки лидов (${where}); заголовки=[${headers.join(", ")}]`);
}

function parseViz(text: string): EllyRow[] | null {
  const m = text.match(/<!--\s*plurio_viz:\s*(\{[\s\S]*?\})\s*-->/);
  if (!m) return null;
  try {
    const viz = JSON.parse(m[1]);
    if (viz.type !== "Table" || !Array.isArray(viz.data) || viz.data.length === 0) return null;

    const keys = Object.keys(viz.data[0] as Record<string, unknown>);
    const idx = columnIndexes(keys.map(NORM));
    assertLeadsColumn(idx, keys, "plurio_viz");
    const at = (r: Record<string, unknown>, i: number) => (i >= 0 ? r[keys[i]] : undefined);

    return viz.data.map((r: Record<string, unknown>) => ({
      date:      parseDate(at(r, idx.date)),
      campaign:  String(at(r, idx.campaign) ?? "").trim(),
      adId:      String(at(r, idx.adId) ?? "").trim(),
      adName:    String(at(r, idx.adName) ?? ""),
      leads:     parseNum(at(r, idx.leads)),
      qualLeads: parseNum(at(r, idx.qualLeads)),
      spend:     parseNum(at(r, idx.spend)),
      revenue:   parseNum(at(r, idx.revenue)),
    })).filter((r: EllyRow) => r.adName || r.campaign);
  } catch (e) {
    // Отсутствие колонки лидов — это ошибка данных, её пробрасываем наверх.
    // Всё остальное (битый JSON) — тихий null, чтобы сработал markdown-фолбэк.
    if (e instanceof Error && e.message.startsWith("PARSE_FAIL")) throw e;
    return null;
  }
}

function parseMarkdownTable(text: string): EllyRow[] | null {
  const parseRow  = (line: string) =>
    line.split("|").map(c => c.trim()).filter((_, i, a) => i > 0 && i < a.length - 1);

  const lines = text.split("\n").map(l => l.trim()).filter(l => l.startsWith("|"));
  if (lines.length < 2) return null;

  const raw = parseRow(lines[0]);
  const headers = raw.map(NORM);
  if (headers.length < 2) return null;

  const dataLines = lines.slice(1).filter(l => !/^\|[\s:-]+\|/.test(l));
  if (dataLines.length === 0) return null;

  const idx = columnIndexes(headers);
  if (idx.adName === -1 && idx.adId === -1) return null;
  assertLeadsColumn(idx, raw, "markdown-таблица");

  const rows: EllyRow[] = [];
  for (const line of dataLines) {
    const cols = parseRow(line);
    const adName   = idx.adName   >= 0 ? (cols[idx.adName]   ?? "") : "";
    const adId     = idx.adId     >= 0 ? (cols[idx.adId]     ?? "") : "";
    const campaign = idx.campaign >= 0 ? (cols[idx.campaign] ?? "").trim() : "";
    if (!adName && !adId && !campaign) continue;
    rows.push({
      date:      idx.date      >= 0 ? parseDate(cols[idx.date])    : "",
      campaign,
      adId,
      adName:    adName || adId || campaign,
      leads:     idx.leads     >= 0 ? parseNum(cols[idx.leads])     : 0,
      qualLeads: idx.qualLeads >= 0 ? parseNum(cols[idx.qualLeads]) : 0,
      spend:     idx.spend     >= 0 ? parseNum(cols[idx.spend])     : 0,
      revenue:   idx.revenue   >= 0 ? parseNum(cols[idx.revenue])   : 0,
    });
  }
  return rows.length > 0 ? rows : null;
}

function parseResponse(text: string): EllyRow[] | null {
  // Пробуем viz, затем markdown. PARSE_FAIL из первого пути не должен гасить
  // второй: заголовки в viz-блоке и в markdown-таблице бывают разными.
  let firstErr: unknown = null;
  for (const parse of [parseViz, parseMarkdownTable]) {
    try {
      const rows = parse(text);
      if (rows && rows.length > 0) return rows;
    } catch (e) {
      firstErr ??= e;
    }
  }
  if (firstErr) throw firstErr;
  return null;
}

// ── TSV file fallback ─────────────────────────────────────────────────────────
// Когда выгрузка большая (>~150 строк), Plurio отдаёт presigned S3 URL на TSV
// вместо inline markdown. Распознаём URL и парсим файл по табам.

function extractTsvUrl(text: string): string | null {
  // sql-query-result-{id}.tsv с возможными дефисами/подчёркиваниями в id.
  // URL может быть URL-encoded (sometimes %3D вместо =), но https://... всегда прямой.
  const m = text.match(/https?:\/\/[^\s)"']*sql-query-result-[A-Za-z0-9_-]+\.tsv[^\s)"']*/);
  return m?.[0] ?? null;
}

function hasTsvMention(text: string): boolean {
  return /sql-query-result-[A-Za-z0-9_-]+\.tsv/.test(text);
}

// Если Plurio упомянул tsv-файл, но URL вне видимой части ответа —
// просим в том же чате выдать ПОЛНУЮ presigned URL.
async function askForTsvUrl(chatId: string): Promise<string | null> {
  const { sse, sessionUrl } = await mcpConnect();
  try {
    await rpc(sessionUrl, 2, "tools/call", {
      name: "ask_plurio",
      arguments: {
        project_id: PROJECT_ID,
        chat_id: chatId,
        question: "Покажи полный presigned URL на TSV-файл из предыдущего ответа. " +
                  "Формат: https://...sql-query-result-*.tsv?... — целиком, в одну строку, без обрезки.",
      },
    });
    const text = await collectToolResult(sse, 90_000);
    return extractTsvUrl(text);
  } finally {
    sse.close();
  }
}

function parseTsvText(text: string): EllyRow[] {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return [];

  const raw = lines[0].split("\t");
  const idx = columnIndexes(raw.map(NORM));
  if (idx.adName === -1 && idx.adId === -1) return [];
  assertLeadsColumn(idx, raw, "TSV-файл");

  const rows: EllyRow[] = [];
  for (const line of lines.slice(1)) {
    const cols = line.split("\t");
    const adName   = idx.adName   >= 0 ? (cols[idx.adName]   ?? "").trim() : "";
    const adId     = idx.adId     >= 0 ? (cols[idx.adId]     ?? "").trim() : "";
    const campaign = idx.campaign >= 0 ? (cols[idx.campaign] ?? "").trim() : "";
    if (!adName && !adId && !campaign) continue;
    rows.push({
      date:      idx.date      >= 0 ? parseDate(cols[idx.date])    : "",
      campaign,
      adId,
      adName:    adName || adId || campaign,
      leads:     idx.leads     >= 0 ? parseNum(cols[idx.leads])     : 0,
      qualLeads: idx.qualLeads >= 0 ? parseNum(cols[idx.qualLeads]) : 0,
      spend:     idx.spend     >= 0 ? parseNum(cols[idx.spend])     : 0,
      revenue:   idx.revenue   >= 0 ? parseNum(cols[idx.revenue])   : 0,
    });
  }
  return rows;
}

async function fetchTsv(url: string, chatId?: string): Promise<EllyRow[]> {
  let res = await fetch(url);
  // Presigned-ссылка Plurio живёт недолго → 403, если успела протухнуть. Если знаем chatId,
  // перезапрашиваем СВЕЖУЮ ссылку в том же чате и пробуем ещё раз (до 2 попыток).
  for (let attempt = 0; !res.ok && chatId && attempt < 2; attempt++) {
    const fresh = await askForTsvUrl(chatId);
    if (!fresh) break;
    res = await fetch(fresh);
  }
  if (!res.ok) throw new Error(`TSV fetch failed: HTTP ${res.status}`);
  const text = await res.text();
  const rows = parseTsvText(text);
  if (rows.length === 0) {
    throw new Error(`TSV downloaded but parser got 0 rows (size=${text.length})`);
  }
  return rows;
}

function extractChatId(text: string): string | null {
  const m = text.match(/\*\*Chat ID:\*\*\s+`([^`]+)`/);
  return m?.[1] ?? null;
}

// ── Poll get_chat_messages until result arrives ───────────────────────────────

async function pollChatMessages(chatId: string, pollDeadline: number): Promise<EllyRow[]> {
  while (Date.now() < pollDeadline) {
    await new Promise(r => setTimeout(r, 30_000));

    const { sse, sessionUrl } = await mcpConnect();
    await rpc(sessionUrl, 2, "tools/call", {
      name: "get_chat_messages",
      arguments: { project_id: PROJECT_ID, chat_id: chatId, role: "assistant", limit: 1 },
    });

    const text = await collectToolResult(sse, 30_000);
    sse.close();

    if (!text || text.includes("No messages found")) continue;

    // Большая выгрузка → ссылка на TSV (chatId → ретрай свежей ссылки при 403)
    const tsvUrl = extractTsvUrl(text);
    if (tsvUrl) return await fetchTsv(tsvUrl, chatId);

    // TSV упомянут, но URL не виден — попросим явно
    if (hasTsvMention(text)) {
      const url = await askForTsvUrl(chatId);
      if (url) return await fetchTsv(url, chatId);
    }

    const rows = parseResponse(text);
    if (rows && rows.length > 0) return rows;
  }

  throw new Error("Timeout polling Plurio result");
}

// ── Main sync ─────────────────────────────────────────────────────────────────

export type EllySource = "meta" | "google" | "tiktok";

export async function syncElly(dateFrom: string, dateTo: string, source: EllySource = "meta"): Promise<EllyRow[]> {
  if (!PLURIO_KEY) throw new Error("PLURIO_API_KEY не задан");

  const { sse, sessionUrl } = await mcpConnect();

  // LIFETIME-агрегат (НЕ дневная разбивка). Plurio даёт корректный итог; дневная
  // разбивка для quiz-адов раздувала лиды ~7x. Для Meta — на уровне AdId; для
  // Google (PMax) AdId=NULL, поэтому агрегат на уровне КАМПАНИИ (CampaignName
  // совпадает с ad_name в meta_ads, по нему вид и джойнит).
  const tail =
    `Включи ВСЕ строки, у которых Leads > 0 (без top-N ограничения, без обрезки). ` +
    `Верни ОДНУ markdown-таблицу со всеми строками. Если строк слишком много для inline — отдай TSV-файл, ` +
    `но обязательно укажи ПОЛНУЮ presigned URL в формате https://...sql-query-result-*.tsv?... в тексте ответа. ` +
    `Без преамбулы.`;
  const question = source === "google"
    ? `Дай СУММАРНЫЕ (агрегат за весь период ${dateFrom} — ${dateTo}, БЕЗ разбивки по дням) показатели ` +
      `по Google Ads с группировкой по CampaignName, AdId, AdName (group by CampaignName, AdId, AdName). ` +
      `У Search / Demand Gen / YouTube AdId заполнен — верни его как есть; у Performance Max AdId пустой — ` +
      `такие строки оставь ОДНОЙ строкой на кампанию с пустым AdId (не отбрасывай). ` +
      `Заголовки колонок строго такие, слово в слово, без приставок вроде "сумма": ` +
      `CampaignName | AdId | AdName | Leads | QL | AdvSpend | Revenue. ` +
      `ОБЯЗАТЕЛЬНО включи столбец Revenue — это когортная выручка (следует за лидом); ` +
      `не возвращай Revenue=0, если есть оплаты. Включи ВСЕ строки, где Leads > 0 ИЛИ Revenue > 0. ` +
      `Фильтр: AttributionType = 'Leads Last Ad Click', SourceGroupName = 'Google Ads'. ` + tail
    : source === "tiktok"
    ? `Дай СУММАРНЫЕ (агрегат за весь период ${dateFrom} — ${dateTo}, БЕЗ разбивки по дням) показатели ` +
      `по объявлениям (ad level) из TikTok. ОДНА строка на КАЖДЫЙ AdId — суммы за весь период, не по дням; ` +
      `строки с пустым AdId и AdName сгруппируй в одну строку с AdName = 'TikTok без объявления'. ` +
      `Заголовки колонок строго такие, слово в слово, без приставок вроде "сумма": ` +
      `AdId | AdName | Leads | QL | AdvSpend | Revenue. ` +
      `Фильтр: AttributionType = 'Leads Last Ad Click', SourceGroupName = 'TikTok'. ` + tail
    : `Дай СУММАРНЫЕ (агрегат за весь период ${dateFrom} — ${dateTo}, БЕЗ разбивки по дням) показатели ` +
      `по объявлениям (ad level) из Facebook and Instagram. ОДНА строка на КАЖДЫЙ AdId — суммы за весь период, не по дням. ` +
      `Заголовки колонок строго такие, слово в слово, без приставок вроде "сумма": ` +
      `AdId | AdName | Leads | QL | AdvSpend | Revenue. ` +
      `Фильтр: AttributionType = 'Leads Last Ad Click', SourceGroupName = 'Facebook and Instagram'. ` + tail;

  await rpc(sessionUrl, 2, "tools/call", {
    name: "ask_plurio",
    arguments: { project_id: PROJECT_ID, question },
  });

  // Hobby plan cap = 300s, оставляем headroom.
  // Phase 1 (SSE): 120s. Phase 2 (poll): +120s. Всего ~245s, +setup ~250-260s.
  const text = await collectToolResult(sse, 120_000);
  sse.close();

  // Check if Plurio is still processing (SSE timeout → "still running" message)
  if (text.includes("still running") || text.includes("Chat ID:")) {
    const chatId = extractChatId(text);
    if (!chatId) throw new Error(`Still running but no chat_id found. Tail: ${text.slice(-300)}`);
    return pollChatMessages(chatId, Date.now() + 120_000);
  }

  // Большая выгрузка → ссылка на TSV (Plurio так делает когда строк >~150).
  // chatId передаём в fetchTsv — чтобы при 403 (протухшая ссылка) перезапросить свежую.
  const chatId = extractChatId(text);
  const tsvUrl = extractTsvUrl(text);
  if (tsvUrl) return await fetchTsv(tsvUrl, chatId ?? undefined);

  // Plurio упомянул TSV-файл, но URL в видимой части ответа нет —
  // делаем follow-up в тот же chat и просим полный URL.
  if (hasTsvMention(text) && chatId) {
    const url = await askForTsvUrl(chatId);
    if (url) return await fetchTsv(url, chatId);
  }

  const rows = parseResponse(text);
  if (!rows || rows.length === 0) {
    throw new Error(`PARSE_FAIL:hasViz=${text.includes("plurio_viz")},hasPipe=${text.includes("|")},hasTsv=${/sql-query-result/.test(text)},len=${text.length},tail=${text.slice(-400)}`);
  }
  return rows;
}

// ── Route handlers ────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  // Опциональная интеграция: если PLURIO_API_KEY не задан, эндпоинт возвращает
  // 503, чтобы UI/cron мог это спокойно перехватить.
  if (!process.env.PLURIO_API_KEY) {
    return NextResponse.json(
      { error: "Plurio/Elly integration not configured (PLURIO_API_KEY missing). Это опциональная интеграция." },
      { status: 503 }
    );
  }

  // LIFETIME-режим: по умолчанию тянем агрегат за ВСЁ время (с запасом от 2024-01-01),
  // одна строка на ad_id. dateTo = сегодня. Можно переопределить телом запроса.
  const body = await req.json().catch(() => ({})) as { dateFrom?: string; dateTo?: string; source?: EllySource };
  const source: EllySource = body.source === "google" ? "google" : body.source === "tiktok" ? "tiktok" : "meta";
  // неймспейсы pbi_metrics не пересекаются: elly:% (Meta) / google:% / tiktok:%
  const prefix = source === "google" ? "google:" : source === "tiktok" ? "tiktok:" : "elly:";
  const today = new Date();
  const dateTo   = body.dateTo   ?? today.toISOString().slice(0, 10);
  const dateFrom = body.dateFrom ?? "2024-01-01";

  let rows: EllyRow[];
  try {
    rows = await syncElly(dateFrom, dateTo, source);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }

  const supabase = createServiceClient();

  let payload: { ad_id: string; ad_name: string; date: string; leads: number; qual_leads: number; spend: number; revenue: number }[];
  let googleInfo: Record<string, unknown> | undefined;

  if (source === "google") {
    // Google: лиды кладём на КРЕО. Search/DG/Video — по AdId; PMax (AdId пустой) —
    // CRM-лиды кампании раскладываются по её крео пропорционально конверсиям Google.
    // Ключи и метки — те же, что пишет /api/google/sync в meta_ads (lib/google-creatives).
    let data;
    try {
      data = await fetchGoogleCreativeData(dateFrom, dateTo);
    } catch (e) {
      return NextResponse.json({ error: `Google Ads API: ${e instanceof Error ? e.message : String(e)}` }, { status: 502 });
    }
    const elly = rows.map(r => ({
      adId: /^\d+$/.test(r.adId) ? r.adId : "",
      adName: (r.campaign || r.adName).trim(),
      leads: r.leads, qualLeads: r.qualLeads, spend: r.spend, revenue: r.revenue,
    }));
    const { rows: alloc, unmatched } = allocateGoogleLeads(elly, data);
    payload = alloc.map(a => ({
      ad_id: a.key, ad_name: a.label, date: dateTo,
      leads: Math.round(a.leads), qual_leads: Math.round(a.qualLeads), spend: a.spend, revenue: a.revenue,
    }));
    // Кампании, которых Google API за окно не знает (старые/удалённые) — оставляем строкой кампании,
    // чтобы лиды не пропадали из итогов.
    for (const u of unmatched) {
      payload.push({
        ad_id: `${prefix}camp:${u.adName}`, ad_name: u.adName, date: dateTo,
        leads: Math.round(u.leads), qual_leads: Math.round(u.qualLeads), spend: u.spend, revenue: u.revenue,
      });
    }
    googleInfo = {
      ellyRows: rows.length,
      directByAdId: elly.filter(e => e.adId).length,
      allocatedRows: alloc.length,
      estimatedRows: alloc.filter(a => a.estimated).length,
      unmatchedCampaigns: unmatched.map(u => u.adName),
    };
  } else {
    // Meta и TikTok: одна строка на AdId; view джойнит по ad_name (имя объявления в кабинете)
    payload = rows.map(r => ({
      ad_id:      `${prefix}${r.adId || r.adName.trim()}`,
      ad_name:    r.adName.trim(),
      date:       dateTo,
      leads:      Math.round(r.leads),
      qual_leads: Math.round(r.qualLeads),
      spend:      r.spend,
      revenue:    r.revenue,
    }));
  }

  // ЗАЩИТА ОТ ЗАТИРАНИЯ. Plurio иногда отдаёт ЧАСТИЧНЫЙ ответ (обрезка markdown/TSV,
  // таймаут поллинга). Раньше синк сразу делал full-replace → частичный результат
  // затирал полные данные (23 июня: 840 строк → 93, у топ-крео обнулились лиды).
  // Теперь: если новых строк подозрительно мало относительно уже сохранённых —
  // НЕ заменяем, данные сохраняем, просим повторить.
  // Сравниваем не только КОЛИЧЕСТВО строк, но и СУММУ ЛИДОВ: 31 августа Plurio
  // прислал полный набор строк с заголовком "сумма Leads", парсер прочитал лиды
  // как нули — по количеству такой ответ выглядел бы здоровым и full-replace
  // обнулил бы лиды по всей базе.
  const { data: prev } = await supabase
    .from("pbi_metrics").select("leads, qual_leads").like("ad_id", `${prefix}%`);
  const existing      = prev?.length ?? 0;
  const existingLeads = (prev ?? []).reduce((s, r) => s + (Number(r.leads) || 0), 0);
  const payloadLeads  = payload.reduce((s, r) => s + r.leads, 0);

  if (existing > 50) {
    const fewRows  = payload.length < existing * 0.6;
    const fewLeads = existingLeads > 0 && payloadLeads < existingLeads * 0.6;
    if (fewRows || fewLeads) {
      return NextResponse.json({
        ok: false, aborted: true, source,
        reason: fewRows
          ? `Частичный ответ Plurio: получено ${payload.length} строк, было ${existing}. Полная замена ОТМЕНЕНА — данные сохранены. Повтори синк.`
          : `Ответ Plurio без лидов: получено ${payloadLeads} лидов на ${payload.length} строк, было ${existingLeads}. `
            + `Обычно это переименованная колонка лидов в ответе. Полная замена ОТМЕНЕНА — данные сохранены. Повтори синк.`,
        got: payload.length, had: existing,
        gotLeads: payloadLeads, hadLeads: existingLeads,
      }, { status: 200 });
    }
  }

  // Полная замена: lifetime-агрегат — снимок «итог на момент синка», одна строка на ключ.
  // Чистим строки своего неймспейса (elly:% / google:% — не пересекаются), пишем свежий снимок.
  await supabase.from("pbi_metrics").delete().like("ad_id", `${prefix}%`);

  const { error } = await supabase
    .from("pbi_metrics")
    .upsert(payload, { onConflict: "ad_id,date" });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await supabase.from("pbi_sync_log").insert({ rows_count: payload.length });

  // Run alert check after fresh Plurio data is saved
  runAlertCheck().catch(() => {});

  return NextResponse.json({ ok: true, source, synced: payload.length, dateFrom, dateTo, ...(googleInfo ? { google: googleInfo } : {}) });
}

// Cron ходит GET'ом — прокидываем канал через ?source=google (по умолчанию meta).
export async function GET(req: NextRequest) {
  const q = new URL(req.url).searchParams.get("source");
  const source: EllySource = q === "google" ? "google" : q === "tiktok" ? "tiktok" : "meta";
  return POST(new NextRequest("http://localhost/api/pbi/elly-sync", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ source }),
  }));
}
