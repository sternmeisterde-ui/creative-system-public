import { NextRequest, NextResponse } from "next/server";
import { fetchAll } from "@/lib/paged";
import { createServiceClient } from "@/lib/supabase";
import type { AdNameMapping } from "@/lib/naming";
import { computeBivariate } from "@/lib/bivariate";
import { matchesProduct, isProduct } from "@/lib/product";
import { loadLabelMap } from "@/lib/formulations";

// Типы и расчёт — в lib/bivariate.ts (переиспользуются отчётом за период). Здесь — только загрузка данных.
export type { BivariateResult, FamilyMember, GenealogyFamily } from "@/lib/bivariate";

// ── GET /api/analytics/bivariate ─────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const platform = req.nextUrl.searchParams.get("platform");
  const prodQ = req.nextUrl.searchParams.get("product"); const product = isProduct(prodQ) ? prodQ : "all";
  const supabase = createServiceClient();

  const [adsResult, mappingResult, labelMap] = await Promise.all([
    fetchAll((f, t) => {
      let q = supabase.from("creative_performance").select("ad_name, campaign_name, adset_name, spend, impressions, leads, qual_leads, auto_status, video_3s, video_thruplay").not("ad_name", "is", null);
      if (platform && platform !== "all") q = q.eq("platform", platform);
      return q.order("ad_id").range(f, t);
    }),
    fetchAll(( f, t) => supabase.from("ad_name_mapping").select("ad_name, persona_code, hook_code, body_code, angle_code, format, flow, concept_code, actor_code").order("ad_name").range(f, t)),
    loadLabelMap(supabase), // подписи = дословные формулировки + концепции + актёры
  ]);

  if (adsResult.error) return NextResponse.json({ error: adsResult.error }, { status: 500 });

  const mapping: AdNameMapping[] = (mappingResult.data ?? []).map(r => ({
    adName: r.ad_name, personaCode: r.persona_code, hookCode: r.hook_code,
    bodyCode: r.body_code, angleCode: r.angle_code, format: r.format, flow: r.flow, conceptCode: r.concept_code ?? null, actorCode: r.actor_code ?? null,
  }));

  const { totalAds, totalSpend, totalLeads, results, families } = computeBivariate(
    (adsResult.data ?? []).filter(row => matchesProduct(row, product)).map(row => ({
      adName: String(row.ad_name ?? ""),
      spend: parseFloat(row.spend ?? 0), leads: parseInt(row.leads ?? 0), impressions: parseInt(row.impressions ?? 0),
      video3s: parseInt(row.video_3s ?? 0), videoThru: parseInt(row.video_thruplay ?? 0),
      autoStatus: row.auto_status as string,
    })),
    mapping, labelMap,
  );

  return NextResponse.json({ ok: true, totalAds, totalSpend, totalLeads, results, families: families.slice(0, 30) });
}
