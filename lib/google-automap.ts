// ── Прокладка Google → коды формулировок (06.11.2026) ──────────────────────────────────────────────────
// Google-креативы перед отчётом проходят через маппинг, чтобы анализ шёл по тем же кодам, что в Meta.
// Правило (решение пользователя 06.11): ТЕКСТОВЫЕ коды наследуются по тексту, ИДЕНТИЧНОСТЬ креатива
// (актёр, концепция, «это копия такого-то») — только по визуалу. Один сценарий бывает переснят с другим актёром.
//   • статика: dHash картинки ≈ размеченный креатив (Meta или уже сопоставленный Google) → копия, все коды;
//   • иначе Gemini выписывает тексты дословно → ensureFormulation находит существующие коды по точному тексту
//     или создаёт новые (applyExtraction); визуал не совпал → креатив отдельный;
//   • видео: тексты так же; актёр и концепция — только если Gemini видит ТОТ ЖЕ съёмочный материал среди
//     Meta-роликов с теми же кодами; иначе «новая съёмка», актёр/концепция пустые.
// Ролики YouTube у рекламы скрытые: Gemini читает только Storage-копию (scripts/google-video-backfill.py).
import type { SupabaseClient } from "@supabase/supabase-js";
import { ensureFormulation, isFormulationCode, loadFormulations, textKey, EXTRACTION_FIELD } from "@/lib/formulations";
import type { VerbatimExtraction } from "@/lib/formulations";
import { trigrams, dice, containment, SAME_FORMULATION_MIN, SAME_CREATIVE_MIN, SAME_CREATIVE_REVERSE_MIN } from "@/lib/text-match";
import { compareSameShoot, extractVerbatim, resolveMetaImageSource } from "@/lib/gemini";
import { fetchImageHash, hamming, SAME_IMAGE_MAX_DISTANCE } from "@/lib/fingerprint";
import { detectProduct } from "@/lib/product";

interface MapRow { ad_name: string; persona_code: string | null; hook_code: string | null; body_code: string | null; angle_code: string | null; concept_code: string | null; actor_code: string | null; format: string | null; product: string | null; mapped_by: string | null }
interface CreoRow { ad_id: string; ad_name: string; platform: string | null; object_type: string | null; video_id: string | null; asset_url: string | null; image_url: string | null; thumbnail_url: string | null }
interface FpRow { ad_name: string; platform: string; dhash: string | null }

export interface AutomapStats {
  processed: number; byHash: number; byText: number; textNoCodes: number; visualMatched: number; newShoot: number;
  needVideoDownload: number; metaFingerprinted: number; remaining: number; errors: string[];
}

const baseName = (s: string) => { let p; do { p = s; s = s.replace(/\s*[-–—]\s*Copy(\s*\d+)?$/i, "").replace(/\s*\(\d+\)$/, ""); } while (s !== p); return s.trim(); };
const hasCodes = (m?: MapRow | null) => !!m && [m.hook_code, m.body_code, m.angle_code].every(c => isFormulationCode(c));
const isStorage = (u: string | null) => !!u && u.includes("/storage/v1/");

async function fetchAll<T>(sb: SupabaseClient, table: string, select: string, eq?: [string, string]): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    let q = sb.from(table).select(select).range(from, from + 999);
    if (eq) q = q.eq(eq[0], eq[1]);
    const { data, error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...((data ?? []) as T[]));
    if (!data || data.length < 1000) break;
  }
  return out;
}

