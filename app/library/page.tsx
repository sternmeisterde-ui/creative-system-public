"use client";
import { useEffect, useState, useCallback, useMemo } from "react";
import { useProduct } from "@/components/ChannelContext";
import { productMeta, productQuery, type Product } from "@/lib/product";
import { AXES, AXIS_LABEL, AXIS_COLOR, type Axis, type Formulation, type FormulationProduct } from "@/lib/formulations";
import { Card, PageHeader, Button, Badge, Modal, Label, Empty, SectionTitle } from "@/components/ui";
import { ConceptsTab, ActorsTab } from "./ConceptsActors";

// ── Библиотека (06.10.2026) ────────────────────────────────────────────────────
// Параметр = уникальная ДОСЛОВНАЯ формулировка со своим кодом (MH483920 / BA102938).
// Категорий больше нет: любое отличие в тексте — отдельная формулировка. Текст неизменяем;
// новый текст = новая формулировка. Концепции видео и актёры — отдельные оси, как раньше.

type Tab = "formulations" | "concepts" | "actors";
type Item = Formulation & { adCount: number };

// Метрики формулировки по массиву (lifetime, канал из сайдбара): агрегат /api/analytics/params + вердикт /api/analytics/bivariate
type Verdict = "HELPS" | "HURTS" | "NEUTRAL" | "INSUFFICIENT";
interface Stats { spend: number; leads: number; qualLeads: number; cpl: number | null; cpql: number | null; adCount: number; winners: number; losers: number; verdict?: Verdict; ratio?: number | null }
const VERDICT_META: Record<Verdict, { label: string; color: string }> = {
  HELPS: { label: "HELPS", color: "#6EC8A0" }, HURTS: { label: "HURTS", color: "#D96B6B" },
  NEUTRAL: { label: "нейтрально", color: "#888" }, INSUFFICIENT: { label: "мало данных", color: "#555" },
};
const eur = (v: number | null | undefined) => (v == null ? "—" : `€${v.toFixed(1)}`);
type SortKey = "spend" | "cpl" | "cpql" | "leads" | "adCount" | "created";

const SOURCE_LABEL: Record<string, string> = {
  manual: "вручную", gemini: "Gemini по файлу", "gemini-quotes": "цитаты бивариата", brief: "из брифа",
};

function AddForm({ defaultProduct, onDone, onCancel }: { defaultProduct: FormulationProduct; onDone: () => void; onCancel: () => void }) {
  const [axis, setAxis] = useState<Axis>("hook");
  const [product, setProduct] = useState<FormulationProduct>(defaultProduct);
  const [text, setText] = useState("");
  const [note, setNote] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (!text.trim()) return;
    setSaving(true); setErr(null);
    const res = await fetch("/api/formulations", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ axis, product, text, note }) });
    const j = await res.json();
    setSaving(false);
    if (!res.ok) { setErr(j.error ?? "Ошибка"); return; }
    onDone();
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <div><Label>Ось</Label>
          <select value={axis} onChange={e => setAxis(e.target.value as Axis)}>
            {AXES.map(a => <option key={a} value={a}>{AXIS_LABEL[a]}</option>)}
          </select>
        </div>
        <div><Label>Продукт</Label>
          <select value={product} onChange={e => setProduct(e.target.value as FormulationProduct)}>
            <option value="buchhalter">Бухгалтер</option>
            <option value="medadmin">Медадмин</option>
          </select>
        </div>
      </div>
      <div><Label>Формулировка — дословно, как будет в креативе *</Label>
        <textarea value={text} onChange={e => setText(e.target.value)} style={{ minHeight: 110 }} placeholder="Ночная смена научила меня одному | Все отработала ночную" />
        <div style={{ fontSize: 11, color: "#555", marginTop: 4 }}>Любое отличие в тексте — это уже другая формулировка с другим кодом. Склеек нет. Нормализуются только пробелы.</div>
      </div>
      <div><Label>Заметка (необязательно)</Label><input value={note} onChange={e => setNote(e.target.value)} placeholder="откуда, для какого пака…" /></div>
      {err && <div style={{ fontSize: 12, color: "#D96B6B", background: "rgba(217,107,107,0.08)", padding: "8px 12px", borderRadius: 8 }}>{err}</div>}
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <Button onClick={onCancel}>Отмена</Button>
        <Button onClick={submit} variant="primary" disabled={saving || !text.trim()}>{saving ? "Сохраняю…" : "Создать код"}</Button>
      </div>
    </div>
  );
}

