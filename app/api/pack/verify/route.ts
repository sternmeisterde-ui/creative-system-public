import { NextRequest, NextResponse } from "next/server";
import { runDualVerification } from "@/lib/verify";
import type { PackSlot } from "@/lib/types";

// POST — проверка предложения пака двумя независимыми моделями (Gemini + Codex), как у отчёта.
// Что проверяется: каждая замена «было → стало» опирается на реальные сигналы (код есть в блоке СИГНАЛЫ с теми же числами),
// тексты совпадают с библиотекой, виннер-основа с его метриками существует, в семье меняется ровно один текстовый параметр,
// нет выдуманных/подменённых кодов. Числа детерминированные — модели их не пересчитывают, а сверяют.
export const maxDuration = 300;

interface Body {
  product: string; format: string;
  slots: PackSlot[];
  labels: Record<string, string>;
  signals: { helps: { code: string; paramType: string; ratio: number | null; withCount: number; withCpl?: number | null }[]; hurts: { code: string; paramType: string; ratio: number | null; withCount: number }[]; helpsConcepts: { code: string; ratio: number | null; withCount: number; withCpl?: number | null }[]; lifetimeHelps?: { code: string; paramType: string; ratio: number | null; withCount: number; withCpl?: number | null }[] };
  transferDonors?: Array<{ adName: string; cpl: number | null; medium: string; codes: { persona: string; hook: string; body: string; angle: string } }>;
  medium?: string;
  winners?: Array<{ adName: string; cpl: number | null; leads: number; spend: number; codes: { persona: string; hook: string; body: string; angle: string }; concept: string | null; actor: string | null }>;
  exploreList?: string[];
  notes?: string[];
  report?: { id: string; createdAt: string; dateFrom: string | null; dateTo: string | null; overall: string | null };
}

