import { NextRequest, NextResponse } from "next/server";
import { Document, Packer, Paragraph, Table, TextRun, AlignmentType } from "docx";
import { FONT, eur, ruDate, runs, para, h1, h2, small, table, markdownToDocx } from "@/lib/docx";
import { createServiceClient } from "@/lib/supabase";
import { productMeta, isProduct } from "@/lib/product";
import type { ReportKpi, ReportVisual, ReportVerifications, ReportSignal, ReportHookSignal } from "@/lib/types";

// GET /api/analytics/report/docx?id=<uuid> — отчёт по массиву в DOCX: шапка (продукт · канал · период),
// проверка Gemini+Codex, KPI, сигналы бивариата, hook-rate, семьи, комбо, конкуренты, полный нарратив
// (markdown → абзацы/списки/таблицы). Числа берутся из сохранённого снапшота, ничего не пересчитываем.
export const maxDuration = 60;

const CHANNEL: Record<string, string> = { all: "все каналы", meta: "Meta Ads", google: "Google Ads", tiktok: "TikTok Ads" };
const HEALTH: Record<string, string> = { healthy: "пакет живёт", warning: "пакет слабеет", dying: "пакет выгорает", unknown: "нет данных" };
const STATUS: Record<string, string> = { ok: "OK", warning: "Сомнения", fail: "Не пройдено", skipped: "Пропущено", error: "Ошибка" };
const PARAM: Record<string, string> = { persona: "Персона", hook: "Хук", body: "Боди", angle: "Энгл", format: "Формат", concept: "Концепция", actor: "Актёр", flow: "Поток" };

const ru = ruDate;