function Row({ f, st, statsLoading, onReload }: { f: Item; st?: Stats; statsLoading: boolean; onReload: () => void }) {
  const [editNote, setEditNote] = useState(false);
  const [note, setNote] = useState(f.note ?? "");
  const color = AXIS_COLOR[f.axis];
  const vm = st?.verdict ? VERDICT_META[st.verdict] : null;
  const cplColor = (v: number | null | undefined) => (v == null ? "#555" : v <= 20 ? "#6EC8A0" : v <= 26 ? "#E8AA42" : "#D96B6B");
  const saveNote = async () => {
    await fetch("/api/formulations", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: f.id, note }) });
    setEditNote(false); onReload();
  };
  const remove = async () => {
    if (!confirm(`Удалить ${f.code}? Текст: «${f.text.slice(0, 80)}»`)) return;
    const res = await fetch("/api/formulations", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: f.id }) });
    if (!res.ok) alert((await res.json()).error ?? "Не удалось удалить");
    onReload();
  };
  return (
    <Card style={{ border: `1px solid ${color}18`, padding: "12px 16px" }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
        <div style={{ flexShrink: 0, display: "flex", flexDirection: "column", gap: 6, alignItems: "flex-start" }}>
          <span style={{ fontSize: 12, fontWeight: 700, color, background: `${color}18`, padding: "2px 8px", borderRadius: 5, fontFamily: "monospace" }}>{f.code}</span>
          <Badge color={color}>{AXIS_LABEL[f.axis]}</Badge>
          <Badge color={productMeta(f.product as Product).color}>{productMeta(f.product as Product).short}</Badge>
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, color: "#DDD", lineHeight: 1.55, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>«{f.text}»</div>
          {st ? (
            <div style={{ display: "flex", gap: 14, marginTop: 8, fontSize: 11.5, color: "#999", flexWrap: "wrap", alignItems: "center", fontVariantNumeric: "tabular-nums" }}>
              {vm && <span title={st.ratio != null ? `CPL с формулировкой / CPL остальных = ×${st.ratio.toFixed(2)}` : undefined} style={{ fontSize: 10.5, fontWeight: 700, color: vm.color, background: `${vm.color}18`, border: `1px solid ${vm.color}40`, padding: "1px 8px", borderRadius: 99 }}>{vm.label}{st.ratio != null && st.verdict !== "INSUFFICIENT" ? ` ×${st.ratio.toFixed(2)}` : ""}</span>}
              <span><i style={{ fontStyle: "normal", color: "#555" }}>спенд </i><b style={{ color: "#CCC" }}>€{Math.round(st.spend).toLocaleString("ru")}</b></span>
              <span><i style={{ fontStyle: "normal", color: "#555" }}>лиды </i><b style={{ color: "#CCC" }}>{st.leads}</b></span>
              <span><i style={{ fontStyle: "normal", color: "#555" }}>CPL </i><b style={{ color: cplColor(st.cpl) }}>{eur(st.cpl)}</b></span>
              <span><i style={{ fontStyle: "normal", color: "#555" }}>квал </i><b style={{ color: "#CCC" }}>{st.qualLeads}</b></span>
              <span><i style={{ fontStyle: "normal", color: "#555" }}>CPQL </i><b style={{ color: st.cpql == null ? "#555" : st.cpql <= 28 ? "#6EC8A0" : st.cpql <= 36 ? "#E8AA42" : "#D96B6B" }}>{eur(st.cpql)}</b></span>
              {(st.winners > 0 || st.losers > 0) && <span style={{ color: "#555" }}><span style={{ color: "#6EC8A0" }}>{st.winners}W</span> / <span style={{ color: "#D96B6B" }}>{st.losers}L</span></span>}
            </div>
          ) : statsLoading ? <div style={{ marginTop: 8, fontSize: 11, color: "#444" }}>⏳ метрики считаются…</div>
            : f.adCount > 0 ? <div style={{ marginTop: 8, fontSize: 11, color: "#444" }}>у креативов с этой формулировкой нет строк со спендом</div> : null}
          <div style={{ display: "flex", gap: 12, marginTop: 6, fontSize: 11, color: "#555", flexWrap: "wrap", alignItems: "center" }}>
            <span style={{ color: f.adCount > 0 ? "#AAA" : "#444", fontWeight: 600 }}>{f.adCount} крео</span>
            <span>{SOURCE_LABEL[f.source] ?? f.source}</span>
            <span>{new Date(f.createdAt).toLocaleDateString("ru")}</span>
            {f.firstAdName && <span title="где впервые встречена" style={{ fontFamily: "monospace" }}>{f.firstAdName}</span>}
            {!editNote && (f.note ? <span style={{ color: "#888" }}>📝 {f.note}</span> : <button onClick={() => setEditNote(true)} style={{ background: "none", border: 0, color: "#444", cursor: "pointer", fontSize: 11, fontFamily: "inherit" }}>+ заметка</button>)}
            {f.note && !editNote && <button onClick={() => setEditNote(true)} style={{ background: "none", border: 0, color: "#444", cursor: "pointer", fontSize: 11, fontFamily: "inherit" }}>изменить</button>}
          </div>
          {editNote && (
            <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
              <input value={note} onChange={e => setNote(e.target.value)} placeholder="Заметка" style={{ fontSize: 11, padding: "5px 10px", flex: 1 }} />
              <Button size="sm" onClick={() => setEditNote(false)}>Отмена</Button>
              <Button size="sm" variant="primary" onClick={saveNote}>Сохранить</Button>
            </div>
          )}
        </div>
        {f.adCount === 0 && <Button size="sm" variant="danger" onClick={remove}>✕</Button>}
      </div>
    </Card>
  );
}

