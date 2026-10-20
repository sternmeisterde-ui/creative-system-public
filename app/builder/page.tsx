"use client";
import { useEffect, useState, Suspense } from "react";
import Link from "next/link";
import type { Format, AdFlow, PackMetadata, PackSlot, PackSlotCategory, Concept } from "@/lib/types";
import { conceptStore } from "@/lib/store";
import { useProduct } from "@/components/ChannelContext";
import { productMeta } from "@/lib/product";
import { reportPeriodLabel, reportAgeDays } from "@/lib/report-context";
import { Card, PageHeader, Button, Badge, SectionTitle, Empty } from "@/components/ui";
import NextPack from "@/components/NextPack";

// ── Constants ────────────────────────────────────────────────────────────────

const CATEGORY_META: Record<PackSlotCategory, { label: string; icon: string; color: string; pct: number; desc: string }> = {
  winner_family: { label: "Семьи — один параметр",      icon: "🌱", color: "#6EC8A0", pct: 25, desc: "Виннер, меняется ровно одна формулировка" },
  winner_mix:    { label: "Масштабирование HELPS",       icon: "🧬", color: "#48B8D0", pct: 50, desc: "Подтверждённая формулировка/концепция в новых контекстах" },
  discovery:     { label: "Разведка концепций",           icon: "🔍", color: "#C490D1", pct: 25, desc: "Новые концепции, тексты виннеров дословно" },
  competitor:    { label: "Конкуренты",                    icon: "🟣", color: "#FF8B5A", pct: 0,  desc: "Гипотезы из концептов конкурентов (режим Claude)" },
  transfer:      { label: "Перенос медиа",                 icon: "🔁", color: "#E8AA42", pct: 10, desc: "Виннер другого медиа целиком, меняется только медиа" },
};

const CODE_COLOR: Record<string, string> = {
  persona: "#48B8D0", hook: "#C490D1", body: "#6EC8A0", angle: "#FF8B5A",
  concept: "#E8AA42",
};

// ── Slot card ────────────────────────────────────────────────────────────────

function SlotCard({ slot, onRegenerate, regenerating }: {
  slot: PackSlot;
  onRegenerate: (slotId: number) => void;
  regenerating: boolean;
}) {
  const meta = CATEGORY_META[slot.category];
  return (
    <div style={{
      padding: 12, borderRadius: 10,
      border: `1px solid ${meta.color}30`,
      background: `${meta.color}08`,
      display: "flex", flexDirection: "column", gap: 8,
    }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ fontSize: 10, fontWeight: 700, color: meta.color, textTransform: "uppercase", letterSpacing: 0.5 }}>
          #{slot.slotId}
        </span>
        <button
          onClick={() => onRegenerate(slot.slotId)}
          disabled={regenerating}
          style={{
            fontSize: 10, padding: "2px 8px", borderRadius: 4, cursor: regenerating ? "wait" : "pointer",
            background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)",
            color: regenerating ? "#666" : "#AAA", fontFamily: "inherit",
          }}
        >
          {regenerating ? "⏳" : "🔄 регенерить"}
        </button>
      </div>

      <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
        {(["persona", "hook", "body", "angle", "concept"] as const).map(t => {
          const code = slot.codes[t];
          if (!code) return null;
          return (
            <span key={t} style={{
              fontFamily: "monospace", fontSize: 11, fontWeight: 700,
              color: CODE_COLOR[t], background: `${CODE_COLOR[t]}18`,
              padding: "2px 6px", borderRadius: 4,
            }}>{code}</span>
          );
        })}
      </div>

      <div style={{ fontSize: 11, color: "#888", lineHeight: 1.5 }}>{slot.rationale}</div>

      {slot.basedOnAd && (
        <div style={{ fontSize: 10, color: "#555" }}>
          ← <span style={{ color: "#888", fontFamily: "monospace" }}>{slot.basedOnAd}</span>
          {slot.variedParam && <span> · меняем {slot.variedParam}</span>}
        </div>
      )}
      {slot.fromWinners && slot.fromWinners.length > 0 && (
        <div style={{ fontSize: 10, color: "#555" }}>← из винеров: {slot.fromWinners.join(", ")}</div>
      )}
      {slot.helpsCodes && slot.helpsCodes.length > 0 && (
        <div style={{ fontSize: 10, color: "#555" }}>HELPS: {slot.helpsCodes.join(", ")}</div>
      )}
      {slot.newCodesCreated && slot.newCodesCreated.length > 0 && (
        <div style={{ fontSize: 10, color: "#FF8B5A" }}>+ новые коды: {slot.newCodesCreated.join(", ")}</div>
      )}
    </div>
  );
}

// ── Group section ────────────────────────────────────────────────────────────

