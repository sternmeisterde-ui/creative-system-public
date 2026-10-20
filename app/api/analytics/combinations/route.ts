import { NextRequest, NextResponse } from "next/server";
import { fetchAll } from "@/lib/paged";
import { createServiceClient } from "@/lib/supabase";
import type { AdNameMapping } from "@/lib/naming";
import { computeCombinations } from "@/lib/combinations";
import { matchesProduct, isProduct } from "@/lib/product";

export type { ComboStat } from "@/lib/combinations";

export async function GET(req: NextRequest) {
  const platform = req.nextUrl.searchParams.get("platform");
  const prodQ = req.nextUrl.searchParams.get("product"); const product = isProduct(prodQ) ? prodQ : "all";
  const supabase = createServiceClient();

  const [adsResult, mappingResult] = await Promise.all([
    fetchAll((f, t) => supabase
      .from("creative_performance")
      .select("ad_name, campaign_name, adset_name, spend, leads, qual_leads, auto_status")
      .not("ad_name", "is", null)
      .filter("platform", platform && platform !== "all" ? "eq" : "neq", platform && platform !== "all" ? platform : "__none__")
      .order("ad_id").range(f, t)),
    fetchAll(( f, t) => supabase.from("ad_name_mapping").select("ad_name, persona_code, hook_code, body_code, angle_code, format, flow, concept_code, actor_code").order("ad_name").range(f, t)),
  ]);

  if (adsResult.error) return NextResponse.json({ error: adsResult.error }, { status: 500 });

  const mapping: AdNameMapping[] = (mappingResult.data ?? []).map(r => ({
    adName:      r.ad_name,
    personaCode: r.persona_code,
    hookCode:    r.hook_code,
    bodyCode:    r.body_code,
    angleCode:   r.angle_code,
    format:      r.format,
    flow:        r.flow, conceptCode: r.concept_code ?? null, actorCode: r.actor_code ?? null,
  }));

  const result = computeCombinations(
    (adsResult.data ?? []).filter(row => matchesProduct(row, product)).map(row => ({
      adName: String(row.ad_name ?? ""), spend: parseFloat(row.spend ?? 0),
      leads: parseInt(row.leads ?? 0), qualLeads: parseInt(row.qual_leads ?? 0), autoStatus: row.auto_status as string,
    })),
    mapping,
  );

  return NextResponse.json({ ok: true, combinations: result });
}