function FormulationsTab({ items, loading, onReload }: { items: Item[]; loading: boolean; onReload: () => void }) {
  const { product } = useProduct();
  const [axis, setAxis] = useState<Axis | "all">("all");
  const [q, setQ] = useState("");
  const [onlyUsed, setOnlyUsed] = useState(false);
  const [verdictF, setVerdictF] = useState<Verdict | "all">("all");
  const [sort, setSort] = useState<SortKey>("spend");
  const [modal, setModal] = useState(false);
  const [stats, setStats] = useState<Record<string, Stats>>({});
  const [statsLoading, setStatsLoading] = useState(false);

  // Метрики по кодам: lifetime по ВСЕМ каналам (формулировки размечены у Meta; переключатель канала
  // в сайдбаре на библиотеку не влияет — иначе в Google/TikTok у всех строк было бы «крео нет»), продукт учитывается.
  useEffect(() => {
    let alive = true;
    (async () => {
      setStatsLoading(true);
      const qs = productQuery(product, false).replace(/^&/, "");
      try {
        const [pRes, bRes] = await Promise.all([
          fetch(`/api/analytics/params${qs ? `?${qs}` : ""}`).then(r => r.json()),
          fetch(`/api/analytics/bivariate${qs ? `?${qs}` : ""}`).then(r => r.json()),
        ]);
        if (!alive) return;
        const m: Record<string, Stats> = {};
        type PS = { code: string; spend: number; leads: number; qualLeads: number; cpl: number | null; cpql: number | null; adCount: number; winnerCount: number; loserCount: number };
        for (const arr of Object.values((pRes.stats ?? {}) as Record<string, PS[]>)) for (const s of arr) {
          m[s.code] = { spend: s.spend, leads: s.leads, qualLeads: s.qualLeads, cpl: s.cpl, cpql: s.cpql, adCount: s.adCount, winners: s.winnerCount, losers: s.loserCount };
        }
        type BR = { code: string; verdict: Verdict; ratio: number | null };
        for (const r of (bRes.results ?? []) as BR[]) if (m[r.code]) { m[r.code].verdict = r.verdict; m[r.code].ratio = r.ratio; }
        setStats(m);
      } catch { if (alive) setStats({}); }
      finally { if (alive) setStatsLoading(false); }
    })();
    return () => { alive = false; };
  }, [product]);

  const scoped = useMemo(() => items.filter(f => product === "all" || f.product === product), [items, product]);
  const counts = useMemo(() => Object.fromEntries(AXES.map(a => [a, scoped.filter(f => f.axis === a).length])) as Record<Axis, number>, [scoped]);
  const verdictCounts = useMemo(() => {
    const c: Record<Verdict, number> = { HELPS: 0, HURTS: 0, NEUTRAL: 0, INSUFFICIENT: 0 };
    for (const f of scoped) { const v = stats[f.code]?.verdict; if (v) c[v]++; }
    return c;
  }, [scoped, stats]);
  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const num = (v: number | null | undefined, asc: boolean) => (v == null ? (asc ? Infinity : -Infinity) : v);
    return scoped
      .filter(f => axis === "all" || f.axis === axis)
      .filter(f => !onlyUsed || f.adCount > 0)
      .filter(f => verdictF === "all" || stats[f.code]?.verdict === verdictF)
      .filter(f => !needle || f.text.toLowerCase().includes(needle) || f.code.toLowerCase().includes(needle) || (f.legacyCode ?? "").toLowerCase().includes(needle))
      .sort((a, b) => {
        const sa = stats[a.code], sb = stats[b.code];
        switch (sort) {
          case "spend":   return num(sb?.spend, false) - num(sa?.spend, false) || b.adCount - a.adCount;
          case "leads":   return num(sb?.leads, false) - num(sa?.leads, false);
          case "cpl":     return num(sa?.cpl, true) - num(sb?.cpl, true);
          case "cpql":    return num(sa?.cpql, true) - num(sb?.cpql, true);
          case "adCount": return b.adCount - a.adCount;
          default:        return b.createdAt.localeCompare(a.createdAt);
        }
      });
  }, [scoped, axis, q, onlyUsed, verdictF, sort, stats]);

  return (
    <div>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 14 }}>
        {([["all", "Все", "#AAA"], ...AXES.map(a => [a, AXIS_LABEL[a], AXIS_COLOR[a]])] as [Axis | "all", string, string][]).map(([key, label, color]) => {
          const on = axis === key;
          const n = key === "all" ? scoped.length : counts[key];
          return (
            <button key={key} onClick={() => setAxis(key)} style={{
              padding: "7px 14px", borderRadius: 8, fontSize: 12, cursor: "pointer", fontFamily: "inherit", fontWeight: on ? 700 : 400,
              border: on ? `1px solid ${color}40` : "1px solid rgba(255,255,255,0.06)", background: on ? `${color}12` : "rgba(255,255,255,0.02)", color: on ? color : "#666",
            }}>{label} <span style={{ fontSize: 10, opacity: 0.7 }}>({n})</span></button>
          );
        })}
        <input value={q} onChange={e => setQ(e.target.value)} placeholder="Поиск по тексту или коду…" style={{ flex: 1, minWidth: 220, fontSize: 12, padding: "7px 12px" }} />
        <label style={{ fontSize: 12, color: "#888", display: "flex", gap: 6, alignItems: "center", cursor: "pointer" }}>
          <input type="checkbox" checked={onlyUsed} onChange={e => setOnlyUsed(e.target.checked)} /> только с крео
        </label>
        <Button variant="primary" onClick={() => setModal(true)}>+ Формулировка</Button>
      </div>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 14, fontSize: 12, color: "#777" }}>
        <span>Вердикт:</span>
        {([["all", "все", "#AAA"], ...(Object.keys(VERDICT_META) as Verdict[]).map(v => [v, VERDICT_META[v].label, VERDICT_META[v].color])] as [Verdict | "all", string, string][]).map(([key, label, color]) => {
          const on = verdictF === key; const n = key === "all" ? Object.values(verdictCounts).reduce((a, b) => a + b, 0) : verdictCounts[key];
          return (
            <button key={key} onClick={() => setVerdictF(key)} style={{
              padding: "5px 12px", borderRadius: 99, fontSize: 11.5, cursor: "pointer", fontFamily: "inherit", fontWeight: on ? 700 : 400,
              border: on ? `1px solid ${color}50` : "1px solid rgba(255,255,255,0.06)", background: on ? `${color}14` : "rgba(255,255,255,0.02)", color: on ? color : "#666",
            }}>{label} <span style={{ fontSize: 10, opacity: 0.7 }}>({n})</span></button>
          );
        })}
        <span style={{ marginLeft: "auto" }}>Сортировка:</span>
        <select value={sort} onChange={e => setSort(e.target.value as SortKey)} style={{ fontSize: 12, padding: "5px 10px" }}>
          <option value="spend">по спенду</option><option value="cpl">по CPL (лучшие первыми)</option><option value="cpql">по CPQL (лучшие первыми)</option>
          <option value="leads">по лидам</option><option value="adCount">по числу крео</option><option value="created">по дате</option>
        </select>
        {statsLoading && <span style={{ fontSize: 11, color: "#555" }}>⏳ считаю метрики…</span>}
        <span style={{ fontSize: 11, color: "#444" }}>lifetime · весь массив{product !== "all" ? ` · ${productMeta(product).short}` : ""}</span>
      </div>

      {loading ? <div style={{ textAlign: "center", color: "#444", padding: 60 }}>Загрузка…</div>
        : visible.length === 0 ? <Empty icon="🧩" text={items.length === 0 ? "Формулировок ещё нет. Разметь объявления на /mapping или добавь вручную." : "Ничего не найдено"} />
        : (
          <>
            <SectionTitle icon="🧩">{visible.length} формулировок{product !== "all" ? ` · ${productMeta(product).label}` : ""}</SectionTitle>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {visible.slice(0, 400).map(f => <Row key={f.id} f={f} st={stats[f.code]} statsLoading={statsLoading} onReload={onReload} />)}
              {visible.length > 400 && <div style={{ fontSize: 12, color: "#555", textAlign: "center", padding: 12 }}>Показаны первые 400 — уточни поиск</div>}
            </div>
          </>
        )}

      <Modal open={modal} onClose={() => setModal(false)} title="Новая формулировка">
        <AddForm defaultProduct={product === "medadmin" ? "medadmin" : "buchhalter"} onDone={() => { setModal(false); onReload(); }} onCancel={() => setModal(false)} />
      </Modal>
    </div>
  );
}

