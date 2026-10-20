"use client";
import { useState, useEffect, useCallback } from "react";
import { useChannel, channelMeta, useProduct } from "@/components/ChannelContext";
import { productMeta } from "@/lib/product";
import dynamic from "next/dynamic";
import { Card, PageHeader, Button, Badge, Stat, SectionTitle, Empty } from "@/components/ui";
import NextPack from "@/components/NextPack";
import { formulationStore } from "@/lib/store";
import type { AnalysisReport, ReportSignal, ReportHookSignal, ReportFamily, ReportCombo, ReportCompetitor, ReportVerification, ReportVerifications } from "@/lib/types";

// Метаданные параметра для тултипа на коде (P/H/B/A)
type ParamInfo = { type: string; typeLabel: string; name: string; description?: string };
const TYPE_LABEL: Record<string, string> = { persona: "Персона", hook: "Хук", body: "Боди", angle: "Энгл" };

// React Flow — только на клиенте (обращается к window)
const LineageGraph = dynamic(() => import("@/components/LineageGraph"), { ssr: false });

const PARAM_COLOR: Record<string, string> = {
  persona: "#48B8D0", hook: "#C490D1", body: "#6EC8A0", angle: "#FF8B5A", format: "#E8AA42", flow: "#888", concept: "#7B8CDE", actor: "#D9A86B",
};
const HEALTH = {
  healthy: { c: "#6EC8A0", t: "здоров" }, warning: { c: "#FF8B5A", t: "тревога" },
  dying: { c: "#D96B6B", t: "выгорает" }, unknown: { c: "#888", t: "нет данных" },
} as const;

const cplColor = (v: number | null) => v == null ? "#666" : v <= 20 ? "#6EC8A0" : v <= 26 ? "#FF8B5A" : "#D96B6B";
const eur = (v: number | null | undefined) => v == null ? "—" : `€${v.toFixed(1)}`;

// Светофор-шкала hook rate (3-сек просмотры / показы).
function hookBand(r: number | null | undefined): { color: string; label: string } {
  if (r == null) return { color: "#444", label: "—" };
  if (r >= 45) return { color: "#48B8D0", label: "Elite" };
  if (r >= 35) return { color: "#6EC8A0", label: "Strong" };
  if (r >= 25) return { color: "#E8AA42", label: "Solid" };
  if (r >= 15) return { color: "#FF8B5A", label: "Workable" };
  return { color: "#D96B6B", label: "Fix-it" };
}
const HOOK_BANDS = [["Fix-it", "#D96B6B", "<15%"], ["Workable", "#FF8B5A", "15-25"], ["Solid", "#E8AA42", "25-35"], ["Strong", "#6EC8A0", "35-45"], ["Elite", "#48B8D0", "45+"]] as const;

