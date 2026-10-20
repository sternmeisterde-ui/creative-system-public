"use client";
import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import { supabase } from "@/lib/supabase";
import { parseAdName } from "@/lib/naming";
import { detectProduct, productMeta, type Product } from "@/lib/product";
import { useProduct } from "@/components/ChannelContext";
import { AXES, AXIS_LABEL, AXIS_COLOR, isFormulationCode, textKey, type Axis, type Formulation, type FormulationProduct } from "@/lib/formulations";
import { Card, PageHeader, Button, Badge, SectionTitle } from "@/components/ui";

// ── Маппинг объявлений (06.10.2026) ───────────────────────────────────────────
// Объявлению назначаются КОДЫ ФОРМУЛИРОВОК — уникальных дословных текстов. Два пути:
//   • Gemini по файлу: выписывает персону/хук/боди/энгл дословно → точное совпадение или новый код;
//   • вручную: поиск по тексту среди существующих формулировок или создание новой из введённого текста.
// Старые групповые коды (CS2/MH1/…) видны как «старые коды» и считаются неразмеченными.

interface AdRow { adName: string; campaignName: string | null; adsetName: string | null; spend: number; impressions: number; leads: number }
interface Mapping {
  id: string; adName: string; personaCode: string | null; hookCode: string | null; bodyCode: string | null; angleCode: string | null;
  format: string | null; flow: string | null; conceptCode?: string | null; actorCode?: string | null; note: string | null;
  product?: string | null; mappedBy?: string | null;
}
interface Option { id: string; code: string | null; name: string; isOurs?: boolean; kind?: string }

const AXIS_FIELD: Record<Axis, keyof Pick<Mapping, "personaCode" | "hookCode" | "bodyCode" | "angleCode">> = { persona: "personaCode", hook: "hookCode", body: "bodyCode", angle: "angleCode" };

function status(m: Mapping | null, adName: string): "formulations" | "legacy" | "none" {
  const p = parseAdName(adName);
  if ([p.personaCode, p.hookCode, p.bodyCode, p.angleCode].some(isFormulationCode)) return "formulations";
  if (!m) return "none";
  const codes = [m.personaCode, m.hookCode, m.bodyCode, m.angleCode];
  if (codes.some(isFormulationCode)) return "formulations";
  if (codes.some(Boolean)) return "legacy";
  return "none";
}