export default function LibraryPage() {
  const [tab, setTab] = useState<Tab>("formulations");
  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(true);
  const [axisCounts, setAxisCounts] = useState({ concepts: 0, actors: 0 });

  const reload = useCallback(async () => {
    setLoading(true);
    const [fRes, cRes] = await Promise.all([
      fetch("/api/formulations").then(r => r.json()),
      fetch("/api/library/counts").then(r => r.json()).catch(() => ({ concepts: 0, actors: 0 })),
    ]);
    setItems((fRes.items ?? []) as Item[]);
    setAxisCounts({ concepts: cRes.concepts ?? 0, actors: cRes.actors ?? 0 });
    setLoading(false);
  }, []);
  useEffect(() => { reload(); }, [reload]);

  const TABS: { key: Tab; label: string; icon: string; color: string; count: number }[] = [
    { key: "formulations", label: "Формулировки", icon: "🧩", color: "#E8AA42", count: items.length },
    { key: "concepts", label: "Концепции", icon: "🎞", color: "#7B8CDE", count: axisCounts.concepts },
    { key: "actors", label: "Актёры", icon: "🎭", color: "#D9A86B", count: axisCounts.actors },
  ];

  return (
    <div>
      <PageHeader
        title="Библиотека формулировок"
        subtitle="Каждый параметр — уникальный дословный текст со своим кодом. Персона · Хук · Боди · Энгл; отдельно — концепции видео и актёры"
      />
      <div style={{ display: "flex", gap: 4, marginBottom: 24, background: "rgba(255,255,255,0.02)", borderRadius: 10, padding: 4 }}>
        {TABS.map(t => {
          const active = tab === t.key;
          return (
            <button key={t.key} onClick={() => setTab(t.key)} style={{
              flex: 1, padding: "9px 12px", borderRadius: 8, border: active ? `1px solid ${t.color}25` : "1px solid transparent",
              background: active ? `${t.color}10` : "transparent", color: active ? t.color : "#555", fontSize: 12, fontWeight: active ? 700 : 400,
              cursor: "pointer", fontFamily: "inherit", display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
            }}>{t.icon} {t.label} <span style={{ fontSize: 10, opacity: 0.7 }}>({t.count})</span></button>
          );
        })}
      </div>
      {tab === "formulations" && <FormulationsTab items={items} loading={loading} onReload={reload} />}
      {tab === "concepts" && <ConceptsTab />}
      {tab === "actors" && <ActorsTab />}
    </div>
  );
}
