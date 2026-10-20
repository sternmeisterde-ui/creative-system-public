"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { Format, PackSlot, PackSlotCategory } from "@/lib/types";
import { Card, Button, Badge, SectionTitle } from "@/components/ui";

// ── «Следующий пак» — дизайн эксперимента на отчёте продукта (08.10.2026) ────────────────
// Один экран-гейт: ограничения (формат, размер, разведка концепций, блок-лист), предпросмотр слотов
// с кодами и дословными текстами, матрица измеримости, кнопка «Принять» → сессия → брифы → ТЗ.
// Используется в отчёте (раздел в конце) и в конструкторе. Данные — POST /api/pack/propose, сохранение — /api/pack/generate.

type ConceptOpt = { code: string; name: string; category: string | null; used: number };
type Matrix = Array<{ axis: string; code: string; label: string; slots: number[]; isNew: boolean }>;
type Ref = { adName: string; status: string; spend: number; leads: number; cpl: number | null; cpql: number | null; media: { url: string; label: string } | null };
type Verification = { overall: "ok" | "warning" | "fail"; checks: { model: string; status: string; confidence: number; issues: { severity: string; area: string; detail: string }[]; summary: string }[] };
interface Proposal {
  slots: PackSlot[]; distribution: Record<PackSlotCategory, number>; matrix: Matrix; notes: string[]; winnersUsed: string[];
  labels: Record<string, string>; refs: { byCode: Record<string, Ref[]>; byAd: Record<string, Ref> };
  winners: Array<{ adName: string; cpl: number | null; leads: number; spend: number; medium?: "video" | "static" }>; transferDonors: Array<{ adName: string; cpl: number | null; medium: "video" | "static" }>; tiers: Record<string, "A" | "B" | "C">; medium: "video" | "static"; exploreList: string[]; concepts: { untested: ConceptOpt[]; tested: ConceptOpt[] }; actors: { code: string; name: string; kind: string }[];
  signals: { helps: { code: string; paramType: string; ratio: number | null; withCount: number }[]; helpsConcepts: { code: string; ratio: number | null; withCount: number }[] };
  report: { id: string; createdAt: string; dateFrom: string | null; dateTo: string | null; overall: string | null };
}

const CAT: Record<PackSlotCategory, { label: string; color: string; desc: string }> = {
  winner_family: { label: "Семьи — один параметр", color: "#6EC8A0", desc: "виннер, меняется ровно одна формулировка" },
  winner_mix:    { label: "Масштабирование HELPS", color: "#48B8D0", desc: "подтверждённая формулировка или концепция в 2–3 новых контекстах" },
  discovery:     { label: "Разведка концепций", color: "#C490D1", desc: "новые концепции, тексты виннеров дословно, ≥3 крео на концепцию" },
  competitor:    { label: "Конкуренты", color: "#FF8B5A", desc: "гипотезы из концептов конкурентов" },
  transfer:      { label: "Перенос медиа", color: "#E8AA42", desc: "виннер другого медиа целиком, меняется только медиа" },
};
const TIER: Record<string, { label: string; color: string; title: string }> = {
  A: { label: "A", color: "#6EC8A0", title: "HELPS за период отчёта, ≥2 крео — подтверждённый сигнал" },
  B: { label: "B", color: "#E8AA42", title: "слабый сигнал: 1 крео за период или HELPS за весь срок без свежего HURTS" },
  C: { label: "C", color: "#888", title: "наша формулировка с 1 крео — только измерение, сигнала нет" },
};
const AX_COLOR: Record<string, string> = { persona: "#48B8D0", hook: "#C490D1", body: "#6EC8A0", angle: "#FF8B5A", concept: "#E8AA42", actor: "#D9A86B" };
const AX_RU: Record<string, string> = { persona: "Персона", hook: "Хук", body: "Боди", angle: "Энгл", concept: "Концепция", actor: "Актёр" };
const FORMATS: Format[] = ["ugc", "human", "animation", "mixed", "static"];