function GroupSection({ category, slots, onRegenerate, regenerating }: {
  category: PackSlotCategory;
  slots: PackSlot[];
  onRegenerate: (slotId: number) => void;
  regenerating: number | null;
}) {
  const meta = CATEGORY_META[category];
  if (slots.length === 0) return null;

  return (
    <Card style={{ marginBottom: 16 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
        <SectionTitle icon={meta.icon} color={meta.color}>{meta.label}</SectionTitle>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <Badge color={meta.color}>{slots.length} шт · {meta.pct}%</Badge>
        </div>
      </div>
      <div style={{ fontSize: 11, color: "#555", marginBottom: 12 }}>{meta.desc}</div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 10 }}>
        {slots.map(s => (
          <SlotCard key={s.slotId} slot={s} onRegenerate={onRegenerate} regenerating={regenerating === s.slotId} />
        ))}
      </div>
    </Card>
  );
}

// ── History row ──────────────────────────────────────────────────────────────

interface HistoryRow {
  id: string;
  name: string;
  flow: AdFlow | null;
  format: Format;
  generated_at: string | null;
  pack_size: number;
  pack_metadata: PackMetadata | null;
}

// ── Main ──────────────────────────────────────────────────────────────────────

function BuilderContent() {
  const flow: AdFlow = "com"; // служебное: потоков больше нет, пак строится на всём массиве
  const { product } = useProduct(); // Бухгалтер / Медадмин / оба — из сайдбара
  const [format, setFormat] = useState<Format>("ugc");
  // Концепция видео (type of video): по умолчанию — те, что мы нашли в своих крео (is_ours); можно раскрыть всю библиотеку
  const [concepts, setConcepts] = useState<Concept[]>([]);
  const [conceptCode, setConceptCode] = useState<string | null>(null);
  const [allConcepts, setAllConcepts] = useState(false);
  const [packSize, setPackSize] = useState(20);

  useEffect(() => { conceptStore.getAll().then(setConcepts).catch(() => {}); }, []);

  // Концепция подсказывает формат производства (можно перещёлкнуть вручную)
  const pickConcept = (c: Concept | null) => {
    setConceptCode(c?.code ?? null);
    if (!c) return;
    const cat = (c.category ?? "").toLowerCase();
    if (cat.includes("анимац")) setFormat("animation");
    else if (cat.includes("ugc")) setFormat("ugc");
    else if (cat.includes("статик") || cat.includes("экран") || cat.includes("гибрид")) setFormat("mixed");
    else setFormat("human");
  };
  const visibleConcepts = concepts.filter(c => allConcepts || c.isOurs);
  const conceptGroups = visibleConcepts.reduce<Record<string, Concept[]>>((acc, c) => { (acc[c.category ?? "Прочее"] ??= []).push(c); return acc; }, {});
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [gate, setGate] = useState<{ overall: string; error: string; issues: { model: string; severity: string; area: string; detail: string }[] } | null>(null);
  // Основа пака — последний отчёт продукта (meta → общий). Без него конструктор заблокирован.
  type BaseReport = { id: string; created_at: string; platform: string; product: string; date_from: string | null; date_to: string | null; kpi: { winners: number; losers: number; fakeWinners: number; activeAds: number }; verifications?: { overall?: string } | null };
  const [baseReport, setBaseReport] = useState<BaseReport | null | undefined>(undefined);
  useEffect(() => {
    (async () => {
      setBaseReport(undefined);
      for (const platform of ["meta", "all"]) {
        try {
          const r = await fetch(`/api/analytics/report?platform=${platform}&product=${product}`);
          const d = await r.json();
          if (d.latest) { setBaseReport(d.latest as BaseReport); return; }
        } catch { /* пробуем дальше */ }
      }
      setBaseReport(null);
    })();
  }, [product]);

  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [currentPack, setCurrentPack] = useState<PackMetadata | null>(null);
  const [regenSlot, setRegenSlot] = useState<number | null>(null);

  const [history, setHistory] = useState<HistoryRow[]>([]);

  useEffect(() => {
    fetch("/api/pack/history").then(r => r.ok ? r.json() : null).then(d => {
      if (d?.sessions) setHistory(d.sessions);
    }).catch(() => {});
  }, [currentSessionId]);

  const handleGenerate = async (override = false) => {
    setError(null);
    setGate(null);
    setGenerating(true);
    setCurrentPack(null);
    setCurrentSessionId(null);
    try {
      const res = await fetch("/api/pack/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ flow, format, conceptCode, product, packSize, override }),
      });
      const data = await res.json();
      if (res.status === 409 && data.gate === "no_report") {
        setError(data.error);
      } else if (res.status === 409 && data.gate) {
        // Гейт проверки: warning → подтверждение, fail → блок (оба обходятся override).
        setGate({ overall: data.gate, error: data.error ?? "", issues: data.issues ?? [] });
      } else if (!res.ok) {
        setError(data.error ?? `HTTP ${res.status}`);
      } else {
        setCurrentSessionId(data.sessionId);
        setCurrentPack(data.packMetadata);
      }
    } catch (e) {
      setError(`Ошибка сети: ${(e as Error).message}`);
    } finally {
      setGenerating(false);
    }
  };

  const handleRegenerateSlot = async (slotId: number) => {
    if (!currentSessionId) return;
    setRegenSlot(slotId);
    try {
      const res = await fetch("/api/pack/regenerate-slot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: currentSessionId, slotId }),
      });
      const data = await res.json();
      if (res.ok && data.slot) {
        setCurrentPack(prev => prev ? { ...prev, slots: prev.slots.map(s => s.slotId === slotId ? data.slot : s) } : prev);
      } else {
        alert(data.error ?? `HTTP ${res.status}`);
      }
    } catch (e) {
      alert(`Ошибка сети: ${(e as Error).message}`);
    } finally {
      setRegenSlot(null);
    }
  };

  const loadHistoryPack = (h: HistoryRow) => {
    if (!h.pack_metadata) return;
    setCurrentSessionId(h.id);
    setCurrentPack(h.pack_metadata);
  };

  const slotsByCategory = (cat: PackSlotCategory) =>
    currentPack?.slots.filter(s => s.category === cat) ?? [];

  return (
    <div>
      <PageHeader
        title={`Конструктор · ${productMeta(product).label}`}
        subtitle="Пак как дизайн эксперимента на последнем отчёте продукта: семьи виннеров (один параметр), масштабирование HELPS-формулировок и концепций, разведка новых концепций. Здесь задаются ограничения производства и принимается состав; брифы и ТЗ собираются после «Принять»."
      />
      {product === "all"
        ? <Card style={{ marginBottom: 16 }}><div style={{ fontSize: 12, color: "#888" }}>Выбери продукт (Бухгалтер или Медадмин) в сайдбаре — формулировки и пак привязаны к продукту.</div></Card>
        : <NextPack product={product} />}
      {currentPack && (
        <Card style={{ marginTop: 16 }}>
          <SectionTitle icon="📦">Пак из истории · {currentPack.slots.length} слотов{currentPack.experiment?.mode ? ` · режим ${currentPack.experiment.mode}` : ""}</SectionTitle>
          {currentPack.experiment?.notes?.length ? <div style={{ fontSize: 11, color: "#AAA", marginBottom: 8 }}>{currentPack.experiment.notes.map((n, i) => <div key={i}>• {n}</div>)}</div> : null}
          <GroupSection category="winner_family" slots={slotsByCategory("winner_family")} onRegenerate={handleRegenerateSlot} regenerating={regenSlot} />
          <GroupSection category="winner_mix"    slots={slotsByCategory("winner_mix")}    onRegenerate={handleRegenerateSlot} regenerating={regenSlot} />
          <GroupSection category="discovery"     slots={slotsByCategory("discovery")}     onRegenerate={handleRegenerateSlot} regenerating={regenSlot} />
          <GroupSection category="competitor"    slots={slotsByCategory("competitor")}    onRegenerate={handleRegenerateSlot} regenerating={regenSlot} />
          <GroupSection category="transfer"      slots={slotsByCategory("transfer")}      onRegenerate={handleRegenerateSlot} regenerating={regenSlot} />
          {currentSessionId && <div style={{ marginTop: 10 }}><Link href={`/briefs?session=${currentSessionId}`}><Button variant="primary">→ Брифы этого пака</Button></Link></div>}
        </Card>
      )}

      {/* History */}
      <Card style={{ marginTop: 24 }}>
        <SectionTitle icon="📜">История паков</SectionTitle>
        {history.length === 0 ? (
          <Empty icon="🌱" text="Паков ещё не было. Сгенерируй первый." />
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 12 }}>
            {history.map(h => (
              <div key={h.id} onClick={() => loadHistoryPack(h)} style={{
                padding: "10px 12px", borderRadius: 8, cursor: "pointer",
                background: currentSessionId === h.id ? "rgba(232,170,66,0.08)" : "rgba(255,255,255,0.02)",
                border: currentSessionId === h.id ? "1px solid rgba(232,170,66,0.3)" : "1px solid rgba(255,255,255,0.04)",
                display: "flex", alignItems: "center", gap: 12,
              }}>
                <span style={{ fontSize: 12, color: "#DDD", fontWeight: 600 }}>{h.name}</span>
                <Badge color="#888">{h.format}</Badge>
                {h.pack_metadata?.product && h.pack_metadata.product !== "all" && <Badge color={productMeta(h.pack_metadata.product).color}>{productMeta(h.pack_metadata.product).label}</Badge>}
                {h.pack_metadata?.concept && <Badge color="#C490D1">{h.pack_metadata.concept.code} · {h.pack_metadata.concept.name}</Badge>}
                <span style={{ fontSize: 11, color: "#666" }}>{h.pack_size} крео</span>
                {h.pack_metadata?.cold_start && <Badge color="#E8AA42">cold start</Badge>}
                <span style={{ marginLeft: "auto", fontSize: 10, color: "#444" }}>
                  {h.generated_at ? new Date(h.generated_at).toLocaleString("ru-RU") : "—"}
                </span>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

export default function BuilderPage() {
  return (
    <Suspense fallback={<div style={{ padding: 60, color: "#444", textAlign: "center" }}>Загружаем…</div>}>
      <BuilderContent />
    </Suspense>
  );
}