export async function GET(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id обязателен" }, { status: 400 });
  const supabase = createServiceClient();
  const { data: r, error } = await supabase.from("analysis_reports").select("*").eq("id", id).maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!r) return NextResponse.json({ error: "отчёт не найден" }, { status: 404 });

  const kpi = r.kpi as ReportKpi; const visual = (r.visual ?? {}) as ReportVisual; const ver = (r.verifications ?? null) as ReportVerifications | null;
  const product = isProduct(r.product) ? r.product : "all";
  const productLabel = productMeta(product).label;
  const channel = CHANNEL[r.platform as string] ?? r.platform ?? "все каналы";
  const period = r.date_from && r.date_to ? `${ru(r.date_from)} – ${ru(r.date_to)}` : "весь период (lifetime)";
  const generated = new Date(r.created_at).toLocaleString("ru-RU");

  const children: (Paragraph | Table)[] = [];
  children.push(new Paragraph({ children: [new TextRun({ text: `Отчёт по массиву креативов · ${productLabel}`, font: FONT, bold: true, size: 40, color: "1F2A44" })], spacing: { after: 60 } }));
  children.push(para(`${channel} · ${period}`, { size: 24, color: "2E6F8E", bold: true }));
  children.push(small(`Сгенерирован ${generated} · Creative System. Числа посчитаны кодом по снапшоту; разбор — Claude; проверка — Gemini и Codex.`));

  // ── Проверка
  if (ver) {
    children.push(h1(`Проверка отчёта: ${STATUS[ver.overall] ?? ver.overall}`));
    for (const c of ver.checks ?? []) {
      children.push(para(`${c.model === "gemini" ? "Gemini" : c.model === "codex" ? "Codex (OpenAI)" : c.model}: ${STATUS[c.status] ?? c.status} · уверенность ${Math.round((c.confidence ?? 0) * 100)}%`, { bold: true, spacing: { before: 100 } }));
      if (c.summary) children.push(para(c.summary));
      for (const is of c.issues ?? []) children.push(new Paragraph({ children: runs(`**${is.area}** (${is.severity}) — ${is.detail}`, { size: 20 }), bullet: { level: 0 }, spacing: { after: 40 } }));
    }
    if (ver.overall === "fail") children.push(para("Внимание: проверка не пройдена — числам и выводам ниже доверять нельзя без перепроверки источника данных.", { bold: true, color: "B23A3A" }));
  }

  // ── KPI
  children.push(h1("Ключевые показатели"));
  children.push(table(
    ["Показатель", "Значение"],
    [
      ["Здоровье пакета", HEALTH[kpi.packHealth] ?? kpi.packHealth],
      ["Креативов в отчёте", String(kpi.activeAds)],
      ["Виннеров", String(kpi.winners)], ["Fake winners", String(kpi.fakeWinners)], ["Лузеров", String(kpi.losers)], ["В тесте", String(kpi.testing)],
      ["Спенд", eur(kpi.totalSpend, 0)], ["Blended CPL", eur(kpi.blendedCpl)], ["Blended CPQL", eur(kpi.blendedCpql)],
    ], [55, 45],
  ));
  if (r.date_from) children.push(small("Режим окна дат: статусы winner/loser считаются по CPL и CPQL за период; ROAS, возраст и fake winners в окне не считаются."));

  // ── Сигналы бивариата
  const sigRows = (arr: ReportSignal[]) => arr.map(s => [s.code, PARAM[s.paramType] ?? s.paramType, s.label ?? "", s.ratio == null ? "—" : `×${s.ratio.toFixed(2)}`]);
  children.push(h1("Сигналы по массиву (бивариат)"));
  children.push(small("Ratio = CPL креативов с этим кодом / CPL остальных. Меньше 1 — код снижает CPL (HELPS), больше 1 — повышает (HURTS)."));
  children.push(h2(`HELPS — снижают CPL (${visual.helps?.length ?? 0})`));
  if (visual.helps?.length) children.push(table(["Код", "Тип", "Название", "Ratio"], sigRows(visual.helps), [14, 16, 54, 16])); else children.push(para("Недостаточно данных."));
  children.push(h2(`HURTS — повышают CPL (${visual.hurts?.length ?? 0})`));
  if (visual.hurts?.length) children.push(table(["Код", "Тип", "Название", "Ratio"], sigRows(visual.hurts), [14, 16, 54, 16])); else children.push(para("Недостаточно данных."));

  const hookRows = (arr: ReportHookSignal[]) => arr.map(s => [s.code, s.label ?? "", s.hookRate == null ? "—" : `${s.hookRate.toFixed(1)} %`, s.holdRate == null ? "—" : `${s.holdRate.toFixed(1)} %`, s.ratio == null ? "—" : `×${s.ratio.toFixed(2)}`]);
  if (visual.hookHelps?.length || visual.hookHurts?.length) {
    children.push(h1("Hook rate по хукам (плеи / показы)"));
    if (visual.hookHelps?.length) { children.push(h2("Цепляют сильнее среднего")); children.push(table(["Код", "Хук", "Hook rate", "Hold rate", "Ratio"], hookRows(visual.hookHelps), [12, 48, 14, 14, 12])); }
    if (visual.hookHurts?.length) { children.push(h2("Цепляют слабее среднего")); children.push(table(["Код", "Хук", "Hook rate", "Hold rate", "Ratio"], hookRows(visual.hookHurts), [12, 48, 14, 14, 12])); }
  }

  if (visual.families?.length) {
    children.push(h1("Семьи креативов (3 кода общие, 1 варьируется)"));
    children.push(table(["Общие коды", "Варьируется", "Лучший CPL", "Худший CPL", "Разброс"],
      visual.families.map(f => [f.shared, PARAM[f.varyingParam] ?? f.varyingParam, eur(f.bestCpl), eur(f.worstCpl), eur(f.spread)]), [34, 18, 16, 16, 16]));
  }
  if (visual.combos?.length) {
    children.push(h1("Комбинации параметров с виннерами"));
    children.push(table(["Комбинация", "Виннеров", "CPL", "Спенд"], visual.combos.map(c => [c.codes, String(c.winners), eur(c.cpl), eur(c.spend, 0)]), [40, 18, 20, 22]));
  }
  if (visual.competitors?.length) {
    children.push(h1("Одобренные концепты конкурентов"));
    children.push(table(["Название", "Тип", "Хук"], visual.competitors.map(c => [c.title, c.type ?? "—", c.hook ?? "—"]), [34, 16, 50]));
  }

  // ── Нарратив
  children.push(h1("Разбор и рекомендации к производству"));
  children.push(...markdownToDocx(String(r.narrative ?? "")));

  const doc = new Document({
    creator: "Creative System",
    title: `Отчёт · ${productLabel} · ${channel} · ${period}`,
    styles: { default: { document: { run: { font: FONT, size: 22 } } } },
    sections: [{ properties: { page: { margin: { top: 1000, bottom: 1000, left: 1100, right: 1100 } } }, children }],
  });
  const buf = await Packer.toBuffer(doc);
  const slug = (s: string) => s.replace(/[^\p{L}\p{N}]+/gu, "_").replace(/^_|_$/g, "");
  const fname = `Отчёт_${slug(productLabel)}_${slug(channel)}_${r.date_from && r.date_to ? `${r.date_from}_${r.date_to}` : "lifetime"}_${String(r.created_at).slice(0, 10)}.docx`;
  return new NextResponse(new Uint8Array(buf), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "Content-Disposition": `attachment; filename="report.docx"; filename*=UTF-8''${encodeURIComponent(fname)}`,
      "Cache-Control": "no-store",
    },
  });
}