// Код параметра с тултипом (наведение → тип, название, описание).
function CodeTag({ code, info, color }: { code: string; info?: ParamInfo; color?: string }) {
  const [hover, setHover] = useState(false);
  const c = color ?? (info ? PARAM_COLOR[info.type] : undefined) ?? "#CCC";
  return (
    <span
      style={{ position: "relative", display: "inline-block" }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <span style={{ fontFamily: "monospace", fontWeight: 700, color: c, fontSize: 12, cursor: info ? "help" : "default", borderBottom: info ? "1px dotted rgba(255,255,255,0.3)" : "none" }}>{code}</span>
      {hover && info && (
        <span style={{ position: "absolute", bottom: "calc(100% + 6px)", left: 0, zIndex: 100, width: 240, padding: "9px 11px", background: "#14161C", border: "1px solid rgba(255,255,255,0.14)", borderRadius: 8, boxShadow: "0 8px 28px rgba(0,0,0,0.55)", whiteSpace: "normal", textAlign: "left", pointerEvents: "none" }}>
          <span style={{ display: "block", fontSize: 10, textTransform: "uppercase", letterSpacing: 0.5, color: PARAM_COLOR[info.type] ?? "#888", marginBottom: 3 }}>{info.typeLabel} · {code}</span>
          <span style={{ display: "block", fontSize: 12, fontWeight: 700, color: "#EEE", marginBottom: info.description ? 4 : 0 }}>{info.name}</span>
          {info.description && <span style={{ display: "block", fontSize: 11, color: "#AAA", lineHeight: 1.5 }}>{info.description}</span>}
        </span>
      )}
    </span>
  );
}

// Минимальный markdown-рендер (как в /analyze)
function MarkdownBlock({ text }: { text: string }) {
  return (
    <div style={{ fontSize: 13, color: "#CCC", lineHeight: 1.9 }}>
      {text.split("\n").map((line, i) => {
        if (line.startsWith("### ") || line.startsWith("## ")) {
          return <div key={i} style={{ fontWeight: 700, color: "#48B8D0", fontSize: 13, marginTop: 18, marginBottom: 4 }}>{line.replace(/^#+\s*/, "")}</div>;
        }
        if (/^\*\*.*\*\*$/.test(line.trim())) {
          return <div key={i} style={{ fontWeight: 700, color: "#E8AA42", marginTop: 12, marginBottom: 2 }}>{line.replace(/\*\*/g, "")}</div>;
        }
        if (line.startsWith("- ") || line.startsWith("* ")) {
          const parts = line.slice(2).split(/\*\*(.*?)\*\*/g);
          return <div key={i} style={{ paddingLeft: 16, color: "#BBB" }}>• {parts.map((p, j) => j % 2 === 1 ? <strong key={j} style={{ color: "#EEE" }}>{p}</strong> : p)}</div>;
        }
        if (line.trim() === "" || line.trim() === "---") return <div key={i} style={{ height: 8 }} />;
        const parts = line.split(/\*\*(.*?)\*\*/g);
        return <div key={i} style={{ color: "#CCC" }}>{parts.map((p, j) => j % 2 === 1 ? <strong key={j} style={{ color: "#EEE" }}>{p}</strong> : p)}</div>;
      })}
    </div>
  );
}

// Сигнал = конкретная формулировка: код, ось, дословный текст целиком, охват и CPL с ней / без неё.
const AXIS_RU: Record<string, string> = { persona: "персона", hook: "хук", body: "боди", angle: "энгл", format: "формат", concept: "концепция", actor: "актёр" };
function Chip({ s, helps, paramInfo }: { s: ReportSignal; helps: boolean; paramInfo: Record<string, ParamInfo> }) {
  const c = PARAM_COLOR[s.paramType] ?? "#888";
  const tone = helps ? "#6EC8A0" : "#D96B6B";
  const text = paramInfo[s.code]?.name ?? s.label;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, padding: "9px 12px", borderRadius: 8, background: `${tone}10`, border: `1px solid ${tone}30`, width: "100%" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <CodeTag code={s.code} info={paramInfo[s.code]} color={c} />
        <span style={{ fontSize: 10, color: c, textTransform: "uppercase", letterSpacing: 0.5 }}>{AXIS_RU[s.paramType] ?? s.paramType}</span>
        <span style={{ fontSize: 10, color: "#777" }}>{s.adCount != null ? `${s.adCount} крео` : ""}</span>
        <span style={{ fontSize: 11, color: tone, fontWeight: 700, marginLeft: "auto" }}>
          CPL {s.withCpl != null ? `€${s.withCpl.toFixed(1)}` : "—"} <span style={{ color: "#666", fontWeight: 400 }}>vs €{s.withoutCpl != null ? s.withoutCpl.toFixed(1) : "—"} у остальных</span> · ×{s.ratio?.toFixed(2) ?? "—"}
        </span>
      </div>
      <div style={{ fontSize: 12.5, color: "#DDD", lineHeight: 1.5, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>«{text}»</div>
      {s.ads && s.ads.length > 0 && (
        <div style={{ fontSize: 10.5, color: "#666", fontFamily: "monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={s.ads.join(", ")}>
          {(s.adCount ?? 0) === 1 ? "одно крео: " : "крео: "}{s.ads.slice(0, 5).join(", ")}{(s.adCount ?? 0) > 5 ? ` … ещё ${(s.adCount ?? 0) - 5}` : ""}
        </div>
      )}
    </div>
  );
}

function HookChip({ h, paramInfo }: { h: ReportHookSignal; paramInfo: Record<string, ParamInfo> }) {
  const c = PARAM_COLOR[h.paramType] ?? "#888";
  const b = hookBand(h.hookRate);                 // абсолютный уровень (шкала)
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "5px 10px", borderRadius: 8, background: `${b.color}14`, border: `1px solid ${b.color}40` }}>
      <CodeTag code={h.code} info={paramInfo[h.code]} color={c} />
      <span style={{ fontSize: 11, color: b.color, fontWeight: 700 }}>{h.hookRate != null ? `${h.hookRate.toFixed(1)}%` : "—"}</span>
      <span style={{ fontSize: 9, color: b.color, opacity: 0.9 }}>{b.label}</span>
      {h.holdRate != null && <span style={{ fontSize: 10, color: "#C490D1" }}>hold {h.holdRate.toFixed(0)}%</span>}
      <span style={{ fontSize: 10, color: "#777", fontWeight: 700 }}>×{h.ratio?.toFixed(2) ?? "—"}</span>
    </span>
  );
}

const VSTATUS: Record<string, { c: string; t: string }> = {
  ok: { c: "#6EC8A0", t: "OK" }, warning: { c: "#FF8B5A", t: "Сомнения" }, fail: { c: "#D96B6B", t: "Не пройдено" },
  skipped: { c: "#666", t: "Пропущено" }, error: { c: "#666", t: "Ошибка" },
};
const MODEL_LABEL: Record<string, string> = { gemini: "Gemini", codex: "Codex (OpenAI)" };
const SEV_COLOR: Record<string, string> = { high: "#D96B6B", medium: "#FF8B5A", low: "#888" };

function VerdictPanel({ v }: { v: ReportVerification }) {
  const st = VSTATUS[v.status] ?? VSTATUS.error;
  const showConf = v.status === "ok" || v.status === "warning" || v.status === "fail";
  return (
    <div style={{ flex: 1, minWidth: 240, border: `1px solid ${st.c}30`, borderRadius: 10, padding: "12px 14px", background: `${st.c}0A` }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
        <span style={{ fontWeight: 700, color: "#DDD", fontSize: 13 }}>{MODEL_LABEL[v.model] ?? v.model}</span>
        <Badge color={st.c}>{st.t}{showConf ? ` · ${Math.round(v.confidence * 100)}%` : ""}</Badge>
      </div>
      {v.summary && <div style={{ fontSize: 12, color: "#AAA", lineHeight: 1.5, marginBottom: v.issues.length ? 8 : 0 }}>{v.summary}</div>}
      {v.issues.map((it, i) => (
        <div key={i} style={{ fontSize: 11, color: "#BBB", lineHeight: 1.45, marginTop: 5, paddingLeft: 10, borderLeft: `2px solid ${SEV_COLOR[it.severity] ?? "#888"}` }}>
          <b style={{ color: SEV_COLOR[it.severity] ?? "#888" }}>{it.area}</b> — {it.detail}
        </div>
      ))}
    </div>
  );
}

function VerificationCard({ v }: { v: ReportVerifications | null }) {
  if (!v) return null;
  const st = VSTATUS[v.overall] ?? VSTATUS.warning;
  return (
    <Card style={{ borderColor: `${st.c}40` }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
        <SectionTitle icon="🛡" color={st.c}>Проверка отчёта (Gemini + Codex)</SectionTitle>
        <Badge color={st.c}>итог: {st.t}</Badge>
      </div>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        {v.checks.map((c, i) => <VerdictPanel key={i} v={c} />)}
      </div>
    </Card>
  );
}

export default function ReportPage() {
  const [view, setView] = useState<"report" | "graph">("report");
  const [report, setReport] = useState<AnalysisReport | null>(null);
  const [history, setHistory] = useState<{ id: string; created_at: string; flow: string; kpi: AnalysisReport["kpi"]; date_from?: string | null; date_to?: string | null }[]>([]);
  // Период отчёта: lifetime (как раньше) или окно дат — пресеты + свой диапазон
  type PeriodPreset = "lifetime" | "7d" | "30d" | "thisMonth" | "lastMonth" | "custom";
  const [preset, setPreset] = useState<PeriodPreset>("lifetime");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const applyPreset = (p: PeriodPreset) => {
    setPreset(p);
    const today = new Date(); const y = today.getFullYear(), m = today.getMonth();
    const yesterday = new Date(today.getTime() - 864e5);
    if (p === "7d")  { setDateFrom(iso(new Date(today.getTime() - 7 * 864e5))); setDateTo(iso(yesterday)); }
    if (p === "30d") { setDateFrom(iso(new Date(today.getTime() - 30 * 864e5))); setDateTo(iso(yesterday)); }
    if (p === "thisMonth") { setDateFrom(iso(new Date(Date.UTC(y, m, 1)))); setDateTo(iso(yesterday)); }
    if (p === "lastMonth") { setDateFrom(iso(new Date(Date.UTC(y, m - 1, 1)))); setDateTo(iso(new Date(Date.UTC(y, m, 0)))); }
    if (p === "lifetime") { setDateFrom(""); setDateTo(""); }
  };
  const periodBody = preset === "lifetime" ? {} : { dateFrom, dateTo };
  const periodLabel = (r?: { date_from?: string | null; date_to?: string | null } | null) =>
    r?.date_from && r?.date_to ? `${new Date(r.date_from).toLocaleDateString("ru-RU")} – ${new Date(r.date_to).toLocaleDateString("ru-RU")}` : "весь период";
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [paramInfo, setParamInfo] = useState<Record<string, ParamInfo>>({});
  const [override, setOverride] = useState(false); // показать отчёт несмотря на fail-проверку

  // Метаданные параметров (P/H/B/A) для тултипов на кодах — грузим один раз.
  useEffect(() => {
    (async () => {
      try {
        // Код = одна дословная формулировка (lib/formulations.ts); тултип показывает её текст целиком
        const forms = await formulationStore.getAll();
        const m: Record<string, ParamInfo> = {};
        for (const f of forms) m[f.code] = { type: f.axis, typeLabel: TYPE_LABEL[f.axis], name: f.text, description: f.note ?? undefined };
        setParamInfo(m);
      } catch { /* тултипы просто не покажутся */ }
    })();
  }, []);

  const { channel } = useChannel();
  const { product } = useProduct();
  const loadLatest = useCallback(async () => {
    try {
      const r = await fetch(`/api/analytics/report?platform=${channel}&product=${product}`);
      const d = await r.json();
      setReport(d.latest ?? null);
      setHistory(d.history ?? []);
    } catch { /* пусто — покажем empty */ }
  }, [channel, product]);

  useEffect(() => { loadLatest(); }, [loadLatest]);
  useEffect(() => { setOverride(false); }, [report?.id]); // новый снапшот → снова под блокировкой

  const generate = async () => {
    if (preset !== "lifetime" && (!dateFrom || !dateTo || dateFrom > dateTo)) { setError("Укажи корректный период: дата начала не позже даты конца"); return; }
    setLoading(true); setError("");
    try {
      const r = await fetch("/api/analytics/report", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ platform: channel, product, ...periodBody }),
      });
      // Vercel при таймауте/сбое функции отдаёт текст, а не JSON — показываем понятную причину
      const raw = await r.text();
      let d: { error?: string; report?: AnalysisReport } = {};
      try { d = JSON.parse(raw); } catch {
        throw new Error(r.status === 504 || /TIMEOUT/i.test(raw) ? "Сборка отчёта не уложилась в лимит времени функции. Попробуй период короче или повтори — лимит поднят до 800 с." : `Сервер ответил не JSON (HTTP ${r.status}): ${raw.slice(0, 160)}`);
      }
      if (!r.ok) throw new Error(d.error ?? "Ошибка генерации");
      if (!d.report) throw new Error("Пустой ответ без отчёта");
      setReport(d.report);
      await loadLatest();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  };

  const loadSnapshot = async (id: string) => {
    const r = await fetch(`/api/analytics/report?id=${id}`);
    const d = await r.json();
    if (d.latest) setReport(d.latest);
  };

  const kpi = report?.kpi;
  const visual = report?.visual;
  const h = HEALTH[kpi?.packHealth ?? "unknown"];
  const verifications = report?.verifications ?? null;
  // Блокирующий режим: при fail-вердикте прячем данные, пока пользователь не нажмёт «показать».
  const blocked = verifications?.overall === "fail" && !override;

  return (
    <div style={{ maxWidth: 1100, margin: "0 auto" }}>
      <PageHeader
        title={`🧠 Отчёт · ${productMeta(product).label} · ${channelMeta(channel).label}${report ? ` · ${periodLabel(report)}` : ""}`}
        subtitle={`${product === "all" ? "Оба продукта" : `Только креативы продукта «${productMeta(product).label}»`} · ${channel === "all" ? "все каналы" : "канал"} · визуальная сводка + разбор → рекомендации к производству (55/25/20). Продукт и канал переключаются в сайдбаре.`}
        action={
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <div style={{ display: "flex", gap: 4 }}>
              <Button size="sm" variant={view === "report" ? "primary" : "ghost"} onClick={() => setView("report")}>📊 Отчёт</Button>
              <Button size="sm" variant={view === "graph" ? "primary" : "ghost"} onClick={() => setView("graph")}>🗺 Схема</Button>
            </div>
            {view === "report" && report?.id && (
              <a href={`/api/analytics/report/docx?id=${report.id}`} download style={{ textDecoration: "none" }} title="Скачать этот отчёт в Word (DOCX): проверка, KPI, сигналы, семьи, комбо и полный разбор">
                <Button variant="ghost" style={{ border: "1px solid rgba(110,200,160,0.3)", color: "#6EC8A0", background: "rgba(110,200,160,0.08)" }}>📄 Скачать DOCX</Button>
              </a>
            )}
            {view === "report" && (
              <Button variant="primary" onClick={generate} disabled={loading}>
                {loading ? "⏳ Анализирую…" : "✨ Сгенерировать отчёт"}
              </Button>
            )}
          </div>
        }
      />

      {view === "report" && (
        <Card style={{ marginBottom: 16 }}>
          <div style={{ display: "flex", gap: 14, alignItems: "flex-end", flexWrap: "wrap" }}>
            <div>
              <div style={{ fontSize: 10, color: "#555", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 }}>Период отчёта</div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {([["lifetime", "Весь период"], ["7d", "7 дней"], ["30d", "30 дней"], ["thisMonth", "Этот месяц"], ["lastMonth", "Прошлый месяц"], ["custom", "Свой"]] as [PeriodPreset, string][]).map(([p, label]) => (
                  <button key={p} onClick={() => applyPreset(p)} style={{
                    padding: "7px 12px", borderRadius: 8, fontSize: 11, cursor: "pointer", fontFamily: "inherit",
                    fontWeight: preset === p ? 700 : 400,
                    border: preset === p ? "1.5px solid rgba(232,170,66,0.45)" : "1px solid rgba(255,255,255,0.06)",
                    background: preset === p ? "rgba(232,170,66,0.12)" : "rgba(255,255,255,0.02)",
                    color: preset === p ? "#E8AA42" : "#666",
                  }}>{label}</button>
                ))}
              </div>
            </div>
            {preset !== "lifetime" && (
              <>
                <label style={{ fontSize: 11, color: "#777", display: "flex", flexDirection: "column", gap: 4 }}>с
                  <input type="date" value={dateFrom} onChange={e => { setDateFrom(e.target.value); setPreset("custom"); }}
                    style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 8, padding: "6px 10px", color: "#DDD", fontFamily: "inherit", fontSize: 12 }} />
                </label>
                <label style={{ fontSize: 11, color: "#777", display: "flex", flexDirection: "column", gap: 4 }}>по
                  <input type="date" value={dateTo} onChange={e => { setDateTo(e.target.value); setPreset("custom"); }}
                    style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 8, padding: "6px 10px", color: "#DDD", fontFamily: "inherit", fontSize: 12 }} />
                </label>
              </>
            )}
            <div style={{ fontSize: 11, color: "#555", lineHeight: 1.5, flex: 1, minWidth: 260 }}>
              {preset === "lifetime"
                ? "Lifetime: метрики и статусы за весь срок жизни креативов, включая ROAS и риск-сигналы."
                : "Окно дат: спенд/показы из дневных строк Meta (Google и TikTok — из их API), лиды из CRM за эти же даты. Виннер/лузер — по CPL и CPQL за окно; ROAS и fake winners в окне не считаются. Сборка идёт 2–4 минуты."}
            </div>
          </div>
        </Card>
      )}

      {view === "graph" && (
        <Card style={{ padding: 0 }}>
          <div style={{ padding: "16px 20px 0" }}>
            <SectionTitle icon="🗺" color="#C490D1">Виннеры → новые креативы</SectionTitle>
            <p style={{ fontSize: 12, color: "#666", marginTop: -8, marginBottom: 12 }}>
              Актуальные крео за последние 90 дней (весь массив, с кодами P/H/B/A). Виннеры → предлагаемый креатив (замена 1 параметра на HELPS-код). Лузеры (слева) — что не повторять. Узлы можно таскать, колесо — зум.
            </p>
          </div>
          <LineageGraph />
        </Card>
      )}

      {error && <Card style={{ marginBottom: 16, borderColor: "#D96B6B40" }}><span style={{ color: "#D96B6B", fontSize: 13 }}>{error}</span></Card>}

      {view === "report" && !report && !loading && (
        <Card><Empty icon="🧠" text="Отчёта ещё нет. Нажми «Сгенерировать отчёт» — система соберёт виннеров, бивариат, семьи и конкурентов в единый разбор." /></Card>
      )}

      {view === "report" && report && kpi && visual && (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {/* Проверка отчёта двумя моделями — показываем всегда */}
          <VerificationCard v={verifications} />

          {blocked ? (
            <Card style={{ borderColor: "#D96B6B55", background: "#D96B6B0A" }}>
              <div style={{ fontWeight: 700, color: "#D96B6B", fontSize: 14, marginBottom: 6 }}>⚠️ Проверка не пройдена — данным доверять нельзя</div>
              <div style={{ fontSize: 12, color: "#BBB", lineHeight: 1.6, marginBottom: 12 }}>
                Минимум одна модель нашла серьёзные несоответствия в числах или выводах (детали в блоке «Проверка» выше). Виннеры и метрики скрыты, чтобы не принять решение на кривых данных. Перегенерируй отчёт или проверь источник данных.
              </div>
              <Button size="sm" variant="ghost" onClick={() => setOverride(true)}>Показать отчёт всё равно</Button>
            </Card>
          ) : (<>
          {/* KPI */}
          <Card>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 18 }}>
              <Badge color={h.c}>пакет: {h.t}</Badge>
              <span style={{ fontSize: 11, color: "#555" }}>сгенерирован {new Date(report.createdAt ?? (report as unknown as { created_at?: string }).created_at ?? Date.now()).toLocaleString("ru-RU")}</span>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 12 }}>
              <Stat label="виннеры" value={kpi.winners} color="#6EC8A0" />
              <Stat label="fake" value={kpi.fakeWinners} color="#FF8B5A" />
              <Stat label="лузеры" value={kpi.losers} color="#D96B6B" />
              <Stat label="в тесте" value={kpi.testing} color="#888" />
              <Stat label="blended CPL" value={eur(kpi.blendedCpl)} color={cplColor(kpi.blendedCpl)} />
              <Stat label="blended CPQL" value={eur(kpi.blendedCpql)} color={cplColor(kpi.blendedCpql)} />
              <Stat label="спенд" value={`€${kpi.totalSpend.toFixed(0)}`} color="#E2E0DB" />
            </div>
          </Card>

          {/* HELPS / HURTS */}
          <Card>
            <SectionTitle icon="🎯" color="#6EC8A0">Какие формулировки помогают и мешают</SectionTitle>
            <div style={{ fontSize: 11, color: "#777", marginBottom: 10 }}>Каждая строка — одна уникальная дословная формулировка со своим кодом. CPL крео с ней против CPL всех остальных крео массива; ×N — отношение. Формулировка с 1–2 крео — слабый сигнал: повтори её в новых крео, чтобы измерить.</div>
            <div style={{ fontSize: 11, color: "#6EC8A0", marginBottom: 8, fontWeight: 700 }}>HELPS — снижают CPL</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 16 }}>
              {visual.helps.length ? visual.helps.map(s => <Chip key={s.code} s={s} helps paramInfo={paramInfo} />) : <span style={{ color: "#555", fontSize: 12 }}>—</span>}
            </div>
            <div style={{ fontSize: 11, color: "#D96B6B", marginBottom: 8, fontWeight: 700 }}>HURTS — повышают CPL</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {visual.hurts.length ? visual.hurts.map(s => <Chip key={s.code} s={s} helps={false} paramInfo={paramInfo} />) : <span style={{ color: "#555", fontSize: 12 }}>—</span>}
            </div>
          </Card>

          {/* Hook rate — что цепляет (видео) */}
          {((visual.hookHelps?.length ?? 0) > 0 || (visual.hookHurts?.length ?? 0) > 0) && (
            <Card>
              <SectionTitle icon="🎬" color="#48B8D0">Hook rate — что цепляет (видео: 3-сек просмотры / показы)</SectionTitle>
              {/* Легенда-шкала */}
              <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginBottom: 14 }}>
                {HOOK_BANDS.map(([label, color, range]) => (
                  <span key={label} style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 10, color: "#999" }}>
                    <span style={{ width: 9, height: 9, borderRadius: 2, background: color }} /> {label} <span style={{ color: "#555" }}>{range}</span>
                  </span>
                ))}
              </div>
              <div style={{ fontSize: 11, color: "#48B8D0", marginBottom: 8, fontWeight: 700 }}>ЦЕПЛЯЮТ — выше hook rate (×N vs остальные)</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 16 }}>
                {visual.hookHelps?.length ? visual.hookHelps.map(h => <HookChip key={h.code} h={h} paramInfo={paramInfo} />) : <span style={{ color: "#555", fontSize: 12 }}>—</span>}
              </div>
              <div style={{ fontSize: 11, color: "#D96B6B", marginBottom: 8, fontWeight: 700 }}>НЕ ЦЕПЛЯЮТ — ниже hook rate</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                {visual.hookHurts?.length ? visual.hookHurts.map(h => <HookChip key={h.code} h={h} paramInfo={paramInfo} />) : <span style={{ color: "#555", fontSize: 12 }}>—</span>}
              </div>
              <p style={{ fontSize: 11, color: "#666", marginTop: 12, lineHeight: 1.5 }}>Цвет = абсолютный уровень по шкале, ×N = относительно остальных хуков. Hook rate и CPL — <b style={{ color: "#888" }}>разные оси</b>: код может цеплять, но давать дорогой лид (тогда чинить боди/оффер, не хук). Метрика видео-крео.</p>
            </Card>
          )}

          {/* Семьи + комбо */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
            <Card>
              <SectionTitle icon="🧬" color="#48B8D0">Семьи (1 свап решает)</SectionTitle>
              {visual.families.length ? visual.families.map((f: ReportFamily, i) => (
                <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: "7px 0", borderBottom: i < visual.families.length - 1 ? "1px solid rgba(255,255,255,0.05)" : "none", fontSize: 12 }}>
                  <span style={{ color: "#AAA" }}><b style={{ color: PARAM_COLOR[f.varyingParam] ?? "#888" }}>{f.varyingParam}</b> @ {f.shared.split(" ").filter(Boolean).map((cd, j, arr) => <span key={j}><CodeTag code={cd} info={paramInfo[cd]} />{j < arr.length - 1 ? " " : ""}</span>)}</span>
                  <span><span style={{ color: "#6EC8A0" }}>{eur(f.bestCpl)}</span> ↔ <span style={{ color: "#D96B6B" }}>{eur(f.worstCpl)}</span></span>
                </div>
              )) : <Empty text="Семей недостаточно" />}
            </Card>
            <Card>
              <SectionTitle icon="🔗" color="#C490D1">Топ-комбо (виннеры)</SectionTitle>
              {visual.combos.length ? visual.combos.map((c: ReportCombo, i) => (
                <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: "7px 0", borderBottom: i < visual.combos.length - 1 ? "1px solid rgba(255,255,255,0.05)" : "none", fontSize: 12 }}>
                  <span style={{ fontFamily: "monospace", color: "#CCC" }}>{c.codes.split(" + ").map((cd, j, arr) => <span key={j}><CodeTag code={cd} info={paramInfo[cd]} />{j < arr.length - 1 ? " + " : ""}</span>)}</span>
                  <span><Badge color="#6EC8A0">{c.winners}W</Badge> <span style={{ color: cplColor(c.cpl), marginLeft: 6 }}>{eur(c.cpl)}</span></span>
                </div>
              )) : <Empty text="Виннер-комбо нет" />}
            </Card>
          </div>

          {/* Конкуренты */}
          {visual.competitors.length > 0 && (
            <Card>
              <SectionTitle icon="🧩" color="#FF8B5A">Конкуренты (одобренные)</SectionTitle>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {visual.competitors.map((c: ReportCompetitor, i) => (
                  <div key={i} style={{ fontSize: 12, color: "#BBB" }}>
                    {c.type && <Badge color="#FF8B5A">{c.type}</Badge>} <b style={{ color: "#DDD" }}>{c.title}</b>
                    {c.hook && <span style={{ color: "#888" }}> — {c.hook}</span>}
                  </div>
                ))}
              </div>
            </Card>
          )}

          {/* Нарратив */}
          <Card>
            <SectionTitle icon="📝" color="#E8AA42">Разбор и рекомендации</SectionTitle>
            <MarkdownBlock text={report.narrative} />
          </Card>

          {/* Следующий пак — дизайн эксперимента на этом отчёте: гейт человека → брифы → ТЗ */}
          {product !== "all" && report.id && <NextPack product={product} reportId={report.id} />}
          {product === "all" && <Card><div style={{ fontSize: 12, color: "#888" }}>Чтобы собрать следующий пак из этого отчёта, выбери продукт (Бухгалтер или Медадмин) в сайдбаре — формулировки привязаны к продукту.</div></Card>}
          </>)}

          {/* История */}
          {history.length > 1 && (
            <Card>
              <SectionTitle icon="🕘" color="#888">История отчётов</SectionTitle>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                {history.map(snap => (
                  <Button key={snap.id} size="sm" variant={snap.id === report.id ? "primary" : "ghost"} onClick={() => loadSnapshot(snap.id)}>
                    {new Date(snap.created_at).toLocaleDateString("ru-RU")} {new Date(snap.created_at).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}
                    {snap.date_from && snap.date_to ? ` · ${periodLabel(snap)}` : " · весь период"}
                  </Button>
                ))}
              </div>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}