const INSTRUCTION = `Ты — независимый аудитор предложения пака креативов (дизайн эксперимента). Пак собран ДЕТЕРМИНИРОВАННЫМ кодом по сигналам бивариата; твоя задача — поймать подмену, выдумку или несоответствие данным, а не оценивать креативность. Все числа в контексте — детерминированные, ты их СВЕРЯЕШЬ, не пересчитываешь.

УСТРОЙСТВО КОНТЕКСТА: СИГНАЛЫ (HELPS/HURTS по архиву отчёта), ВИННЕРЫ-ОСНОВА (метрики ЗА ПЕРИОД ОТЧЁТА + их коды), БИБЛИОТЕКА (код → полный дословный текст), СЛОТЫ (только коды + изменение «было → стало» с видом kind). Тексты в СЛОТАХ не повторяются — сверяй коды по БИБЛИОТЕКЕ. Цитаты текстов в обосновании могут быть укорочены с «…» — это НЕ ошибка.

ОПРЕДЕЛЕНИЯ УРОВНЕЙ (tier): A = HELPS за период отчёта с ≥2 крео; B = HELPS за период с ровно 1 крео ИЛИ HELPS за весь срок (блок «HELPS ЗА ВЕСЬ СРОК»); C = наша формулировка с 1 крео без сигнала. Код с HELPS за период и 1 крео помечен B ПРАВИЛЬНО — не считай это несоответствием.

ПРОВЕРЬ по каждому слоту с изменением (учитывай tier — уровень доказательности):
1) kind=helps, tier=A или B: код «стало» есть в HELPS за период ИЛИ (для tier=B) в HELPS ЗА ВЕСЬ СРОК; числа в обосновании (ratio, число крео) совпадают с соответствующим блоком. Нет ни там, ни там → high.
1b) kind=ours (tier=C): код «стало» есть в БИБЛИОТЕКЕ; сигнала у него нет по определению — это измерение, не масштабирование. Требовать сигнал НЕ надо. Если такой слот стоит в категории winner_mix (масштабирование) → medium.
1c) kind=transfer (категория transfer): все четыре кода слота совпадают с кодами донора из блока ДОНОРЫ ПЕРЕНОСА; меняется только медиа (концепция/актёр для видео допустимы и названы в обосновании). Несовпадение кодов → high.
2) kind=helps-concept: код «стало» есть в HELPS-концепциях. Нет → high.
3) kind=cross (перекрёстное опыление): код «стало» = код той же оси у ВТОРОГО виннера из fromWinners (сверь по блоку ВИННЕРЫ). Не совпадает → high.
4) kind=explore: код «стало» есть в СПИСКЕ РАЗВЕДКИ, и эта концепция стоит в ≥3 слотах с разными виннерами-основами; иначе → medium.
5) Код «было» = код той же оси у виннера-основы (блок ВИННЕРЫ). Не совпадает → high.
6) В семье меняется РОВНО один текстовый параметр (persona/hook/body/angle) относительно виннера-основы; остальные три совпадают с его кодами; концепция и актёр — как у виннера. Исключение: если у виннера актёр не размечен («—») или он другого типа под производство — актёр добавляется/заменяется, и это ЯВНО написано в обосновании слота («это второе изменение»); такое помечай как low, не как нарушение.
7) Код «стало» не входит в HURTS → иначе high. Все коды слота есть в БИБЛИОТЕКЕ → иначе high (выдуманный код).
8) CPL виннера в обосновании совпадает с CPL в блоке ВИННЕРЫ (допуск округления 0.1 €). Нет → medium.
9) NOTES об измеримости не противоречат слотам.

КАЖДЫЙ issue — это КОНКРЕТНОЕ несоответствие: укажи ожидаемое и фактическое значение (код/число). Если по пункту всё совпадает («соблюдено», «совпадает», «ок») — это НЕ issue, не записывай его. Внутреннее противоречие формулировок обоснования без расхождения с данными — максимум low.
НЕ считай ошибкой: малое число крео у HELPS-кода (1 крео — помечено как слабый сигнал); одинаковые тексты у персоны и хука (бывает у статики); ИИ-актёров WOM/MAN; укороченные цитаты с «…».
Верни СТРОГО JSON без markdown: {"status":"ok|warning|fail","confidence":0..1,"issues":[{"severity":"high|medium|low","area":"слот #N / общее","detail":"что именно не так"}],"summary":"1-2 предложения"}
ПРАВИЛО СТАТУСА (строго): status=fail ТОЛЬКО если есть хотя бы один issue с severity=high (подмена кодов/чисел, выдуманный код, пункты 1–3, 5, 7). Если самое тяжёлое замечание medium → status=warning. Если только low или замечаний нет → status=ok. Статус, не согласованный с severity твоих же issues, будет исправлен автоматически.`;