// ── Выбор формулировки по оси: поиск по тексту + создание новой ──────────────
function FormulationPicker({ axis, product, value, formulations, onChange, onCreated }: {
  axis: Axis; product: FormulationProduct; value: string | null; formulations: Formulation[];
  onChange: (code: string | null) => void; onCreated: (f: Formulation) => void;
}) {
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const color = AXIS_COLOR[axis];
  const current = value ? formulations.find(f => f.code === value) : null;
  const pool = useMemo(() => formulations.filter(f => f.axis === axis && f.product === product), [formulations, axis, product]);
  const needle = textKey(q).toLowerCase();
  const matches = useMemo(() => needle ? pool.filter(f => f.text.toLowerCase().includes(needle) || f.code.toLowerCase().includes(needle)).slice(0, 8) : [], [pool, needle]);
  const exact = needle ? pool.find(f => f.textKey.toLowerCase() === needle) : undefined;

  const create = async () => {
    setBusy(true);
    const res = await fetch("/api/formulations", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ axis, product, text: q }) });
    const j = await res.json();
    setBusy(false);
    const f: Formulation | undefined = res.ok ? j.formulation : j.existing;
    if (!f) { alert(j.error ?? "Ошибка"); return; }
    if (res.ok) onCreated(f);
    onChange(f.code); setQ("");
  };

  return (
    <div style={{ border: `1px solid ${color}25`, borderRadius: 8, padding: 10, background: "rgba(255,255,255,0.015)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
        <span style={{ fontSize: 10, fontWeight: 700, color, textTransform: "uppercase", letterSpacing: 1 }}>{AXIS_LABEL[axis]}</span>
        {current && <span style={{ fontSize: 11, fontFamily: "monospace", color, background: `${color}18`, padding: "1px 7px", borderRadius: 4 }}>{current.code}</span>}
        {value && <button onClick={() => onChange(null)} style={{ marginLeft: "auto", background: "none", border: 0, color: "#555", cursor: "pointer", fontSize: 11, fontFamily: "inherit" }}>очистить</button>}
      </div>
      {current && <div style={{ fontSize: 12, color: "#CCC", lineHeight: 1.5, marginBottom: 8, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>«{current.text}»</div>}
      {value && !current && <div style={{ fontSize: 11, color: "#D96B6B", marginBottom: 8 }}>{value} — старый групповой код, замени формулировкой</div>}
      <textarea value={q} onChange={e => setQ(e.target.value)} placeholder={`Вставь дословный текст ${AXIS_LABEL[axis].toLowerCase()} — найдём существующую или создадим новую`} style={{ fontSize: 12, minHeight: 54, width: "100%" }} />
      {needle && (
        <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 4 }}>
          {matches.map(f => (
            <button key={f.id} onClick={() => { onChange(f.code); setQ(""); }} style={{ textAlign: "left", background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: 6, padding: "6px 10px", color: "#BBB", fontSize: 12, cursor: "pointer", fontFamily: "inherit", lineHeight: 1.4 }}>
              <span style={{ fontFamily: "monospace", color, marginRight: 8 }}>{f.code}</span>{f.text.slice(0, 160)}{f.text.length > 160 ? "…" : ""}
            </button>
          ))}
          {!exact && (
            <Button size="sm" variant="primary" onClick={create} disabled={busy}>{busy ? "Создаю…" : `+ Создать новую формулировку (${AXIS_LABEL[axis].toLowerCase()}, ${productMeta(product as Product).short})`}</Button>
          )}
          {exact && <div style={{ fontSize: 11, color: "#6EC8A0" }}>Точное совпадение найдено — выбери его выше</div>}
        </div>
      )}
    </div>
  );
}

function EditRow({ adRow, existing, formulations, concepts, actors, onSave, onDelete, onGemini, onFormulationCreated }: {
  adRow: AdRow; existing: Mapping | null; formulations: Formulation[]; concepts: Option[]; actors: Option[];
  onSave: (m: Omit<Mapping, "id">) => Promise<void>; onDelete: (id: string) => Promise<void>;
  onGemini: (adName: string, product: FormulationProduct) => Promise<string | null>; onFormulationCreated: (f: Formulation) => void;
}) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [gemini, setGemini] = useState<"idle" | "busy" | "err">("idle");
  const [geminiErr, setGeminiErr] = useState<string | null>(null);
  const detected = detectProduct(adRow.adName, adRow.campaignName, adRow.adsetName);
  const [product, setProduct] = useState<FormulationProduct>((existing?.product === "buchhalter" || existing?.product === "medadmin") ? existing.product : detected);
  const [form, setForm] = useState({
    personaCode: existing?.personaCode ?? null, hookCode: existing?.hookCode ?? null, bodyCode: existing?.bodyCode ?? null, angleCode: existing?.angleCode ?? null,
    format: existing?.format ?? "", conceptCode: existing?.conceptCode ?? "", actorCode: existing?.actorCode ?? "", note: existing?.note ?? "",
  });
  useEffect(() => {
    setForm({
      personaCode: existing?.personaCode ?? null, hookCode: existing?.hookCode ?? null, bodyCode: existing?.bodyCode ?? null, angleCode: existing?.angleCode ?? null,
      format: existing?.format ?? "", conceptCode: existing?.conceptCode ?? "", actorCode: existing?.actorCode ?? "", note: existing?.note ?? "",
    });
  }, [existing]);

  const st = status(existing, adRow.adName);
  const fromName = parseAdName(adRow.adName);
  const autoByName = [fromName.personaCode, fromName.hookCode, fromName.bodyCode, fromName.angleCode].some(isFormulationCode);
  const codeOf = (axis: Axis) => autoByName ? fromName[`${axis}Code`] : (existing?.[AXIS_FIELD[axis]] ?? null);
  const textOf = (code: string | null) => (code ? formulations.find(f => f.code === code)?.text : undefined);

  const save = async () => {
    setSaving(true);
    await onSave({
      adName: adRow.adName, personaCode: form.personaCode, hookCode: form.hookCode, bodyCode: form.bodyCode, angleCode: form.angleCode,
      format: form.format || null, flow: existing?.flow ?? null, conceptCode: form.conceptCode || null, actorCode: form.actorCode || null,
      note: form.note || null, product, mappedBy: "manual",
    });
    setSaving(false); setOpen(false);
  };
  const runGemini = async () => {
    setGemini("busy"); setGeminiErr(null);
    const err = await onGemini(adRow.adName, product);
    if (err) { setGemini("err"); setGeminiErr(err); } else setGemini("idle");
  };

  const border = st === "formulations" ? "1px solid rgba(110,200,160,0.18)" : st === "legacy" ? "1px solid rgba(232,170,66,0.22)" : "1px solid rgba(255,255,255,0.06)";
  const dot = st === "formulations" ? "#6EC8A0" : st === "legacy" ? "#E8AA42" : "#444";

  return (
    <Card style={{ border }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
        <div style={{ width: 8, height: 8, borderRadius: "50%", flexShrink: 0, background: dot, marginTop: 6 }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: "#CCC", fontFamily: "monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 420 }}>{adRow.adName}</span>
            <Badge color={productMeta(product as Product).color}>{productMeta(product as Product).short}</Badge>
            {autoByName && <Badge color="#6EC8A0">из имени</Badge>}
            {st === "legacy" && <Badge color="#E8AA42">старые коды</Badge>}
            {existing?.mappedBy && st === "formulations" && !autoByName && <Badge color="#555">{existing.mappedBy}</Badge>}
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
            <span style={{ fontSize: 10, color: "#555" }}>€{adRow.spend.toFixed(0)} спенд</span>
            <span style={{ fontSize: 10, color: "#555" }}>{adRow.impressions.toLocaleString()} показов</span>
            {adRow.leads > 0 && <span style={{ fontSize: 10, color: "#6EC8A0" }}>{adRow.leads} лидов</span>}
          </div>
          {st !== "none" && (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 6, marginTop: 8 }}>
              {AXES.map(axis => {
                const code = codeOf(axis); if (!code) return null;
                const text = textOf(code); const color = AXIS_COLOR[axis];
                return (
                  <div key={axis} title={text ?? code} style={{ fontSize: 11, color: "#888", display: "flex", gap: 6, alignItems: "baseline", minWidth: 0 }}>
                    <span style={{ fontFamily: "monospace", color, flexShrink: 0 }}>{code}</span>
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: text ? "#999" : "#D96B6B" }}>{text ?? "групповой код"}</span>
                  </div>
                );
              })}
              {existing?.conceptCode && <Badge color="#7B8CDE">{existing.conceptCode}</Badge>}
              {existing?.actorCode && <Badge color="#D9A86B">{existing.actorCode}</Badge>}
            </div>
          )}
          {geminiErr && <div style={{ fontSize: 11, color: "#D96B6B", marginTop: 6 }}>Gemini: {geminiErr}</div>}
        </div>
        {!autoByName && (
          <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
            <Button size="sm" variant="primary" onClick={runGemini} disabled={gemini === "busy"}>{gemini === "busy" ? "Gemini…" : "✦ Gemini"}</Button>
            <Button size="sm" onClick={() => setOpen(!open)}>{open ? "Закрыть" : "Вручную"}</Button>
            {existing && !open && <Button size="sm" variant="danger" onClick={() => onDelete(existing.id)}>✕</Button>}
          </div>
        )}
      </div>

      {open && (
        <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid rgba(255,255,255,0.06)" }}>
          <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 10, fontSize: 11, color: "#888" }}>
            Продукт формулировок:
            <select value={product} onChange={e => setProduct(e.target.value as FormulationProduct)} style={{ fontSize: 11, padding: "3px 8px" }}>
              <option value="buchhalter">Бухгалтер</option><option value="medadmin">Медадмин</option>
            </select>
            {product !== detected && <span style={{ color: "#E8AA42" }}>эвристика по имени: {productMeta(detected as Product).label}</span>}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 10 }}>
            {AXES.map(axis => (
              <FormulationPicker key={axis} axis={axis} product={product} value={form[AXIS_FIELD[axis]]} formulations={formulations}
                onChange={code => setForm(p => ({ ...p, [AXIS_FIELD[axis]]: code }))} onCreated={onFormulationCreated} />
            ))}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1.4fr 1fr 2fr", gap: 8, marginBottom: 8 }}>
            <div>
              <div style={{ fontSize: 10, fontWeight: 700, color: "#E8AA42", textTransform: "uppercase", letterSpacing: 1, marginBottom: 4 }}>Формат</div>
              <select value={form.format} onChange={e => setForm(p => ({ ...p, format: e.target.value }))} style={{ fontSize: 11, padding: "4px 8px", width: "100%" }}>
                <option value="">—</option>{["ugc", "static", "animation", "human", "mixed"].map(v => <option key={v} value={v}>{v.toUpperCase()}</option>)}
              </select>
            </div>
            {([["conceptCode", "Концепция", concepts, "#7B8CDE"], ["actorCode", "Актёр", actors, "#D9A86B"]] as [("conceptCode" | "actorCode"), string, Option[], string][]).map(([key, label, opts, color]) => (
              <div key={key}>
                <div style={{ fontSize: 10, fontWeight: 700, color, textTransform: "uppercase", letterSpacing: 1, marginBottom: 4 }}>{label}</div>
                <select value={form[key]} onChange={e => setForm(p => ({ ...p, [key]: e.target.value }))} style={{ fontSize: 11, padding: "4px 8px", width: "100%" }}>
                  <option value="">—</option>
                  {opts.filter(o => o.code).map(o => <option key={o.id} value={o.code!}>{o.code} — {o.name}{o.isOurs ? " ★" : ""}{o.kind === "ai" ? " (ИИ)" : ""}</option>)}
                </select>
              </div>
            ))}
            <div>
              <div style={{ fontSize: 10, fontWeight: 700, color: "#888", textTransform: "uppercase", letterSpacing: 1, marginBottom: 4 }}>Заметка</div>
              <input value={form.note} onChange={e => setForm(p => ({ ...p, note: e.target.value }))} placeholder="необязательно" style={{ fontSize: 11, padding: "5px 10px", width: "100%" }} />
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <Button size="sm" onClick={() => setOpen(false)}>Отмена</Button>
            <Button size="sm" variant="primary" onClick={save} disabled={saving}>{saving ? "Сохраняю…" : "Сохранить"}</Button>
          </div>
        </div>
      )}
    </Card>
  );
}

