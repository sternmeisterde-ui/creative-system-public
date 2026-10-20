// ── Последний отчёт как основа производственного флоу ────────────────────────
// Конструктор → сценарии → брифы строятся на ПОСЛЕДНЕМ отчёте продукта (analysis_reports):
// его виннеры/лузеры (snapshot), сигналы бивариата (visual) и рекомендации (narrative).
// Здесь — загрузка нужного отчёта и общий текстовый блок для промптов.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ReportKpi, ReportVisual, ReportVerifications } from "@/lib/types";
import { productMeta, type Product } from "@/lib/product";

export interface ReportSnapshotRow {
  ad_name: string; auto_status: string; spend: number; cpl: number | null; cpql: number | null;
  leads: number; qual_leads: number; roas: number | null; cr_lead_to_qual: number | null; risk_signals: string[];
}
export interface ReportSnapshot { thresholds: { cplTarget: number; cpqlTarget: number }; rows: ReportSnapshotRow[]; testing: number }

export interface ReportRow {
  id: string; created_at: string; platform: string; product: string; date_from: string | null; date_to: string | null;
  kpi: ReportKpi; visual: ReportVisual; narrative: string; verifications: ReportVerifications | null; snapshot: ReportSnapshot | null;
}

/** Короткая ссылка на отчёт — хранится в pack_metadata.report и показывается в UI. */
export interface ReportRef { id: string; createdAt: string; platform: string; product: string; dateFrom: string | null; dateTo: string | null; overall: string | null }

export const reportRef = (r: ReportRow): ReportRef => ({
  id: r.id, createdAt: r.created_at, platform: r.platform, product: r.product,
  dateFrom: r.date_from, dateTo: r.date_to, overall: r.verifications?.overall ?? null,
});

const CHANNEL: Record<string, string> = { all: "все каналы", meta: "Meta Ads", google: "Google Ads", tiktok: "TikTok Ads" };
export const reportPeriodLabel = (r: { date_from?: string | null; date_to?: string | null; dateFrom?: string | null; dateTo?: string | null }) => {
  const from = r.date_from ?? r.dateFrom; const to = r.date_to ?? r.dateTo;
  return from && to ? `${from} – ${to}` : "весь период";
};

/**
 * Последний отчёт по продукту. Производство — под Meta, поэтому сначала отчёт по каналу meta,
 * затем общий (all), затем любой. Продукт совпадает строго (для "all" — общий отчёт).
 */
export async function loadLatestReport(supabase: SupabaseClient, product: Product): Promise<ReportRow | null> {
  for (const platform of ["meta", "all", null]) {
    let q = supabase.from("analysis_reports")
      .select("id, created_at, platform, product, date_from, date_to, kpi, visual, narrative, verifications, snapshot")
      .eq("product", product).order("created_at", { ascending: false }).limit(1);
    if (platform) q = q.eq("platform", platform);
    const { data } = await q.maybeSingle();
    if (data) return data as ReportRow;
  }
  return null;
}

export async function loadReportById(supabase: SupabaseClient, id: string): Promise<ReportRow | null> {
  const { data } = await supabase.from("analysis_reports")
    .select("id, created_at, platform, product, date_from, date_to, kpi, visual, narrative, verifications, snapshot")
    .eq("id", id).maybeSingle();
  return (data as ReportRow | null) ?? null;
}

/** Секция рекомендаций из нарратива (с заголовка «Рекомендации» до конца); если нет — хвост нарратива. */
export function recommendationsSection(narrative: string, maxChars = 5000): string {
  const idx = narrative.search(/^#{1,4}\s*(\d+\.\s*)?.*Рекомендац/im);
  const text = idx >= 0 ? narrative.slice(idx) : narrative.slice(-Math.min(narrative.length, maxChars));
  return text.length > maxChars ? text.slice(0, maxChars) + "\n…" : text;
}

/**
 * Текстовый блок для промптов конструктора / сценариев / брифов: откуда данные, KPI, сигналы,
 * рекомендации. `mode` full — с рекомендациями целиком (пак), short — только сигналы и суть (сценарии/брифы).
 */
export function reportContextBlock(r: ReportRow, mode: "full" | "short" = "full"): string {
  const eur = (v: number | null | undefined) => (v == null ? "—" : `€${v.toFixed(1)}`);
  const sig = (arr: { code: string; label?: string | null; ratio: number | null }[] | undefined, n = 12) =>
    (arr ?? []).slice(0, n).map(s => `${s.code}${s.label ? ` (${s.label})` : ""} ×${s.ratio?.toFixed(2) ?? "—"}`).join(", ") || "—";
  const head = `Отчёт от ${new Date(r.created_at).toLocaleString("ru-RU")} · продукт: ${productMeta((r.product as Product) ?? "all").label} · канал: ${CHANNEL[r.platform] ?? r.platform} · период: ${reportPeriodLabel(r)} · проверка Gemini+Codex: ${r.verifications?.overall ?? "нет"}`;
  const kpi = `KPI отчёта: креативов ${r.kpi.activeAds}, виннеров ${r.kpi.winners}, fake ${r.kpi.fakeWinners}, лузеров ${r.kpi.losers}, в тесте ${r.kpi.testing}; спенд €${r.kpi.totalSpend.toFixed(0)}, blended CPL ${eur(r.kpi.blendedCpl)}, CPQL ${eur(r.kpi.blendedCpql)}; пакет: ${r.kpi.packHealth}.`;
  const signals = `HELPS (снижают CPL): ${sig(r.visual.helps)}\nHURTS (повышают CPL): ${sig(r.visual.hurts)}` +
    (r.visual.hookHelps?.length ? `\nХуки, которые цепляют (hook rate выше среднего): ${r.visual.hookHelps.slice(0, 8).map(h => `${h.code} ${h.hookRate?.toFixed(1) ?? "—"}%`).join(", ")}` : "") +
    (r.visual.combos?.length ? `\nКомбинации с виннерами: ${r.visual.combos.slice(0, 6).map(c => `${c.codes} (${c.winners} win, CPL ${eur(c.cpl)})`).join("; ")}` : "");
  if (mode === "short") return `${head}\n${kpi}\n${signals}`;
  return `${head}\n${kpi}\n${signals}\n\nРЕКОМЕНДАЦИИ ОТЧЁТА (следуй им, это принятое человеком направление):\n${recommendationsSection(r.narrative)}`;
}

export const reportAgeDays = (r: { created_at?: string; createdAt?: string }) =>
  Math.floor((Date.now() - new Date(r.created_at ?? r.createdAt ?? Date.now()).getTime()) / 864e5);