export async function POST(req: NextRequest) {
  const b = await req.json().catch(() => null) as Body | null;
  if (!b?.slots?.length) return NextResponse.json({ error: "slots обязательны" }, { status: 400 });
  const eur = (v: number | null | undefined) => (v == null ? "—" : `€${v.toFixed(1)}`);
  const lines: string[] = [];
  lines.push(`ПРОДУКТ: ${b.product} · ФОРМАТ: ${b.format} · ОСНОВА: отчёт ${b.report?.id ?? "?"} от ${b.report?.createdAt ?? "?"}${b.report?.dateFrom ? ` за ${b.report.dateFrom} – ${b.report.dateTo}` : " (lifetime)"}`);
  lines.push(`\nСИГНАЛЫ (детерминированный бивариат по архиву отчёта; код = одна дословная формулировка):`);
  lines.push(`HELPS-формулировки: ${b.signals.helps.map(s => `${s.code}[${s.paramType}, ratio ${s.ratio?.toFixed(2) ?? "—"}, ${s.withCount} крео, CPL ${eur(s.withCpl)}]`).join("; ") || "—"}`);
  lines.push(`HELPS-концепции: ${b.signals.helpsConcepts.map(s => `${s.code}[ratio ${s.ratio?.toFixed(2) ?? "—"}, ${s.withCount} крео, CPL ${eur(s.withCpl)}]`).join("; ") || "—"}`);
  lines.push(`HURTS: ${b.signals.hurts.map(s => `${s.code}[${s.paramType}, ratio ${s.ratio?.toFixed(2) ?? "—"}, ${s.withCount} крео]`).join("; ") || "—"}`);
  lines.push(`HELPS ЗА ВЕСЬ СРОК (уровень B, то же медиа, без свежего HURTS): ${(b.signals.lifetimeHelps ?? []).map(s => `${s.code}[${s.paramType}, ratio ${s.ratio?.toFixed(2) ?? "—"}, ${s.withCount} крео, CPL ${eur(s.withCpl)}]`).join("; ") || "—"}`);
  lines.push(`МЕДИА ПАКА: ${b.medium === "static" ? "статика" : "видео"} — доноры и сигналы только этого медиа; другое медиа — только через kind=transfer.`);
  lines.push(`\nДОНОРЫ ПЕРЕНОСА (виннеры другого медиа):`);
  for (const d of b.transferDonors ?? []) lines.push(`  ${d.adName} [${d.medium}]: CPL ${eur(d.cpl)}; коды P=${d.codes.persona} H=${d.codes.hook} B=${d.codes.body} A=${d.codes.angle}`);
  lines.push(`\nСПИСОК РАЗВЕДКИ (концепции, выбранные на тест): ${(b.exploreList ?? []).join(", ") || "—"}`);
  lines.push(`\nВИННЕРЫ-ОСНОВА (метрики ЗА ПЕРИОД ОТЧЁТА, те же, что в обосновании слотов) и их коды:`);
  for (const w of b.winners ?? []) lines.push(`  ${w.adName}: CPL ${eur(w.cpl)}, лиды ${w.leads}, спенд ${eur(w.spend)}; коды P=${w.codes.persona} H=${w.codes.hook} B=${w.codes.body} A=${w.codes.angle} V=${w.concept ?? "—"} actor=${w.actor ?? "—"}`);
  lines.push(`\nБИБЛИОТЕКА (код → полный дословный текст):`);
  for (const [c, t] of Object.entries(b.labels)) lines.push(`  ${c}: «${t.replace(/\s+/g, " ")}»`);
  lines.push(`\nСЛОТЫ (только коды; тексты — по БИБЛИОТЕКЕ):`);
  for (const s of b.slots) {
    const ch = s.change;
    lines.push(`#${s.slotId} [${s.category}] основа ${s.basedOnAd ?? "—"}${s.fromWinners?.length ? `; fromWinners: ${s.fromWinners.join(", ")}` : ""}; коды: P=${s.codes.persona} H=${s.codes.hook} B=${s.codes.body} A=${s.codes.angle} V=${s.codes.concept ?? "—"} actor=${s.codes.actor ?? "—"}` +
      (ch ? `; ИЗМЕНЕНИЕ kind=${ch.kind ?? "?"} tier=${ch.tier ?? "—"} ось=${ch.axis}: было ${ch.fromCode ?? "—"} → стало ${ch.toCode}` : "") +
      `; обоснование: ${s.rationale}`);
  }
  if (b.notes?.length) lines.push(`\nNOTES (измеримость): ${b.notes.join(" | ")}`);
  const verifications = await runDualVerification(INSTRUCTION, lines.join("\n"));
  // Статус выводим из тяжести замечаний (модели иногда ставят fail при одних low) — детерминированно
  for (const c of verifications.checks) {
    if (c.status === "skipped" || c.status === "error") continue;
    // Замечания, где модель сама пишет «совпадает/соблюдено/ок» без «не …», — не несоответствие данным → low
    for (const i of c.issues) if (/(совпада|соблюд|\bок\b)/i.test(i.detail) && !/не\s+(совпада|соблюд)/i.test(i.detail) && !/(нет в|отсутств|выдуман|подмен)/i.test(i.detail)) i.severity = "low";
    const worst = c.issues.some(i => i.severity === "high") ? "fail" : c.issues.some(i => i.severity === "medium") ? "warning" : "ok";
    c.status = worst;
  }
  verifications.overall = verifications.checks.some(c => c.status === "fail") ? "fail" : verifications.checks.some(c => c.status === "warning") ? "warning" : "ok";
  return NextResponse.json({ ok: true, verifications });
}
