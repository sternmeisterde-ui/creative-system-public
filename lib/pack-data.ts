// ── Данные для движка пака (lib/pack-engine.ts): маппинг, формулировки, концепции, актёры, использование ──
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AdNameMapping } from "@/lib/naming";
import { loadFormulations, ensureFormulation, type Formulation, type FormulationProduct } from "@/lib/formulations";
import { outdatedIn, applyNorms } from "@/lib/norms";
import type { EngineConcept, EngineActor, EngineRow, Medium } from "@/lib/pack-engine";
import { matchesProduct } from "@/lib/product";
import { propagateCopyMappings } from "@/lib/mapping-copies";

export interface EngineData {
  mapping: AdNameMapping[];
  formulations: Formulation[];
  concepts: EngineConcept[];
  actors: EngineActor[];
  usage: Record<string, number>;
  labels: Record<string, string>;   // код → текст формулировки / имя концепции / имя актёра (для UI и ТЗ)
  medium: Record<string, Medium>;   // ad_name → видео | статика (по meta_creatives)
  lifetimeRows: EngineRow[];        // весь срок, Meta, только этот продукт — уровень B сигналов
  successors: Record<string, string>; // устаревшая формулировка → преемник с новой нормой (lib/norms.ts)
}

export async function loadEngineData(sb: SupabaseClient, product: FormulationProduct): Promise<EngineData> {
  await propagateCopyMappings(sb).catch(() => undefined); // копии объявлений наследуют маппинг базового имени
  const mappingRows: Array<{ ad_name: string; persona_code: string | null; hook_code: string | null; body_code: string | null; angle_code: string | null; format: string | null; flow: string | null; concept_code: string | null; actor_code: string | null }> = [];
  for (let from = 0; ; from += 1000) {
    const { data } = await sb.from("ad_name_mapping").select("ad_name, persona_code, hook_code, body_code, angle_code, format, flow, concept_code, actor_code").order("ad_name").range(from, from + 999);
    mappingRows.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  const [formulations, conceptsRes, actorsRes] = await Promise.all([
    loadFormulations(sb, { product }),
    sb.from("concepts").select("code, name, category, is_ours").order("code"),
    sb.from("actors").select("code, name, kind, gender").order("kind").order("code"),
  ]);
  // медиа крео: видео, если есть video_id или object_type VIDEO; иначе статика
  const medium: Record<string, Medium> = {};
  for (let from = 0; ; from += 1000) {
    const { data } = await sb.from("meta_creatives").select("ad_name, video_id, object_type, platform").order("ad_id").range(from, from + 999);
    for (const c of (data ?? []) as { ad_name: string; video_id: string | null; object_type: string | null; platform: string | null }[]) {
      // Google (05.11.2026): ассеты PMax/YouTube тоже получают медиа — video_id = ролик YouTube, IMAGE = статика; коды им даёт /mapping/google
      const isVideo = !!c.video_id || c.object_type === "VIDEO";
      if (isVideo || !medium[c.ad_name]) medium[c.ad_name] = isVideo ? "video" : "static";
    }
    if (!data || data.length < 1000) break;
  }
  // lifetime строки Meta по продукту — для уровня B (HELPS за весь срок) и свежести (last_seen)
  const lifetimeRows: EngineRow[] = [];
  for (let from = 0; ; from += 1000) {
    const { data } = await sb.from("creative_performance").select("ad_name, campaign_name, adset_name, auto_status, spend, cpl, cpql, leads, last_seen").eq("platform", "meta").not("ad_name", "is", null).order("ad_id").range(from, from + 999);
    for (const r of (data ?? []) as Array<{ ad_name: string; campaign_name: string | null; adset_name: string | null; auto_status: string; spend: unknown; cpl: unknown; cpql: unknown; leads: unknown; last_seen: string | null }>) {
      if (!matchesProduct(r, product)) continue;
      lifetimeRows.push({ ad_name: r.ad_name, auto_status: r.auto_status, spend: Number(r.spend ?? 0), cpl: r.cpl == null ? null : Number(r.cpl), cpql: r.cpql == null ? null : Number(r.cpql), leads: Number(r.leads ?? 0), last_seen: r.last_seen });
    }
    if (!data || data.length < 1000) break;
  }
  const mapping: AdNameMapping[] = mappingRows.map(r => ({
    adName: r.ad_name, personaCode: r.persona_code, hookCode: r.hook_code, bodyCode: r.body_code, angleCode: r.angle_code,
    format: r.format, flow: r.flow, conceptCode: r.concept_code ?? null, actorCode: r.actor_code ?? null,
  }));
  const usage: Record<string, number> = {};
  for (const r of mappingRows) for (const c of [r.persona_code, r.hook_code, r.body_code, r.angle_code, r.concept_code, r.actor_code]) if (c) usage[c] = (usage[c] ?? 0) + 1;
  const concepts: EngineConcept[] = ((conceptsRes.data ?? []) as { code: string | null; name: string; category: string | null; is_ours: boolean }[])
    .filter(c => c.code).map(c => ({ code: c.code as string, name: c.name, category: c.category, isOurs: !!c.is_ours }));
  const actors: EngineActor[] = ((actorsRes.data ?? []) as { code: string; name: string; kind: string; gender: string | null }[]).map(a => ({ code: a.code, name: a.name, kind: a.kind, gender: a.gender === "f" || a.gender === "m" ? a.gender : null }));
  // Устаревшие факты (brief.config.ts → outdated_claims): преемник создаётся лениво, один раз, с parent_code
  const successors: Record<string, string> = {};
  for (const f of [...formulations]) {
    const claim = outdatedIn(f.text, product);
    if (!claim) continue;
    const text = applyNorms(f.text, product);
    if (text === f.text) continue;
    try {
      const { formulation: nf } = await ensureFormulation(sb, { axis: f.axis, product, text, source: "norm-update", parentCode: f.code, note: `Преемник ${f.code}: ${claim.note}` });
      successors[f.code] = nf.code;
      if (!formulations.some(x => x.code === nf.code)) formulations.push(nf);
    } catch { /* нет преемника — слот с этой формулировкой снимет движок */ }
  }
  const labels: Record<string, string> = {};
  for (const f of formulations) labels[f.code] = f.text;
  for (const c of concepts) labels[c.code] = c.name;
  for (const a of actors) labels[a.code] = a.name;
  return { mapping, formulations, concepts, actors, usage, labels, medium, lifetimeRows, successors };
}
