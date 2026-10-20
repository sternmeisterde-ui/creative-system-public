import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";
import { isProduct, productMeta } from "@/lib/product";
import { loadLatestReport, loadReportById, reportRef } from "@/lib/report-context";
import { loadEngineData } from "@/lib/pack-data";
import { designPack, DEFAULT_BLOCKED_CONCEPTS } from "@/lib/pack-engine";
import type { Format } from "@/lib/types";
import { loadReferences } from "@/lib/references";

// POST — предпросмотр пака (без сохранения): детерминированный дизайн эксперимента на последнем отчёте продукта.
// Используется разделом «Следующий пак» в отчёте и конструктором. Сохранение — POST /api/pack/generate { slots, ... }.
export const maxDuration = 60;

export interface ProposeBody {
  product?: string; reportId?: string; format?: Format; packSize?: number;
  exploreConcepts?: string[]; autoExplore?: number; blockedConcepts?: string[]; actorPool?: string[] | null;
  actorKind?: "ai" | "real" | null; transfer?: boolean;
  shares?: { scale: number; family: number; explore: number; transfer: number };
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({})) as ProposeBody;
  const product = isProduct(body.product) ? body.product : "all";
  if (product === "all") return NextResponse.json({ error: "Выбери продукт (Бухгалтер или Медадмин) — формулировки привязаны к продукту." }, { status: 400 });
  const sb = createServiceClient();
  const report = body.reportId ? await loadReportById(sb, body.reportId) : await loadLatestReport(sb, product);
  if (!report) return NextResponse.json({ error: `Нет отчёта по продукту «${productMeta(product).label}» — сначала собери отчёт.`, gate: "no_report" }, { status: 409 });
  const rows = (report.snapshot?.rows ?? []).map(r => ({ ad_name: r.ad_name, auto_status: r.auto_status, spend: Number(r.spend ?? 0), cpl: r.cpl, cpql: r.cpql, leads: Number(r.leads ?? 0) }));
  if (!rows.length) return NextResponse.json({ error: "У отчёта нет снапшота строк — перегенерируй отчёт." }, { status: 409 });

  const data = await loadEngineData(sb, product);
  const format: Format = body.format ?? "ugc";
  const result = designPack({
    format, packSize: Math.max(3, Math.min(40, Number(body.packSize) || 20)),
    rows, lifetimeRows: data.lifetimeRows, medium: data.medium, mapping: data.mapping, formulations: data.formulations, concepts: data.concepts, actors: data.actors, usage: data.usage,
    exploreConcepts: body.exploreConcepts ?? [], autoExplore: body.autoExplore ?? 2, blockedConcepts: body.blockedConcepts ?? DEFAULT_BLOCKED_CONCEPTS,
    actorPool: body.actorPool ?? null, actorKind: body.actorKind ?? null, transfer: body.transfer ?? true, shares: body.shares,
  });
  // Подписи только для кодов, которые встречаются в результате
  const used = new Set<string>();
  for (const s of result.slots) for (const c of Object.values(s.codes)) if (c) used.add(c);
  for (const s of result.slots) { if (s.change?.fromCode) used.add(s.change.fromCode); if (s.change?.toCode) used.add(s.change.toCode); }
  for (const c of result.matrix) used.add(c.code);
  for (const w of [...result.winners, ...result.transferDonors]) for (const c of [w.codes.persona, w.codes.hook, w.codes.body, w.codes.angle, w.concept, w.actor]) if (c) used.add(c);
  const labels: Record<string, string> = {};
  for (const c of used) if (data.labels[c]) labels[c] = data.labels[c];
  // Референсы: где уже стояли коды (топ по спенду, с медиа) и метрики виннеров-основ — для «было → стало» и проверки
  const origin = `${req.headers.get("x-forwarded-proto") ?? "https"}://${req.headers.get("host") ?? "localhost:3000"}`;
  const refCodes = Array.from(new Set(result.slots.flatMap(s => [s.change?.fromCode, s.change?.toCode, s.codes.concept]).filter((c): c is string => !!c)));
  const refs = await loadReferences(sb, { codes: refCodes, adNames: result.winnersUsed, origin, perCode: 3, product });
  const untestedConcepts = data.concepts.filter(c => (data.usage[c.code] ?? 0) <= 1).map(c => ({ code: c.code, name: c.name, category: c.category, used: data.usage[c.code] ?? 0 }));
  const testedConcepts = data.concepts.filter(c => (data.usage[c.code] ?? 0) >= 2).map(c => ({ code: c.code, name: c.name, category: c.category, used: data.usage[c.code] ?? 0 }));

  return NextResponse.json({
    ok: true, report: reportRef(report), format, product,
    slots: result.slots, distribution: result.distribution, matrix: result.matrix, notes: result.notes, winnersUsed: result.winnersUsed, debug: result.debug,
    signals: {
      helps: result.signals.helps.slice(0, 20).map(r => ({ code: r.code, paramType: r.paramType, ratio: r.ratio, withCount: r.withCount, withCpl: r.withCpl })),
      hurts: result.signals.hurts.slice(0, 20).map(r => ({ code: r.code, paramType: r.paramType, ratio: r.ratio, withCount: r.withCount })),
      helpsConcepts: result.signals.helpsConcepts.map(r => ({ code: r.code, ratio: r.ratio, withCount: r.withCount, withCpl: r.withCpl })),
      lifetimeHelps: result.signals.lifetimeHelps.slice(0, 30).map(r => ({ code: r.code, paramType: r.paramType, ratio: r.ratio, withCount: r.withCount, withCpl: r.withCpl })),
    },
    tiers: result.tiers, medium: result.medium, transferDonors: result.transferDonors,
    labels, refs, winners: result.winners, exploreList: result.exploreList, concepts: { untested: untestedConcepts, tested: testedConcepts }, actors: data.actors,
  });
}