export default function MappingPage() {
  const { product: sideProduct } = useProduct();
  const [ads, setAds] = useState<AdRow[]>([]);
  const [mappings, setMappings] = useState<Mapping[]>([]);
  const [formulations, setFormulations] = useState<Formulation[]>([]);
  const [concepts, setConcepts] = useState<Option[]>([]);
  const [actors, setActors] = useState<Option[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<"todo" | "legacy" | "done" | "all">("todo");
  const [q, setQ] = useState("");
  const [batch, setBatch] = useState<{ running: boolean; processed: number; created: number; remaining: number | null; failed: number; log: string[] }>({ running: false, processed: 0, created: 0, remaining: null, failed: 0, log: [] });
  const stopRef = useRef(false);

  const loadAll = useCallback(async () => {
    setLoading(true);
    const perfRows: { ad_name: string; campaign_name: string | null; adset_name: string | null; spend: number | string; impressions: number | string; leads: number | string }[] = [];
    for (let from = 0; ; from += 1000) {
      const { data } = await supabase.from("creative_performance").select("ad_name, campaign_name, adset_name, spend, impressions, leads").eq("platform", "meta").order("ad_id").range(from, from + 999);
      perfRows.push(...(data ?? []));
      if (!data || data.length < 1000) break;
    }
    const [mappingRes, fRes, cRes, actRes] = await Promise.all([
      fetch("/api/analytics/mapping").then(r => r.json()),
      fetch("/api/formulations?usage=0").then(r => r.json()),
      supabase.from("concepts").select("id, code, name, is_ours").order("is_ours", { ascending: false }).order("code"),
      supabase.from("actors").select("id, code, name, kind").order("kind").order("code"),
    ]);
    const byName = new Map<string, AdRow>();
    for (const r of perfRows) {
      const cur = byName.get(r.ad_name);
      if (cur) { cur.spend += Number(r.spend) || 0; cur.impressions += Number(r.impressions) || 0; cur.leads += Number(r.leads) || 0; }
      else byName.set(r.ad_name, { adName: r.ad_name, campaignName: r.campaign_name, adsetName: r.adset_name, spend: Number(r.spend) || 0, impressions: Number(r.impressions) || 0, leads: Number(r.leads) || 0 });
    }
    setAds([...byName.values()].sort((a, b) => b.spend - a.spend));
    setMappings(mappingRes.mappings ?? []);
    setFormulations((fRes.items ?? []) as Formulation[]);
    setConcepts(((cRes.data ?? []) as { id: string; code: string | null; name: string; is_ours: boolean }[]).map(c => ({ id: c.id, code: c.code, name: c.name, isOurs: c.is_ours })));
    setActors(((actRes.data ?? []) as { id: string; code: string | null; name: string; kind: string }[]).map(a => ({ id: a.id, code: a.code, name: a.name, kind: a.kind })));
    setLoading(false);
  }, []);
  useEffect(() => { loadAll(); }, [loadAll]);

  const handleSave = async (m: Omit<Mapping, "id">) => {
    await fetch("/api/analytics/mapping", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(m) });
    await loadAll();
  };
  const handleDelete = async (id: string) => {
    await fetch("/api/analytics/mapping", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }) });
    await loadAll();
  };
  const handleGemini = async (adName: string, product: FormulationProduct): Promise<string | null> => {
    const res = await fetch("/api/formulations/extract", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ adName, product }) });
    const j = await res.json();
    if (!res.ok) return j.error ?? "ошибка";
    await loadAll();
    return null;
  };
  const runBatch = async () => {
    stopRef.current = false;
    setBatch({ running: true, processed: 0, created: 0, remaining: null, failed: 0, log: [] });
    while (!stopRef.current) {
      const res = await fetch("/api/formulations/extract-batch", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ limit: 4, product: sideProduct === "all" ? undefined : sideProduct }) });
      const j = await res.json();
      if (!res.ok) { setBatch(b => ({ ...b, running: false, log: [...b.log, j.error ?? "ошибка"] })); break; }
      setBatch(b => ({
        running: true, processed: b.processed + (j.processed ?? 0), created: b.created + (j.createdCodes ?? 0), remaining: j.remaining ?? null,
        failed: b.failed + (j.failed?.length ?? 0), log: [...(j.failed ?? []).map((f: { adName: string; error: string }) => `${f.adName}: ${f.error}`), ...b.log].slice(0, 12),
      }));
      if (!j.remaining || (j.processed === 0 && (j.failed?.length ?? 0) > 0 && j.remaining <= (j.failed?.length ?? 0))) break;
    }
    setBatch(b => ({ ...b, running: false }));
    await loadAll();
  };

  const mappingByName = useMemo(() => Object.fromEntries(mappings.map(m => [m.adName.trim().toLowerCase(), m])), [mappings]);
  const rows = useMemo(() => ads
    .filter(a => sideProduct === "all" || (mappingByName[a.adName.trim().toLowerCase()]?.product ?? detectProduct(a.adName, a.campaignName, a.adsetName)) === sideProduct)
    .map(a => ({ a, m: mappingByName[a.adName.trim().toLowerCase()] ?? null, st: status(mappingByName[a.adName.trim().toLowerCase()] ?? null, a.adName) })), [ads, mappingByName, sideProduct]);
  const counts = { done: rows.filter(r => r.st === "formulations").length, legacy: rows.filter(r => r.st === "legacy").length, none: rows.filter(r => r.st === "none").length };
  const spendTodo = rows.filter(r => r.st !== "formulations").reduce((s, r) => s + r.a.spend, 0);
  const needle = q.trim().toLowerCase();
  const filtered = rows.filter(r => filter === "all" || (filter === "done" ? r.st === "formulations" : filter === "legacy" ? r.st === "legacy" : r.st !== "formulations"))
    .filter(r => !needle || r.a.adName.toLowerCase().includes(needle));

  return (
    <div>
      <PageHeader title="Маппинг объявлений" subtitle="Каждому объявлению — коды его дословных формулировок: персона, хук, боди, энгл. Gemini выписывает текст по файлу, вручную — поиск по тексту или новая формулировка"
        action={<Button variant="primary" onClick={batch.running ? () => { stopRef.current = true; } : runBatch}>{batch.running ? "■ Остановить" : "✦ Разметить Gemini пачкой"}</Button>} />

      {(batch.running || batch.processed > 0) && (
        <Card style={{ marginBottom: 16, border: "1px solid rgba(232,170,66,0.25)" }}>
          <div style={{ fontSize: 12, color: "#CCC" }}>
            {batch.running ? "⏳ Идёт разметка…" : "Готово."} Размечено: <b>{batch.processed}</b> · новых формулировок: <b>{batch.created}</b> · ошибок: {batch.failed}{batch.remaining != null && ` · осталось ≈ ${batch.remaining}`}
          </div>
          {batch.log.length > 0 && <div style={{ fontSize: 11, color: "#D96B6B", marginTop: 6, fontFamily: "monospace", whiteSpace: "pre-wrap" }}>{batch.log.join("\n")}</div>}
        </Card>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginBottom: 20 }}>
        {[
          { label: "С формулировками", value: counts.done, color: "#6EC8A0", desc: "коды уникальных дословных параметров" },
          { label: "Старые коды", value: counts.legacy, color: "#E8AA42", desc: "групповые CS/MH/MB/MA — переразметить" },
          { label: "Не размечено", value: counts.none, color: "#D96B6B", desc: "нет ни кодов, ни маппинга" },
          { label: "Спенд без формулировок", value: `€${Math.round(spendTodo).toLocaleString("ru")}`, color: "#AAA", desc: "сколько денег ещё не разложено по параметрам" },
        ].map(s => (
          <Card key={s.label} style={{ textAlign: "center" }}>
            <div style={{ fontSize: 26, fontWeight: 800, color: s.color }}>{s.value}</div>
            <div style={{ fontSize: 12, color: "#888", marginTop: 2 }}>{s.label}</div>
            <div style={{ fontSize: 10, color: "#444", marginTop: 4 }}>{s.desc}</div>
          </Card>
        ))}
      </div>

      <div style={{ display: "flex", gap: 8, marginBottom: 20, alignItems: "center", flexWrap: "wrap" }}>
        {([["todo", `К разметке (${counts.legacy + counts.none})`, "#E8AA42"], ["legacy", `Старые коды (${counts.legacy})`, "#E8AA42"], ["done", `Готово (${counts.done})`, "#6EC8A0"], ["all", `Все (${rows.length})`, "#777"]] as const).map(([v, l, color]) => (
          <button key={v} onClick={() => setFilter(v)} style={{
            padding: "7px 16px", borderRadius: 8, fontSize: 12, cursor: "pointer", fontWeight: filter === v ? 700 : 400, fontFamily: "inherit",
            border: filter === v ? `1px solid ${color}40` : "1px solid rgba(255,255,255,0.06)", background: filter === v ? `${color}10` : "rgba(255,255,255,0.02)", color: filter === v ? color : "#666",
          }}>{l}</button>
        ))}
        <input value={q} onChange={e => setQ(e.target.value)} placeholder="Поиск по имени объявления…" style={{ flex: 1, minWidth: 200, fontSize: 12, padding: "7px 12px" }} />
      </div>

      {loading ? <div style={{ textAlign: "center", color: "#444", padding: 60 }}>Загрузка…</div>
        : filtered.length === 0 ? <Card><div style={{ textAlign: "center", padding: "40px 0", color: "#555" }}>Нет записей</div></Card>
        : (
          <>
            <SectionTitle icon="🗂">{filtered.length} объявлений · по убыванию спенда</SectionTitle>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {filtered.slice(0, 300).map(({ a, m }) => (
                <EditRow key={a.adName} adRow={a} existing={m} formulations={formulations} concepts={concepts} actors={actors}
                  onSave={handleSave} onDelete={handleDelete} onGemini={handleGemini} onFormulationCreated={f => setFormulations(prev => [...prev, f])} />
              ))}
              {filtered.length > 300 && <div style={{ fontSize: 12, color: "#555", textAlign: "center", padding: 12 }}>Показаны первые 300 по спенду — уточни поиск</div>}
            </div>
          </>
        )}
    </div>
  );
}