export default function NextPack({ product, reportId, compact }: { product: "buchhalter" | "medadmin" | "all"; reportId?: string | null; compact?: boolean }) {
  const router = useRouter();
  const [format, setFormat] = useState<Format>("ugc");
  const [packSize, setPackSize] = useState(20);
  const [explore, setExplore] = useState<string[]>([]);
  const [autoExplore, setAutoExplore] = useState(2);
  const [blocked, setBlocked] = useState<string[]>(["V2", "V3"]);
  const [actorKind, setActorKind] = useState<"ai" | "real">("ai"); // производство Higgsfield → ИИ-персонажи по умолчанию
  const [transfer, setTransfer] = useState(true); // категория «перенос медиа»
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [removed, setRemoved] = useState<Set<number>>(new Set());
  const [loading, setLoading] = useState(false);
  const [accepting, setAccepting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showAllConcepts, setShowAllConcepts] = useState(false);
  const [verif, setVerif] = useState<Verification | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [overrideGate, setOverrideGate] = useState(false);

  // Проверка предложения двумя моделями (как у отчёта): подмена кодов/текстов/чисел, выдуманные параметры
  const verify = useCallback(async (p: Proposal, keptSlots: PackSlot[]) => {
    setVerifying(true); setVerif(null); setOverrideGate(false);
    try {
      const r = await fetch("/api/pack/verify", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ product, format, slots: keptSlots, labels: p.labels, signals: p.signals, winners: p.winners, transferDonors: p.transferDonors, medium: p.medium, exploreList: p.exploreList, notes: p.notes, report: p.report }) });
      const j = await r.json();
      if (r.ok && j.verifications) setVerif(j.verifications as Verification);
      else setVerif({ overall: "warning", checks: [{ model: "system", status: "error", confidence: 0, issues: [], summary: j.error ?? `HTTP ${r.status}` }] });
    } catch (e) { setVerif({ overall: "warning", checks: [{ model: "system", status: "error", confidence: 0, issues: [], summary: e instanceof Error ? e.message : String(e) }] }); }
    finally { setVerifying(false); }
  }, [product, format]);

  const propose = useCallback(async () => {
    if (product === "all") { setError("Выбери продукт в сайдбаре — пак строится на формулировках одного продукта."); return; }
    setLoading(true); setError(null); setRemoved(new Set());
    try {
      const r = await fetch("/api/pack/propose", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ product, reportId: reportId ?? undefined, format, packSize, exploreConcepts: explore, autoExplore, blockedConcepts: blocked, actorKind: format === "static" ? null : actorKind, transfer }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      setProposal(j as Proposal);
      const slots = (j as Proposal).slots;
      // пустой пак (в отчёте нет виннеров этого медиа) — проверять нечего, причины уже в NOTES
      if (slots.length) void verify(j as Proposal, slots); else setVerif(null);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); setProposal(null); }
    finally { setLoading(false); }
  }, [product, reportId, format, packSize, explore, autoExplore, blocked, actorKind, transfer]);

  useEffect(() => { propose(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [product, reportId, format, packSize, explore.join(","), autoExplore, blocked.join(","), actorKind, transfer]);
  useEffect(() => { if (format === "human") setActorKind("real"); else if (format !== "static") setActorKind("ai"); }, [format]);

  const kept = useMemo(() => (proposal?.slots ?? []).filter(s => !removed.has(s.slotId)), [proposal, removed]);
  const measurable = useMemo(() => {
    if (!proposal) return { ok: 0, single: 0 };
    const cnt: Record<string, number> = {};
    for (const s of kept) for (const [ax, c] of Object.entries(s.codes)) if (c && ax !== "actor") cnt[c] = (cnt[c] ?? 0) + 1;
    const isNew = new Set(proposal.matrix.filter(m => m.isNew).map(m => m.code));
    const vals = Object.entries(cnt);
    return { ok: vals.filter(([, n]) => n >= 2).length, single: vals.filter(([c, n]) => n === 1 && isNew.has(c)).length };
  }, [proposal, kept]);

  const accept = async () => {
    if (!proposal || !kept.length) return;
    setAccepting(true); setError(null);
    try {
      const r = await fetch("/api/pack/generate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode: "engine", product, format, packSize: kept.length, reportId: proposal.report.id, slots: kept, exploreConcepts: explore, autoExplore, blockedConcepts: blocked, actorKind, transfer, override: true }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      const saved = (j.packMetadata?.slots?.length ?? 0) as number;
      if (saved !== kept.length) throw new Error(`Сохранено ${saved} слотов из ${kept.length} — пак не совпадает с предпросмотром (dropped=${j.dropped ?? "?"}). Пересобери пак или напиши разработчику.`);
      router.push(`/briefs?session=${j.sessionId}`);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); setAccepting(false); }
  };

  const toggleExplore = (code: string) => setExplore(prev => prev.includes(code) ? prev.filter(c => c !== code) : [...prev, code]);
  const toggleBlocked = (code: string) => setBlocked(prev => prev.includes(code) ? prev.filter(c => c !== code) : [...prev, code]);
  const L = (code: string | null | undefined) => (code ? proposal?.labels[code] ?? "" : "");
  const eur = (v: number | null | undefined) => (v == null ? "—" : `€${v.toFixed(1)}`);
  const RefLine = ({ r }: { r: Ref }) => (
    <div style={{ fontSize: 10.5, color: "#777", display: "flex", gap: 8, flexWrap: "wrap", alignItems: "baseline" }}>
      <span style={{ fontFamily: "monospace", color: "#999" }}>{r.adName}</span>
      <span>{r.status === "winner" ? "виннер" : r.status === "loser" ? "лузер" : r.status === "fake_winner" ? "fake" : r.status}</span>
      <span>€{Math.round(r.spend)}</span><span>{r.leads} лид.</span><span>CPL {eur(r.cpl)}</span><span>CPQL {eur(r.cpql)}</span>
      {r.media && <a href={r.media.url} target="_blank" rel="noreferrer" style={{ color: "#48B8D0" }}>▶ открыть {r.media.label}</a>}
    </div>
  );
  const gateBlocked = verif?.overall === "fail" && !overrideGate;
  const chip = (on: boolean, color: string): React.CSSProperties => ({
    padding: "5px 10px", borderRadius: 8, fontSize: 11, cursor: "pointer", fontFamily: "inherit", fontWeight: on ? 700 : 400,
    border: on ? `1.5px solid ${color}60` : "1px solid rgba(255,255,255,0.06)", background: on ? `${color}14` : "rgba(255,255,255,0.02)", color: on ? color : "#777",
  });

  const conceptList = proposal ? (showAllConcepts ? [...proposal.concepts.untested, ...proposal.concepts.tested] : proposal.concepts.untested.slice(0, 24)) : [];

  return (
    <Card style={{ border: "1px solid rgba(232,170,66,0.25)" }}>
      <SectionTitle icon="🧪" color="#E8AA42">Следующий пак — дизайн эксперимента</SectionTitle>
      <div style={{ fontSize: 12, color: "#888", marginTop: -6, marginBottom: 12, lineHeight: 1.6 }}>
        Пак собирается детерминированно из сигналов отчёта: семьи виннеров (меняется один параметр), масштабирование HELPS-формулировок и концепций в новых контекстах, разведка новых концепций с текстами виннеров дословно. Цель: следующий отчёт должен отделить вклад каждого параметра от вклада креатива.
      </div>

      {/* Ограничения */}
      <div style={{ display: "flex", gap: 18, flexWrap: "wrap", alignItems: "flex-start", marginBottom: 12 }}>
        <div>
          <div style={{ fontSize: 10, color: "#555", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 }}>Формат производства</div>
          <div style={{ display: "flex", gap: 6 }}>{FORMATS.map(f => <button key={f} onClick={() => setFormat(f)} style={chip(format === f, "#48B8D0")}>{f.toUpperCase()}</button>)}</div>
        </div>
        <div>
          <div style={{ fontSize: 10, color: "#555", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 }}>Размер пака</div>
          <div style={{ display: "flex", gap: 6 }}>{[10, 15, 20, 25].map(n => <button key={n} onClick={() => setPackSize(n)} style={chip(packSize === n, "#6EC8A0")}>{n}</button>)}</div>
        </div>
        {format !== "static" && (
          <div>
            <div style={{ fontSize: 10, color: "#555", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 }}>Актёры в кадре</div>
            <div style={{ display: "flex", gap: 6 }}>
              <button onClick={() => setActorKind("ai")} style={chip(actorKind === "ai", "#D9A86B")} title="ИИ-персонажи WOM/MAN — производство Higgsfield">ИИ-персонажи</button>
              <button onClick={() => setActorKind("real")} style={chip(actorKind === "real", "#D9A86B")} title="Реальные люди — съёмка">реальные люди</button>
            </div>
          </div>
        )}
        <div>
          <div style={{ fontSize: 10, color: "#555", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 }}>Перенос медиа</div>
          <div style={{ display: "flex", gap: 6 }}>
            <button onClick={() => setTransfer(true)} style={chip(transfer, "#E8AA42")} title="Виннеры другого медиа целиком: статика → видео или наоборот">вкл</button>
            <button onClick={() => setTransfer(false)} style={chip(!transfer, "#E8AA42")}>выкл</button>
          </div>
        </div>
        <div>
          <div style={{ fontSize: 10, color: "#555", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 }}>Автодобор новых концепций</div>
          <div style={{ display: "flex", gap: 6 }}>{[0, 1, 2, 3].map(n => <button key={n} onClick={() => setAutoExplore(n)} style={chip(autoExplore === n, "#C490D1")}>{n}</button>)}</div>
        </div>
        <div>
          <div style={{ fontSize: 10, color: "#555", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 }}>Без новых слотов (перекормленные концепции)</div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {["V2", "V3", "V8", "V25", "V27"].map(c => <button key={c} onClick={() => toggleBlocked(c)} style={chip(blocked.includes(c), "#D96B6B")} title={L(c) || c}>{c}{L(c) ? ` · ${L(c).slice(0, 22)}` : ""}</button>)}
          </div>
        </div>
      </div>

      {/* Разведка концепций — выбор человека */}
      {proposal && (
        <div style={{ marginBottom: 14, paddingTop: 10, borderTop: "1px solid rgba(255,255,255,0.05)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
            <div style={{ fontSize: 10, color: "#555", textTransform: "uppercase", letterSpacing: 0.5 }}>Концепции на разведку в этом цикле {explore.length ? `(выбрано ${explore.length}, по 3 крео на каждую)` : "(не выбраны — автодобор)"}</div>
            <button onClick={() => setShowAllConcepts(v => !v)} style={{ fontSize: 10, color: "#48B8D0", background: "none", border: "none", cursor: "pointer", fontFamily: "inherit", padding: 0 }}>
              {showAllConcepts ? "только непротестированные" : `показать все (${proposal.concepts.untested.length + proposal.concepts.tested.length})`}
            </button>
          </div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {conceptList.map(c => (
              <button key={c.code} onClick={() => toggleExplore(c.code)} style={chip(explore.includes(c.code), "#C490D1")} title={c.category ?? ""}>
                <span style={{ fontFamily: "monospace", marginRight: 6, opacity: 0.8 }}>{c.code}</span>{c.name}{c.used ? <span style={{ fontSize: 9, color: "#555", marginLeft: 6 }}>×{c.used}</span> : null}
              </button>
            ))}
          </div>
          {proposal.signals.helpsConcepts.length > 0 && (
            <div style={{ fontSize: 11, color: "#6EC8A0", marginTop: 8 }}>
              Концепции с подтверждённым эффектом (попадают в масштабирование автоматически): {proposal.signals.helpsConcepts.map(c => `${c.code} «${L(c.code)}» ×${c.ratio?.toFixed(2) ?? "—"} (${c.withCount} крео)`).join(" · ")}
            </div>
          )}
        </div>
      )}

      {error && <div style={{ fontSize: 12, color: "#D96B6B", marginBottom: 10 }}>{error}</div>}
      {loading && <div style={{ fontSize: 12, color: "#666", padding: "16px 0" }}>⏳ Считаю дизайн пака…</div>}

      {proposal && !loading && (
        <>
          {/* Сводка измеримости */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10, marginBottom: 12 }}>
            {[
              { k: "Слотов", v: kept.length, c: "#EEE" },
              { k: "Семьи", v: kept.filter(s => s.category === "winner_family").length, c: CAT.winner_family.color },
              { k: "Масштабирование", v: kept.filter(s => s.category === "winner_mix").length, c: CAT.winner_mix.color },
              { k: "Разведка", v: kept.filter(s => s.category === "discovery").length, c: CAT.discovery.color },
              { k: "Перенос медиа", v: kept.filter(s => s.category === "transfer").length, c: CAT.transfer.color },
              { k: "Уровень A / B / C", v: `${kept.filter(s => s.change?.tier === "A").length} / ${kept.filter(s => s.change?.tier === "B").length} / ${kept.filter(s => s.change?.tier === "C").length}`, c: "#CCC" },
              { k: "Параметров измеримо (≥2 слота)", v: measurable.ok, c: "#6EC8A0" },
              { k: "Новых в одном слоте", v: measurable.single, c: measurable.single ? "#E8AA42" : "#555" },
            ].map(x => (
              <div key={x.k} style={{ padding: "10px 12px", borderRadius: 8, background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)" }}>
                <div style={{ fontSize: 20, fontWeight: 800, color: x.c }}>{x.v}</div>
                <div style={{ fontSize: 10, color: "#666" }}>{x.k}</div>
              </div>
            ))}
          </div>
          {/* Проверка предложения (Gemini + Codex) — тот же гейт, что у отчёта */}
          <div style={{ marginBottom: 12, padding: "10px 12px", borderRadius: 8, border: `1px solid ${verif ? (verif.overall === "ok" ? "rgba(110,200,160,0.35)" : verif.overall === "warning" ? "rgba(232,170,66,0.35)" : "rgba(217,107,107,0.4)") : "rgba(255,255,255,0.08)"}`, background: "rgba(255,255,255,0.02)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: "#CCC" }}>🛡 Проверка пака (Gemini + Codex)</span>
              {verifying && <span style={{ fontSize: 11, color: "#888" }}>⏳ проверяю подмены кодов, текстов и чисел…</span>}
              {verif && <Badge color={verif.overall === "ok" ? "#6EC8A0" : verif.overall === "warning" ? "#E8AA42" : "#D96B6B"}>{verif.overall === "ok" ? "итог: ОК" : verif.overall === "warning" ? "итог: сомнения" : "итог: не пройдено"}</Badge>}
              {verif && !verifying && <Button size="sm" onClick={() => verify(proposal, kept)}>🔁 Перепроверить</Button>}
            </div>
            {verif && (
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 8 }}>
                {verif.checks.map(c => (
                  <div key={c.model} style={{ fontSize: 11, color: "#AAA", lineHeight: 1.5 }}>
                    <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 2 }}>
                      <b style={{ color: "#DDD" }}>{c.model === "gemini" ? "Gemini" : c.model === "codex" ? "Codex (OpenAI)" : c.model}</b>
                      <Badge color={c.status === "ok" ? "#6EC8A0" : c.status === "warning" ? "#E8AA42" : c.status === "fail" ? "#D96B6B" : "#777"}>{c.status}{c.confidence ? ` · ${Math.round(c.confidence * 100)}%` : ""}</Badge>
                    </div>
                    <div>{c.summary}</div>
                    {c.issues.slice(0, 5).map((i, k) => <div key={k} style={{ color: i.severity === "high" ? "#D96B6B" : i.severity === "medium" ? "#E8AA42" : "#888", paddingLeft: 8, borderLeft: `2px solid ${i.severity === "high" ? "#D96B6B" : i.severity === "medium" ? "#E8AA42" : "#555"}`, marginTop: 4 }}><b>{i.area}</b> — {i.detail}</div>)}
                  </div>
                ))}
              </div>
            )}
            {gateBlocked && <div style={{ marginTop: 8, fontSize: 11, color: "#D96B6B" }}>Проверка не пройдена — пак не принимаем. Пересобери или <button onClick={() => setOverrideGate(true)} style={{ background: "none", border: "none", color: "#E8AA42", cursor: "pointer", fontFamily: "inherit", fontSize: 11, textDecoration: "underline" }}>принять всё равно</button>.</div>}
          </div>
          {proposal.notes.length > 0 && (
            <div style={{ fontSize: 11.5, color: "#AAA", lineHeight: 1.6, marginBottom: 12, padding: "8px 12px", background: "rgba(232,170,66,0.06)", borderRadius: 8, borderLeft: "2px solid rgba(232,170,66,0.4)" }}>
              {proposal.notes.map((n, i) => <div key={i}>• {n}</div>)}
            </div>
          )}

          {/* Слоты по категориям */}
          {(Object.keys(CAT) as PackSlotCategory[]).map(cat => {
            const list = kept.filter(s => s.category === cat);
            if (!list.length) return null;
            return (
              <div key={cat} style={{ marginBottom: 14 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: CAT[cat].color, marginBottom: 6 }}>{CAT[cat].label} · {list.length} <span style={{ fontWeight: 400, color: "#666" }}>— {CAT[cat].desc}</span></div>
                <div style={{ display: "grid", gridTemplateColumns: compact ? "1fr" : "repeat(auto-fill, minmax(420px, 1fr))", gap: 8 }}>
                  {list.map(s => (
                    <div key={s.slotId} style={{ padding: 10, borderRadius: 10, border: `1px solid ${CAT[cat].color}30`, background: `${CAT[cat].color}08` }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                        <span style={{ fontSize: 10, fontWeight: 700, color: CAT[cat].color }}>#{s.slotId}</span>
                        <Badge color={proposal.medium === "video" ? "#48B8D0" : "#C490D1"}>→ {proposal.medium === "video" ? `видео · ${format.toUpperCase()}` : "статика"}</Badge>
                        {s.basedOnAd && (() => {
                          const donorMedium = proposal.winners.find(w => w.adName === s.basedOnAd)?.medium ?? proposal.transferDonors.find(d => d.adName === s.basedOnAd)?.medium;
                          return <span style={{ fontSize: 10, color: "#777", fontFamily: "monospace" }}>← {s.basedOnAd}{donorMedium ? <span style={{ color: donorMedium === proposal.medium ? "#555" : "#E8AA42", fontFamily: "inherit" }}> · донор: {donorMedium === "video" ? "видео" : "статика"}</span> : null}</span>;
                        })()}
                        {s.variedParam && <Badge color={AX_COLOR[s.variedParam]}>меняем {AX_RU[s.variedParam]}</Badge>}
                        {s.change?.tier && <span title={TIER[s.change.tier].title} style={{ fontSize: 10, fontWeight: 800, color: TIER[s.change.tier].color, border: `1px solid ${TIER[s.change.tier].color}60`, borderRadius: 4, padding: "0 6px" }}>уровень {TIER[s.change.tier].label}</span>}
                        <button onClick={() => setRemoved(prev => new Set([...prev, s.slotId]))} title="Убрать слот из пака" style={{ marginLeft: "auto", fontSize: 10, background: "none", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 4, color: "#777", cursor: "pointer", padding: "1px 7px", fontFamily: "inherit" }}>✕</button>
                      </div>
                      <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                        {(["persona", "hook", "body", "angle", "concept", "actor"] as const).map(ax => {
                          const code = s.codes[ax]; if (!code) return null;
                          const changed = s.variedParam === ax || (s.helpsCodes ?? []).includes(code);
                          return (
                            <div key={ax} style={{ display: "flex", gap: 8, fontSize: 11.5, lineHeight: 1.45 }}>
                              <span style={{ fontFamily: "monospace", color: AX_COLOR[ax], minWidth: 78, fontWeight: changed ? 800 : 500 }}>{code}</span>
                              <span style={{ color: changed ? "#EEE" : "#999", overflowWrap: "anywhere" }}>{L(code) || "—"}</span>
                            </div>
                          );
                        })}
                      </div>
                      {s.change && s.category === "transfer" && (
                        <div style={{ marginTop: 8, padding: "8px 10px", borderRadius: 8, background: "rgba(232,170,66,0.06)", border: "1px solid rgba(232,170,66,0.25)", fontSize: 11.5, color: "#CCC", lineHeight: 1.5 }}>
                          Все четыре формулировки — дословно из виннера-{proposal.medium === "video" ? "статики" : "видео"} <span style={{ fontFamily: "monospace" }}>{s.basedOnAd}</span>. Меняется только медиа: {proposal.medium === "video" ? `статика → видео (${format.toUpperCase()})` : "видео → статика"}.
                          {s.basedOnAd && proposal.refs.byAd[s.basedOnAd] && <div style={{ marginTop: 4 }}><RefLine r={proposal.refs.byAd[s.basedOnAd]} /></div>}
                        </div>
                      )}
                      {s.change && (s.category === "winner_family" || s.category === "winner_mix" || s.category === "discovery") && (
                        <div style={{ marginTop: 8, padding: "8px 10px", borderRadius: 8, background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)" }}>
                          <div style={{ fontSize: 10, color: AX_COLOR[s.change.axis], textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 }}>{AX_RU[s.change.axis]}: было → стало</div>
                          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                            <div>
                              <div style={{ fontSize: 10, color: "#666", marginBottom: 2 }}>БЫЛО {s.change.fromCode ? <span style={{ fontFamily: "monospace", color: "#999" }}>{s.change.fromCode}</span> : "(не задано)"}</div>
                              <div style={{ fontSize: 11.5, color: "#BBB", lineHeight: 1.45, overflowWrap: "anywhere" }}>«{L(s.change.fromCode) || "—"}»</div>
                              {s.basedOnAd && (() => { const w = proposal.winners.find(x => x.adName === s.basedOnAd); return w ? <div style={{ fontSize: 10.5, color: "#6EC8A0", marginTop: 4 }}>виннер за период отчёта: CPL {eur(w.cpl)} · {w.leads} лид. · €{Math.round(w.spend)}</div> : null; })()}
                              {s.basedOnAd && proposal.refs.byAd[s.basedOnAd] && <div style={{ marginTop: 2 }}><span style={{ fontSize: 10, color: "#555" }}>lifetime: </span><RefLine r={proposal.refs.byAd[s.basedOnAd]} /></div>}
                            </div>
                            <div>
                              <div style={{ fontSize: 10, color: "#6EC8A0", marginBottom: 2 }}>СТАЛО <span style={{ fontFamily: "monospace", color: "#6EC8A0" }}>{s.change.toCode}</span></div>
                              <div style={{ fontSize: 11.5, color: "#EEE", lineHeight: 1.45, overflowWrap: "anywhere" }}>«{L(s.change.toCode) || "—"}»</div>
                              {(proposal.refs.byCode[s.change.toCode] ?? []).length
                                ? <div style={{ marginTop: 4, display: "flex", flexDirection: "column", gap: 2 }}>{(proposal.refs.byCode[s.change.toCode] ?? []).slice(0, 3).map(r => <RefLine key={r.adName} r={r} />)}</div>
                                : <div style={{ fontSize: 10.5, color: "#E8AA42", marginTop: 4 }}>в массиве ещё не было крео с этим параметром — это новая проверка</div>}
                            </div>
                          </div>
                        </div>
                      )}
                      <div style={{ fontSize: 11, color: "#777", marginTop: 6, lineHeight: 1.5 }}>{s.rationale}</div>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}

          {/* Матрица измеримости */}
          <details style={{ marginBottom: 12 }}>
            <summary style={{ fontSize: 12, color: "#AAA", cursor: "pointer" }}>Матрица эксперимента: в каких слотах стоит каждый параметр ({proposal.matrix.length})</summary>
            <div style={{ display: "flex", flexDirection: "column", gap: 3, marginTop: 8 }}>
              {proposal.matrix.filter(m => m.axis !== "actor").map(m => {
                const inKept = m.slots.filter(id => !removed.has(id));
                return (
                  <div key={m.code} style={{ display: "flex", gap: 8, fontSize: 11, alignItems: "baseline" }}>
                    <span style={{ fontFamily: "monospace", color: AX_COLOR[m.axis], minWidth: 78 }}>{m.code}</span>
                    <span style={{ color: inKept.length >= 2 ? "#6EC8A0" : "#E8AA42", minWidth: 60 }}>{inKept.length} слот{inKept.length === 1 ? "" : inKept.length < 5 ? "а" : "ов"}</span>
                    <span style={{ color: "#555", minWidth: 90 }}>{m.isNew ? "новая" : "была в массиве"}</span>
                    <span style={{ color: "#999", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.label}</span>
                  </div>
                );
              })}
            </div>
          </details>

          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <Button variant="primary" onClick={accept} disabled={accepting || kept.length === 0 || verifying || gateBlocked}>{accepting ? "⏳ Создаю пак…" : verifying ? "⏳ Ждём проверку…" : `✅ Принять пак (${kept.length}) → брифы и ТЗ`}</Button>
            <Button onClick={propose} disabled={loading}>🔄 Пересобрать</Button>
            {removed.size > 0 && <Button onClick={() => setRemoved(new Set())}>Вернуть убранные ({removed.size})</Button>}
            <span style={{ fontSize: 11, color: "#555" }}>Основа: отчёт от {new Date(proposal.report.createdAt).toLocaleDateString("ru-RU")}{proposal.report.dateFrom ? ` за ${proposal.report.dateFrom} – ${proposal.report.dateTo}` : " (весь период)"} · проверка {proposal.report.overall ?? "—"}</span>
          </div>
        </>
      )}
    </Card>
  );
}