export async function automapGoogle(sb: SupabaseClient, opts: { deadlineMs: number; limit?: number; metaFingerprintLimit?: number; only?: "image" | "video" }): Promise<AutomapStats> {
  const st: AutomapStats = { processed: 0, byHash: 0, byText: 0, textNoCodes: 0, visualMatched: 0, newShoot: 0, needVideoDownload: 0, metaFingerprinted: 0, remaining: 0, errors: [] };
  const timeLeft = () => opts.deadlineMs - Date.now();

  const [mapping, creos, fps, gAds] = await Promise.all([
    fetchAll<MapRow>(sb, "ad_name_mapping", "ad_name, persona_code, hook_code, body_code, angle_code, concept_code, actor_code, format, product, mapped_by"),
    fetchAll<CreoRow>(sb, "meta_creatives", "ad_id, ad_name, platform, object_type, video_id, asset_url, image_url, thumbnail_url"),
    fetchAll<FpRow>(sb, "creative_fingerprints", "ad_name, platform, dhash"),
    fetchAll<{ ad_name: string; campaign_name: string | null; spend: number | null }>(sb, "meta_ads", "ad_name, campaign_name, spend", ["platform", "google"]),
  ]);
  const mapByName = new Map(mapping.map(m => [m.ad_name, m]));
  const forms = await loadFormulations(sb);
  const formText = new Map(forms.map(f => [f.code, f.text]));
  const formSets = new Map<string, Set<string>>();
  const setOf = (code: string) => { let x = formSets.get(code); if (!x) { x = trigrams(formText.get(code) ?? ""); formSets.set(code, x); } return x; };

  // Текст → коды (нечётко): 1) весь текст размеченного креатива содержится в расшифровке → его коды целиком;
  // 2) по осям: похожая формулировка той же оси и продукта (Dice ≥ порога) → её код; 3) иначе новая формулировка.
  const codesFromText = async (adName: string, product: "buchhalter" | "medadmin", ex: VerbatimExtraction) => {
    const full = ex.full_text || [ex.persona_text, ex.hook_text, ex.body_text, ex.angle_text].filter(Boolean).join(" | ");
    const g = trigrams(full);
    const seenTuple = new Set<string>(); let best: { m: MapRow; c1: number; c2: number } | null = null;
    for (const m of mapByName.values()) {
      if (m.ad_name === adName || !hasCodes(m) || (m.product && m.product !== product)) continue;
      const tuple = [m.persona_code, m.hook_code, m.body_code, m.angle_code].join("|"); if (seenTuple.has(tuple)) continue; seenTuple.add(tuple);
      const t = new Set<string>(); for (const c of [m.persona_code, m.hook_code, m.body_code, m.angle_code]) if (c) for (const x of setOf(c)) t.add(x);
      const c1 = containment(t, g), c2 = containment(g, t);
      if (c1 >= SAME_CREATIVE_MIN && c2 >= SAME_CREATIVE_REVERSE_MIN && (!best || c1 + c2 > best.c1 + best.c2)) best = { m, c1, c2 };
    }
    if (best) return { codes: { persona: best.m.persona_code, hook: best.m.hook_code, body: best.m.body_code, angle: best.m.angle_code }, note: `Тексты = ${best.m.ad_name} (совпадение ${Math.round(best.c1 * 100)}% / ${Math.round(best.c2 * 100)}%)`, created: 0 };
    const codes: Record<"persona" | "hook" | "body" | "angle", string | null> = { persona: null, hook: null, body: null, angle: null };
    let created = 0; const parts: string[] = [];
    for (const axis of ["persona", "hook", "body", "angle"] as const) {
      const raw = ex[EXTRACTION_FIELD[axis]]; const text = typeof raw === "string" ? textKey(raw) : "";
      if (!text || /^null$/i.test(text)) continue;
      const a = trigrams(text); let hit: { code: string; d: number } | null = null;
      for (const f of forms) { if (f.axis !== axis || f.product !== product) continue; const d = dice(a, setOf(f.code)); if (d >= SAME_FORMULATION_MIN && (!hit || d > hit.d)) hit = { code: f.code, d }; }
      if (hit) { codes[axis] = hit.code; parts.push(`${axis} ≈ ${hit.code} (${Math.round(hit.d * 100)}%)`); continue; }
      const { formulation, created: isNew } = await ensureFormulation(sb, { axis, product, text, source: "google-text", firstAdName: adName });
      codes[axis] = formulation.code; if (isNew) { created++; forms.push(formulation); formText.set(formulation.code, formulation.text); parts.push(`${axis} новая ${formulation.code}`); }
    }
    return { codes, note: `По осям: ${parts.join(", ") || "текста нет"}`, created };
  };
  const mapOf = (name: string) => mapByName.get(name) ?? mapByName.get(baseName(name)) ?? null;
  const fpByName = new Map(fps.map(f => [f.ad_name, f]));

  // ── 1. Отпечатки размеченных Meta-статик (инкрементально; превью Meta протухают → свежая ссылка через Graph по ad_id)
  const metaStatic = creos.filter(c => c.platform !== "google" && !c.video_id && c.object_type !== "VIDEO" && c.object_type !== "POST_DELETED");
  const metaToHash = new Map<string, CreoRow>();
  for (const c of metaStatic) { const m = mapOf(c.ad_name); if (!hasCodes(m)) continue; const key = m!.ad_name; if (!fpByName.has(key) && !metaToHash.has(key)) metaToHash.set(key, c); }
  for (const [key, c] of metaToHash) {
    if (st.metaFingerprinted >= (opts.metaFingerprintLimit ?? 400) || timeLeft() < 60_000) break;
    let row: FpRow & { kind: string; source_url: string | null; error: string | null };
    try {
      const url = (await resolveMetaImageSource(c.ad_id)) ?? c.image_url ?? c.thumbnail_url;
      if (!url) throw new Error("нет превью");
      row = { ad_name: key, platform: "meta", kind: "image", dhash: await fetchImageHash(url), source_url: null, error: null };
    } catch (e) { row = { ad_name: key, platform: "meta", kind: "image", dhash: null, source_url: null, error: (e instanceof Error ? e.message : String(e)).slice(0, 200) }; }
    await sb.from("creative_fingerprints").upsert(row, { onConflict: "ad_name" });
    fpByName.set(key, row); st.metaFingerprinted++;
  }

  // ── 2. Очередь Google: креативы со спендом без кодов и без попытки автомаппинга, по спенду
  const spend: Record<string, number> = {}; const campaign: Record<string, string | null> = {};
  for (const a of gAds) { spend[a.ad_name] = (spend[a.ad_name] ?? 0) + Number(a.spend ?? 0); campaign[a.ad_name] ??= a.campaign_name; }
  const gCreo = new Map(creos.filter(c => c.platform === "google").map(c => [c.ad_name, c]));
  const queue = [...gCreo.values()].filter(c => (spend[c.ad_name] ?? 0) > 0 && !hasCodes(mapByName.get(c.ad_name)) && !(mapByName.get(c.ad_name)?.mapped_by ?? "").startsWith("google-"))
    .filter(c => !opts.only || (opts.only === "video") === (!!c.video_id || c.object_type === "VIDEO"))
    .sort((a, b) => (spend[b.ad_name] ?? 0) - (spend[a.ad_name] ?? 0));
  const pool = () => [...fpByName.values()].filter(f => f.dhash && hasCodes(mapByName.get(f.ad_name)));

  const upsertMap = async (row: Partial<MapRow> & { ad_name: string; matched_ad?: string | null; note?: string; mapped_at?: string }) => {
    const { error } = await sb.from("ad_name_mapping").upsert({ ...row, mapped_at: new Date().toISOString() }, { onConflict: "ad_name" });
    if (error) throw new Error(error.message);
    const prev = mapByName.get(row.ad_name);
    mapByName.set(row.ad_name, { ...(prev ?? { ad_name: row.ad_name, persona_code: null, hook_code: null, body_code: null, angle_code: null, concept_code: null, actor_code: null, format: null, product: null, mapped_by: null }), ...row } as MapRow);
  };

  let i = 0;
  for (; i < queue.length; i++) {
    if ((opts.limit && st.processed >= opts.limit) || timeLeft() < 45_000) break;
    const c = queue[i];
    const product = detectProduct(c.ad_name, campaign[c.ad_name] ?? null);
    const isVideo = !!c.video_id || c.object_type === "VIDEO";
    try {
      if (!isVideo) {
        // статика: сначала визуал (бесплатно), потом текст
        const url = c.asset_url ?? c.image_url ?? c.thumbnail_url;
        if (!url) throw new Error("нет картинки");
        let hash = fpByName.get(c.ad_name)?.dhash ?? null;
        if (!hash) {
          hash = await fetchImageHash(url);
          const row = { ad_name: c.ad_name, platform: "google", kind: "image", dhash: hash, source_url: url, error: null };
          await sb.from("creative_fingerprints").upsert(row, { onConflict: "ad_name" }); fpByName.set(c.ad_name, row);
        }
        let best: { name: string; d: number } | null = null;
        for (const f of pool()) { if (f.ad_name === c.ad_name) continue; const d = hamming(hash, f.dhash!); if (d <= SAME_IMAGE_MAX_DISTANCE && (!best || d < best.d)) best = { name: f.ad_name, d }; }
        if (best) {
          const src = mapByName.get(best.name)!;
          await upsertMap({ ad_name: c.ad_name, persona_code: src.persona_code, hook_code: src.hook_code, body_code: src.body_code, angle_code: src.angle_code, concept_code: null, actor_code: null, format: "static", product: src.product ?? product, mapped_by: "google-hash", matched_ad: best.name, note: `Копия по визуалу: ${best.name} (dHash ${best.d}/64)` });
          st.byHash++;
        } else {
          const ex = await extractVerbatim(url);
          const r = await codesFromText(c.ad_name, product, ex);
          await upsertMap({ ad_name: c.ad_name, ...codesRow(r.codes), concept_code: null, actor_code: null, product, format: "static", mapped_by: "google-text", matched_ad: null, note: `${r.note}. Визуальной копии среди размеченных нет — отдельный креатив. Уверенность расшифровки ${ex.confidence}` });
          if (r.codes.hook && r.codes.body && r.codes.angle) st.byText++; else st.textNoCodes++;
        }
      } else {
        if (!isStorage(c.asset_url)) {
          // скрытый YouTube: читать нечего — помечаем, чтобы не крутить в очереди; после backfill снять пометку
          st.needVideoDownload++;
          continue;
        }
        const ex = await extractVerbatim(c.asset_url!);
        const r = await codesFromText(c.ad_name, product, ex);
        const codes = r.codes;
        await upsertMap({ ad_name: c.ad_name, ...codesRow(codes), concept_code: null, actor_code: null, product, mapped_by: "google-text", matched_ad: null, note: `${r.note}. Уверенность расшифровки ${ex.confidence}` });
        if (!(codes.hook && codes.body && codes.angle)) { st.textNoCodes++; st.processed++; continue; }
        st.byText++;
        // визуал: Meta-ролики с теми же кодами хук+боди+энгл и размеченным актёром — по одному на актёра
        const cands: { name: string; m: MapRow; creo: CreoRow }[] = []; const seenActor = new Set<string>();
        // реальные актёры (оригиналы) первыми: размноженные ИИ-серии на тот же текст иначе забивают лимит кандидатов
        const isAi = (a: string | null) => !!a && /^(WOM|MAN)\d/i.test(a);
        const ordered = [...mapping].sort((a, b) => Number(isAi(a.actor_code)) - Number(isAi(b.actor_code)));
        for (const m of ordered) {
          if (m.hook_code !== codes.hook || m.body_code !== codes.body || m.angle_code !== codes.angle || !m.actor_code || seenActor.has(m.actor_code)) continue;
          const creo = creos.find(x => x.platform !== "google" && (x.ad_name === m.ad_name || baseName(x.ad_name) === m.ad_name) && (x.video_id || x.object_type === "VIDEO"));
          if (!creo) continue;
          seenActor.add(m.actor_code); cands.push({ name: m.ad_name, m, creo });
          if (cands.length >= 10) break;
        }
        if (!cands.length) {
          await upsertMap({ ad_name: c.ad_name, mapped_by: "google-text", note: `${r.note}. Meta-роликов с этими кодами и размеченным актёром нет — актёр и концепция не размечены.` });
          st.newShoot++; st.processed++; continue;
        }
        const imgs: { imageUrl: string; idx: number }[] = [];
        for (let k = 0; k < cands.length; k++) { const u = await resolveMetaImageSource(cands[k].creo.ad_id); if (u) imgs.push({ imageUrl: u, idx: k }); }
        const v = imgs.length ? await compareSameShoot(c.asset_url!, imgs) : { match: 0, person: "", reason: "нет кадров кандидатов" };
        if (v.match) {
          const hit = cands[imgs[v.match - 1].idx];
          await upsertMap({ ad_name: c.ad_name, concept_code: hit.m.concept_code, actor_code: hit.m.actor_code, format: hit.m.format, mapped_by: "google-visual", matched_ad: hit.name, note: `${r.note}. Тот же ролик, что ${hit.name} (визуал совпал: ${v.reason.slice(0, 160)})` });
          st.visualMatched++;
        } else {
          await upsertMap({ ad_name: c.ad_name, mapped_by: "google-text", note: `${r.note}. Тексты как у ${cands.map(x => x.name).slice(0, 3).join(", ")}, но съёмка другая (${v.person.slice(0, 120)}) — актёр и концепция не наследуются. ${v.reason.slice(0, 120)}` });
          st.newShoot++;
        }
      }
      st.processed++;
    } catch (e) {
      st.errors.push(`${c.ad_name.slice(0, 60)}: ${(e instanceof Error ? e.message : String(e)).slice(0, 160)}`);
      if (/402|RESOURCE_EXHAUSTED|кредит/i.test(String(e))) break; // кредиты Gemini кончились — дальше бессмысленно
    }
  }
  st.remaining = queue.slice(i).filter(c => !!(!c.video_id && c.object_type !== "VIDEO") || isStorage(c.asset_url)).length;
  return st;
}

function codesRow(codes: Record<"persona" | "hook" | "body" | "angle", string | null>) {
  return { persona_code: codes.persona, hook_code: codes.hook, body_code: codes.body, angle_code: codes.angle };
}
