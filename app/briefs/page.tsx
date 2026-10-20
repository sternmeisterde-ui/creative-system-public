"use client";
import { useEffect, useRef, useState, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { formulationStore, sessionStore, briefStore, ruleStore } from "@/lib/store";
import type { Brief, BriefStatus, ConstructorSession } from "@/lib/types";
import type { Axis } from "@/lib/formulations";

type FormInfo = { code: string; text: string; axis: Axis };
const AXIS_META: Array<{ axis: Axis; label: string; color: string; key: "personaId" | "hookId" | "bodyId" | "angleId" }> = [
  { axis: "persona", label: "Персона", color: "#48B8D0", key: "personaId" },
  { axis: "hook", label: "Хук", color: "#C490D1", key: "hookId" },
  { axis: "body", label: "Боди", color: "#6EC8A0", key: "bodyId" },
  { axis: "angle", label: "Энгл", color: "#FF8B5A", key: "angleId" },
];

// Формулировки брифа дословно + правка. Правка текста = НОВАЯ формулировка с новым кодом (решение 11.10.2026):
// родитель в библиотеке не меняется, бриф и слот пака переводятся на новый код, в full_brief текст подменяется.
function FormulationEditor({ brief, forms, onDone }: { brief: Brief; forms: Record<string, FormInfo>; onDone: () => Promise<void> }) {
  const [editing, setEditing] = useState<Axis | null>(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const save = async (axis: Axis) => {
    setSaving(true); setMsg(null);
    try {
      const r = await fetch("/api/briefs/reformulate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ briefId: brief.id, axis, text: draft }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      setMsg(`${j.from.code} → ${j.to.code}${j.created ? " (новая формулировка)" : " (такой текст уже был в библиотеке)"}; бриф и слот пака переведены на новый код`);
      setEditing(null);
      await onDone();
    } catch (e) { setMsg(`Ошибка: ${e instanceof Error ? e.message : String(e)}`); }
    finally { setSaving(false); }
  };
  return (
    <div style={{ marginBottom: 10, padding: "8px 12px", background: "rgba(232,170,66,0.03)", border: "1px solid rgba(232,170,66,0.15)", borderRadius: 8 }}>
      <div style={{ fontSize: 9, fontWeight: 700, color: "#E8AA42", textTransform: "uppercase", letterSpacing: 1.5, marginBottom: 6 }}>
        Формулировки дословно · правка текста = новая формулировка с новым кодом
      </div>
      {AXIS_META.map(m => {
        const id = brief[m.key]; const f = id ? forms[id] : undefined;
        if (!f) return null;
        const isEd = editing === m.axis;
        return (
          <div key={m.axis} style={{ display: "grid", gridTemplateColumns: "64px 90px 1fr auto", gap: 8, alignItems: "start", padding: "5px 0", borderTop: "1px solid rgba(255,255,255,0.04)" }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: m.color }}>{m.label}</div>
            <div style={{ fontSize: 10, fontFamily: "monospace", color: "#888" }}>{f.code}</div>
            {isEd ? (
              <textarea value={draft} onChange={e => setDraft(e.target.value)} style={{ minHeight: 72, fontSize: 12 }} />
            ) : (
              <div style={{ fontSize: 12, color: "#BBB", lineHeight: 1.5, whiteSpace: "pre-wrap" }}>{f.text}</div>
            )}
            <div style={{ display: "flex", gap: 4 }}>
              {isEd ? (
                <>
                  <Button size="sm" variant="primary" onClick={() => save(m.axis)} disabled={saving || draft.trim() === f.text.trim()}>{saving ? "…" : "Сохранить как новую"}</Button>
                  <Button size="sm" onClick={() => setEditing(null)} disabled={saving}>Отмена</Button>
                </>
              ) : (
                <Button size="sm" onClick={() => { setEditing(m.axis); setDraft(f.text); setMsg(null); }}>✎</Button>
              )}
            </div>
          </div>
        );
      })}
      {msg && <div style={{ fontSize: 11, color: msg.startsWith("Ошибка") ? "#D96B6B" : "#6EC8A0", marginTop: 6 }}>{msg}</div>}
    </div>
  );
}
import { Card, PageHeader, Button, Badge, Empty, SectionTitle, Label } from "@/components/ui";
import Link from "next/link";
import { TEXT_TO_IMAGE_MODELS, TEXT_TO_VIDEO_MODELS, DEFAULT_STATIC_MODEL, DEFAULT_VIDEO_MODEL } from "@/lib/higgsfield-models";


const STATUS_COLOR: Record<BriefStatus, string> = {
  pending: "#555",
  approved: "#6EC8A0",
  needs_revision: "#E8AA42",
};
const STATUS_LABEL: Record<BriefStatus, string> = {
  pending: "Ожидает",
  approved: "Одобрен",
  needs_revision: "На доработке",
};

// ── Рендер тела секции брифа: markdown-таблицы (паспорт, сценарий с таймкодами), **жирный**, списки ──
function inlineMd(text: string): React.ReactNode[] {
  return text.split(/\*\*(.*?)\*\*/g).map((p, i) => (i % 2 === 1 ? <strong key={i} style={{ color: "#EEE" }}>{p}</strong> : p));
}
function BriefBody({ text }: { text: string }) {
  const lines = text.split("\n");
  const out: React.ReactNode[] = [];
  let i = 0;
  const isRow = (l: string) => /^\s*\|.*\|\s*$/.test(l);
  const isSep = (l: string) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);
  while (i < lines.length) {
    const line = lines[i];
    if (isRow(line)) {
      const rows: string[][] = [];
      while (i < lines.length && isRow(lines[i])) {
        if (!isSep(lines[i])) rows.push(lines[i].trim().replace(/^\||\|$/g, "").split("|").map(c => c.trim()));
        i++;
      }
      if (rows.length) {
        const [head, ...body] = rows;
        const isScript = /^\d{1,2}:\d{2}/.test(body[0]?.[0] ?? "");
        out.push(
          <table key={`t${i}`} style={{ width: "100%", borderCollapse: "collapse", margin: "4px 0 10px", fontSize: 12 }}>
            <thead><tr>{head.map((h, j) => <th key={j} style={{ textAlign: "left", padding: "4px 8px", fontSize: 9.5, color: "#666", textTransform: "uppercase", letterSpacing: 0.6, borderBottom: "1px solid rgba(255,255,255,0.08)", whiteSpace: "nowrap" }}>{h}</th>)}</tr></thead>
            <tbody>{body.map((r, ri) => (
              <tr key={ri} style={{ borderBottom: "1px solid rgba(255,255,255,0.04)" }}>
                {r.map((c, j) => (
                  <td key={j} style={{ padding: "6px 8px", verticalAlign: "top", lineHeight: 1.55,
                    color: isScript && j === 1 ? "#E6E6E6" : j === 0 ? "#888" : "#AAA",
                    fontFamily: isScript && j === 0 ? "monospace" : undefined, whiteSpace: isScript && j === 0 ? "nowrap" : "pre-wrap",
                    fontWeight: isScript && j === 1 ? 500 : 400, width: isScript && j === 0 ? 70 : undefined }}>
                    {inlineMd(c)}
                  </td>
                ))}
              </tr>
            ))}</tbody>
          </table>,
        );
      }
      continue;
    }
    if (/^\s*[-•*]\s+/.test(line)) { out.push(<div key={i} style={{ paddingLeft: 14, color: "#BBB" }}>• {inlineMd(line.replace(/^\s*[-•*]\s+/, ""))}</div>); i++; continue; }
    if (/^###?\s+/.test(line)) { out.push(<div key={i} style={{ fontWeight: 700, color: "#DDD", marginTop: 8 }}>{line.replace(/^#+\s*/, "")}</div>); i++; continue; }
    if (line.trim() === "") { out.push(<div key={i} style={{ height: 6 }} />); i++; continue; }
    out.push(<div key={i} style={{ whiteSpace: "pre-wrap" }}>{inlineMd(line)}</div>); i++;
  }
  return <>{out}</>;
}

// ── Brief Card ─────────────────────────────────────────────────────────────────

type GenStatus = "idle" | "queued" | "processing" | "done" | "error";
type SeriesStatus = "idle" | "extracting" | "generating" | "done" | "error";

function GenerateButton({ brief, personaName }: { brief: Brief; personaName: string }) {
  const isStatic = brief.format === "static";
  const modelOptions = isStatic ? TEXT_TO_IMAGE_MODELS : TEXT_TO_VIDEO_MODELS;
  const defaultSlug = isStatic ? DEFAULT_STATIC_MODEL : DEFAULT_VIDEO_MODEL;

  const [status, setStatus] = useState<GenStatus>("idle");
  const [resultUrl, setResultUrl] = useState<string | null>(null);
  const [usedModel, setUsedModel] = useState<string>("");
  const [selectedSlug, setSelectedSlug] = useState<string>(defaultSlug);
  const [errorMsg, setErrorMsg] = useState<string>("");

  // Series state (video only)
  const [seriesStatus, setSeriesStatus] = useState<SeriesStatus>("idle");
  const [seriesSceneCount, setSeriesSceneCount] = useState(0);
  const [seriesDone, setSeriesDone] = useState(0);
  const [seriesGroupId, setSeriesGroupId] = useState<string | null>(null);
  const [seriesError, setSeriesError] = useState("");

  const generate = async () => {
    setStatus("queued");
    setErrorMsg("");
    try {
      const res = await fetch("/api/creative-gen/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ briefId: brief.id, personaName, modelSlug: selectedSlug }),
      });
      const data = await res.json();
      if (!data.ok) { setStatus("error"); setErrorMsg(data.error ?? "Ошибка"); return; }
      setUsedModel(data.model);
      setStatus("processing");

      const genId = data.generationId;
      const poll = setInterval(async () => {
        const r = await fetch(`/api/creative-gen/status?id=${genId}`);
        const d = await r.json();
        const g = d.generation;
        if (g.status === "done") {
          clearInterval(poll);
          setResultUrl(g.result_url);
          setStatus("done");
        } else if (g.status === "error") {
          clearInterval(poll);
          setErrorMsg(g.error_message ?? "Ошибка генерации");
          setStatus("error");
        }
      }, 3000);
    } catch (e) {
      setStatus("error");
      setErrorMsg(String(e));
    }
  };

  const generateSeries = async () => {
    setSeriesStatus("extracting");
    setSeriesError("");
    setSeriesDone(0);
    setSeriesSceneCount(0);
    try {
      const res = await fetch("/api/creative-gen/generate-scenes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ briefId: brief.id, personaName, modelSlug: selectedSlug }),
      });
      const data = await res.json();
      if (!data.ok) { setSeriesStatus("error"); setSeriesError(data.error ?? "Ошибка"); return; }

      setSeriesGroupId(data.sceneGroupId);
      setSeriesSceneCount(data.sceneCount);
      setSeriesStatus("generating");

      // Poll scene group status
      const poll = setInterval(async () => {
        const r = await fetch(`/api/creative-gen/scene-group-status?id=${data.sceneGroupId}`);
        const d = await r.json();
        if (!d.ok) return;
        setSeriesDone(d.group.scenes_done ?? 0);
        if (d.group.status !== "generating") {
          clearInterval(poll);
          setSeriesStatus(d.group.status === "done" ? "done" : "error");
        }
      }, 5000);
    } catch (e) {
      setSeriesStatus("error");
      setSeriesError(String(e));
    }
  };

  if (status === "done" && resultUrl) {
    return (
      <div style={{ marginTop: 8 }}>
        {isStatic ? (
          <img src={resultUrl} alt="Generated" style={{ width: "100%", maxWidth: 320, borderRadius: 8, border: "1px solid rgba(110,200,160,0.3)" }} />
        ) : (
          <video src={resultUrl} controls style={{ width: "100%", maxWidth: 320, borderRadius: 8 }} />
        )}
        <div style={{ fontSize: 10, color: "#555", marginTop: 4 }}>Модель: {usedModel}</div>
        <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
          <Button size="sm" onClick={() => window.open(resultUrl, "_blank")}>⬇ Скачать</Button>
          <Button size="sm" onClick={() => { setStatus("idle"); setResultUrl(null); }}
            style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.1)" }}>
            ↩ Новая
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ marginTop: 4 }}>
      {(status === "idle" || status === "error") && (
        <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          <select
            value={selectedSlug}
            onChange={e => setSelectedSlug(e.target.value)}
            style={{
              background: "#1a1a1a", border: "1px solid rgba(255,255,255,0.12)",
              color: "#ccc", borderRadius: 6, padding: "3px 8px", fontSize: 11, cursor: "pointer",
            }}
          >
            {modelOptions.map(m => (
              <option key={m.slug} value={m.slug}>{m.label}</option>
            ))}
          </select>
          <Button size="sm" onClick={generate}
            style={{ background: "rgba(232,170,66,0.08)", border: "1px solid rgba(232,170,66,0.25)", color: "#E8AA42" }}>
            {isStatic ? "Статика" : "Кадр"}
          </Button>
          {!isStatic && (
            <Button size="sm" onClick={generateSeries}
              style={{ background: "rgba(72,184,208,0.08)", border: "1px solid rgba(72,184,208,0.25)", color: "#48B8D0" }}>
              Серия сцен
            </Button>
          )}
        </div>
      )}
      {status === "error" && (
        <div style={{ fontSize: 11, color: "#D96B6B", marginTop: 4 }}>✕ {errorMsg}</div>
      )}
      {status === "queued" && <div style={{ fontSize: 11, color: "#E8AA42", marginTop: 4 }}>⏳ Отправляем запрос...</div>}
      {status === "processing" && (
        <div style={{ fontSize: 11, color: "#48B8D0", marginTop: 4 }}>
          Генерируется... ({usedModel})
        </div>
      )}

      {/* Series status */}
      {seriesStatus === "extracting" && (
        <div style={{ fontSize: 11, color: "#48B8D0", marginTop: 6 }}>
          Извлекаем сцены из брифа...
        </div>
      )}
      {seriesStatus === "generating" && (
        <div style={{ marginTop: 6 }}>
          <div style={{ fontSize: 11, color: "#48B8D0", marginBottom: 4 }}>
            Генерируется серия: {seriesDone}/{seriesSceneCount} сцен готово
          </div>
          <div style={{ height: 4, background: "rgba(255,255,255,0.06)", borderRadius: 2 }}>
            <div style={{
              height: "100%", borderRadius: 2, background: "#48B8D0", transition: "width 0.5s",
              width: seriesSceneCount > 0 ? `${Math.round(seriesDone / seriesSceneCount * 100)}%` : "0%",
            }} />
          </div>
        </div>
      )}
      {seriesStatus === "done" && seriesGroupId && (
        <div style={{ fontSize: 11, color: "#6EC8A0", marginTop: 6 }}>
          Серия готова — {seriesDone}/{seriesSceneCount} сцен. Смотри в разделе Крео.
          <Button size="sm" onClick={() => setSeriesStatus("idle")}
            style={{ marginLeft: 8, background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.1)" }}>
            ↩ Новая
          </Button>
        </div>
      )}
      {seriesStatus === "error" && (
        <div style={{ fontSize: 11, color: "#D96B6B", marginTop: 6 }}>
          Ошибка серии: {seriesError}
          <Button size="sm" onClick={() => setSeriesStatus("idle")}
            style={{ marginLeft: 8 }}>↩ Сброс</Button>
        </div>
      )}
    </div>
  );
}

function BriefCard({
  brief, index, personas, hooks, bodies, angles, forms, onReformulated,
  onApprove, onRevision, busy,
}: {
  brief: Brief; index: number;
  personas: Record<string, string>; hooks: Record<string, string>;
  bodies: Record<string, string>; angles: Record<string, string>;
  forms: Record<string, FormInfo>; onReformulated: () => Promise<void>;
  onApprove: (id: string) => void;
  onRevision: (id: string) => void;
  busy: boolean;
}) {
  const [expanded, setExpanded] = useState(true);
  const status = brief.status ?? "pending";

  return (
    <Card style={{
      border: status === "approved"
        ? "1px solid rgba(110,200,160,0.25)"
        : status === "needs_revision"
        ? "1px solid rgba(232,170,66,0.25)"
        : "1px solid rgba(255,255,255,0.06)",
      background: status === "approved"
        ? "rgba(110,200,160,0.04)"
        : status === "needs_revision"
        ? "rgba(232,170,66,0.04)"
        : undefined,
    }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: "#444", fontFamily: "monospace", width: 28, flexShrink: 0, paddingTop: 2 }}>
          #{index + 1}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
            <Badge color="#48B8D0">{(brief.personaId && personas[brief.personaId]) || "без персоны"}</Badge>
            <Badge color="#C490D1">{hooks[brief.hookId] || "?"}</Badge>
            <Badge color="#6EC8A0">{bodies[brief.bodyId] || "?"}</Badge>
            <Badge color="#FF8B5A">{angles[brief.angleId] || "?"}</Badge>
            <Badge color="#E8AA42">{(brief.format || "video").toUpperCase()}</Badge>
            <Badge color={STATUS_COLOR[status]}>{STATUS_LABEL[status]}</Badge>
          </div>

          {/* Формулировки дословно + правка (= новая формулировка) */}
          {expanded && <FormulationEditor brief={brief} forms={forms} onDone={onReformulated} />}

          {/* Full brief — parsed sections */}
          {expanded && brief.fullBrief && (() => {
            const raw = brief.fullBrief;
            // Split by --- separator into sections
            const parts = raw.split(/\n---\n/).map(s => s.trim());
            const sections = parts.map(part => {
              const headerMatch = part.match(/^##\s+(.+)\n/);
              return {
                title: headerMatch ? headerMatch[1] : null,
                body: headerMatch ? part.slice(headerMatch[0].length).trim() : part,
              };
            });

            // If no sections found, render as plain text (old briefs)
            if (sections.length <= 1 && !sections[0]?.title) {
              return (
                <div style={{ padding: "12px 16px", background: "rgba(255,255,255,0.02)", borderRadius: 8, fontSize: 12, color: "#999", lineHeight: 1.7, whiteSpace: "pre-wrap", maxHeight: 320, overflowY: "auto" }}>
                  {raw}
                </div>
              );
            }

            const SECTION_STYLE: Record<string, { color: string; bg: string; border: string }> = {
              "ПАСПОРТ":             { color: "#AAA",    bg: "rgba(255,255,255,0.02)",  border: "rgba(255,255,255,0.1)"  },
              "ПАРАМЕТРЫ В РОЛИКЕ":  { color: "#E8AA42", bg: "rgba(232,170,66,0.04)",  border: "rgba(232,170,66,0.2)"  },
              "ХУК":                 { color: "#C490D1", bg: "rgba(196,144,209,0.04)", border: "rgba(196,144,209,0.2)" },
              "ПОДАЧА ДЛЯ ДИКТОРА":  { color: "#48B8D0", bg: "rgba(72,184,208,0.04)",  border: "rgba(72,184,208,0.2)"  },
              "ПРОВЕРКА РЕЧИ (ЛИНТЕР КОРПУСА RU-REELS)": { color: "#6EC8A0", bg: "rgba(110,200,160,0.04)", border: "rgba(110,200,160,0.2)" },
              "СЦЕНАРИЙ":            { color: "#C490D1", bg: "rgba(196,144,209,0.04)", border: "rgba(196,144,209,0.2)" },
              "ПОКАДРОВЫЙ ПЛАН":     { color: "#48B8D0", bg: "rgba(72,184,208,0.04)",  border: "rgba(72,184,208,0.2)"  },
              "ТЗ НА МОНТАЖ":        { color: "#E8AA42", bg: "rgba(232,170,66,0.04)",  border: "rgba(232,170,66,0.2)"  },
              "ПРОМПТ ДЛЯ HIGGSFIELD": { color: "#6EC8A0", bg: "rgba(110,200,160,0.04)", border: "rgba(110,200,160,0.2)" },
              "ОПИСАНИЕ БАННЕРА":    { color: "#C490D1", bg: "rgba(196,144,209,0.04)", border: "rgba(196,144,209,0.2)" },
              "ТЗ НА ДИЗАЙН":        { color: "#E8AA42", bg: "rgba(232,170,66,0.04)",  border: "rgba(232,170,66,0.2)"  },
            };

            return (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {sections.map((sec, si) => {
                  const key = sec.title?.toUpperCase() ?? "";
                  const style = SECTION_STYLE[key] ?? { color: "#777", bg: "rgba(255,255,255,0.02)", border: "rgba(255,255,255,0.08)" };
                  return (
                    <div key={si} style={{ borderRadius: 8, background: style.bg, border: `1px solid ${style.border}`, overflow: "hidden" }}>
                      {sec.title && (
                        <div style={{ fontSize: 9, fontWeight: 700, color: style.color, textTransform: "uppercase", letterSpacing: 1.5, padding: "6px 12px", borderBottom: `1px solid ${style.border}` }}>
                          {sec.title}
                        </div>
                      )}
                      <div style={{ padding: "10px 12px", fontSize: 12, color: "#AAA", lineHeight: 1.7, maxHeight: key === "СЦЕНАРИЙ" ? 720 : 420, overflowY: "auto" }}>
                        <BriefBody text={sec.body} />
                      </div>
                    </div>
                  );
                })}
              </div>
            );
          })()}

          {/* Revision note */}
          {brief.revisionNote && (
            <div style={{ marginTop: 8, padding: "8px 12px", background: "rgba(232,170,66,0.08)", borderRadius: 8, fontSize: 11, color: "#E8AA42", borderLeft: "2px solid rgba(232,170,66,0.4)" }}>
              💬 {brief.revisionNote}
            </div>
          )}

          {/* Generate creative */}
          {status === "approved" && expanded && (
            <GenerateButton brief={brief} personaName={(brief.personaId && personas[brief.personaId]) || ""} />
          )}
        </div>

        {/* Actions — только collapse, без approval gate */}
        <div style={{ display: "flex", flexDirection: "column", gap: 6, flexShrink: 0 }}>
          <Button size="sm" onClick={() => setExpanded(!expanded)}>
            {expanded ? "Свернуть" : "Открыть"}
          </Button>
          <a href={`/api/briefs/docx?id=${brief.id}`} target="_blank" rel="noreferrer" title="ТЗ с референсами для креатора"><Button size="sm">📄 DOCX</Button></a>
          <a href={`/api/briefs/gdoc?id=${brief.id}`} target="_blank" rel="noreferrer" title="Открыть ТЗ в Google Docs"><Button size="sm">📝 G Docs</Button></a>
        </div>
      </div>
    </Card>
  );
}

// ── Revision Modal ─────────────────────────────────────────────────────────────

function RevisionModal({ onConfirm, onCancel }: { onConfirm: (note: string) => void; onCancel: () => void }) {
  const [note, setNote] = useState("");
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 200 }}>
      <div style={{ background: "#12141A", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 16, padding: 28, width: 480 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: "#DDD", marginBottom: 16 }}>Комментарий к правкам</div>
        <Label>Что нужно изменить?</Label>
        <textarea
          value={note}
          onChange={e => setNote(e.target.value)}
          placeholder="Например: усилить боль, сменить тон, добавить конкретики..."
          style={{ minHeight: 100, marginBottom: 16 }}
          autoFocus
        />
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <Button onClick={onCancel}>Отмена</Button>
          <Button variant="primary" onClick={() => onConfirm(note)}>Отправить на доработку</Button>
        </div>
      </div>
    </div>
  );
}

// ── Main Content ───────────────────────────────────────────────────────────────

function BriefsContent() {
  const searchParams = useSearchParams();
  const sessionId = searchParams.get("session");

  const [session, setSession] = useState<ConstructorSession | null>(null);
  const [sessions, setSessions] = useState<ConstructorSession[]>([]);
  const [briefs, setBriefs] = useState<Brief[]>([]);
  const [generating, setGenerating] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [revisionFor, setRevisionFor] = useState<string | null>(null);
  const [published, setPublished] = useState<{ adName: string }[]>([]);

  const [personas, setPersonas] = useState<Record<string, string>>({});
  const [hooks, setHooks] = useState<Record<string, string>>({});
  const [bodies, setBodies] = useState<Record<string, string>>({});
  const [angles, setAngles] = useState<Record<string, string>>({});
  const [forms, setForms] = useState<Record<string, FormInfo>>({});

  useEffect(() => {
    const load = async () => {
      if (!sessionId) {
        setSessions((await sessionStore.getAll()).reverse());
        return;
      }
      const allSessions = await sessionStore.getAll();
      const s = allSessions.find(x => x.id === sessionId);
      if (!s) return;
      setSession(s);

      // Параметры = формулировки: подпись = код + начало дословного текста
      await loadForms();

      const existingBriefs = await briefStore.getBySession(sessionId);
      setBriefs(existingBriefs);
      // таймкоды параметров доноров/референсов — в кеш заранее, чтобы ТЗ (DOCX / Google Doc) открывалось сразу и с фрагментами
      if (existingBriefs.length) fetch("/api/briefs/timings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionId }) }).catch(() => undefined);

      // AUTO-TRIGGER: если сессия пакетная и брифов ещё нет — стартуем генерацию сразу.
      // Никакой кнопки «генерировать», система делает всё сама.
      const isPack = !!(s as ConstructorSession).packMetadata;
      if (isPack && existingBriefs.length === 0 && !generating) {
        // Не дёргаем напрямую — небольшая задержка чтобы UI отрисовался
        setTimeout(() => { autoTriggerRef.current = true; }, 100);
      }
    };
    load();
  }, [sessionId]);

  // Карты формулировок: подпись (код + начало текста) для бейджей и полный текст для блока правки
  const loadForms = async () => {
    const all = await formulationStore.getAll();
    const pMap: Record<string, string> = {}, hMap: Record<string, string> = {}, bMap: Record<string, string> = {}, aMap: Record<string, string> = {};
    const fMap: Record<string, FormInfo> = {};
    for (const f of all) {
      const label = `${f.code} · ${f.text.length > 70 ? f.text.slice(0, 69) + "…" : f.text}`;
      ({ persona: pMap, hook: hMap, body: bMap, angle: aMap })[f.axis][f.id] = label;
      fMap[f.id] = { code: f.code, text: f.text, axis: f.axis };
    }
    setPersonas(pMap); setHooks(hMap); setBodies(bMap); setAngles(aMap); setForms(fMap);
  };
  // После правки формулировки: новая запись в библиотеке + бриф и слот на новом коде → перечитать обе
  const reloadAfterReformulate = async () => {
    await loadForms();
    if (sessionId) {
      setBriefs(await briefStore.getBySession(sessionId));
      const s = (await sessionStore.getAll()).find(x => x.id === sessionId);
      if (s) setSession(s);
    }
  };

  // Ref-флаг для автостарта (избегаем гонок React strict mode)
  const autoTriggerRef = useRef(false);
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [pipelineStatus, setPipelineStatus] = useState<string | null>(null);

  // Polling /api/pack/auto-advance — двигает все in-progress scene_groups
  // через стадии Kling→voice→lipsync→stitch. Останавливается когда idle.
  const startPipelinePolling = () => {
    if (pollingRef.current) return;
    setPipelineStatus("Pipeline запущен — Kling/voice/lipsync/stitch в работе");
    const tick = async () => {
      try {
        const r = await fetch("/api/pack/auto-advance", { method: "POST" });
        const d = await r.json();
        if (d.idle) {
          setPipelineStatus("✅ Pipeline завершён — все креативы готовы");
          if (pollingRef.current) { clearInterval(pollingRef.current); pollingRef.current = null; }
          return;
        }
        // Группы, ждущие локального ffmpeg-монтажа (MONTAGE_BACKEND=local).
        const montageWaiting = Array.isArray(d.actions)
          ? d.actions.filter((a: { action: string }) => a.action === "ready_montage" || a.action === "awaiting_montage").length
          : 0;
        setPipelineStatus(
          montageWaiting > 0
            ? `Pipeline: ${d.totalInProgress} в работе · ▶ ${montageWaiting} ждут локального монтажа — запусти \`npm run montage\``
            : `Pipeline: ${d.totalInProgress} в работе · advanced ${d.advanced} actions`,
        );
      } catch (e) {
        console.warn("[auto-advance] poll error:", e);
      }
    };
    tick();
    pollingRef.current = setInterval(tick, 30_000);
  };
  useEffect(() => () => {
    if (pollingRef.current) clearInterval(pollingRef.current);
  }, []);
  useEffect(() => {
    if (autoTriggerRef.current && session && !generating && briefs.length === 0) {
      autoTriggerRef.current = false;
      handleGenerate();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  // Генерация частями по 5 слотов: один бриф с линтер-правкой — до ~6 мин, функция Vercel живёт 800 с,
  // поэтому пак на 20 идёт четырьмя запросами подряд. mode "missing" — догенерировать только слоты без брифа.
  const generatingRef = useRef(false); // защита от двойного запуска (автостарт + клик, два эффекта)
  const handleGenerate = async (mode: "all" | "missing" = "all") => {
    if (!session || generatingRef.current) return;
    generatingRef.current = true;
    setGenerating(true);
    setError("");
    setProgress(0);
    if (mode === "all") { setBriefs([]); await briefStore.clearBySession(session.id); }

    try {
      const rules = await ruleStore.getAll();
      const slotIds = (session.packMetadata?.slots ?? []).map(s => s.slotId);
      const CHUNK = 5;
      const chunks: (number[] | null)[] = slotIds.length ? Array.from({ length: Math.ceil(slotIds.length / CHUNK) }, (_, i) => slotIds.slice(i * CHUNK, (i + 1) * CHUNK)) : [null];
      let doneBriefs = 0;
      const total = slotIds.length || 1;

      const chunkErrors: string[] = [];
      for (let ci = 0; ci < chunks.length; ci++) {
        const chunk = chunks[ci];
        setPipelineStatus(`Генерация брифов: часть ${ci + 1} из ${chunks.length}${chunk ? ` (слоты ${chunk[0]}–${chunk[chunk.length - 1]})` : ""}…`);
        try {
          const res = await fetch("/api/ai/generate-briefs", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ session, rules: rules.filter(r => r.active), slotIds: chunk ?? undefined, skipExisting: mode === "missing" || ci > 0 }),
          });
          if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);

          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";
            for (const line of lines) {
              if (!line.trim()) continue;
              let obj: Record<string, unknown>;
              try { obj = JSON.parse(line); } catch { chunkErrors.push(`часть ${ci + 1}: сервер прислал не JSON — ${line.slice(0, 120)}`); continue; }
              if (obj.__error) throw new Error(String(obj.__error));
              if (obj.__warning) { setError(prev => (prev ? prev + "\n" : "") + `⚠ ${obj.__warning}`); continue; }
              if ("__progress" in obj) continue; // прогресс считаем по брифам всего пака, а не по чанку
              const saved = await briefStore.saveMany([{ ...(obj as unknown as Omit<Brief, "id" | "createdAt" | "sessionId">), sessionId: session.id }]);
              setBriefs(prev => [...prev, ...saved]);
              doneBriefs++;
              setProgress(Math.min(99, Math.round((doneBriefs / total) * 100)));
            }
          }
        } catch (e) {
          // ошибка одной части не рвёт пак: идём к следующей, недостающее добирается кнопкой
          chunkErrors.push(`часть ${ci + 1}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      setProgress(100);
      setPipelineStatus(null);
      if (chunkErrors.length) setError(prev => (prev ? prev + "\n" : "") + `⚠ Не все части сгенерировались: ${chunkErrors.join("; ")}. Нажми «Догенерировать недостающие».`);
      // перечитываем из БД — состояние вкладки могло разойтись с базой (параллельный запуск, другая вкладка)
      setBriefs(await briefStore.getBySession(session.id));

      await sessionStore.update(session.id, { status: "done" });
      setSession(prev => prev ? { ...prev, status: "done" } : prev);

      // AUTO-PUBLISH: создаём creative-строки сразу после генерации.
      // Без ручного клика «Опубликовать» — у нас saveMany() уже пишет с status='approved'.
      try {
        const pubRes = await fetch("/api/briefs/publish", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId: session.id }),
        });
        const pubData = await pubRes.json();
        if (pubData.ok && pubData.creatives) {
          setPublished(pubData.creatives);
        }
      } catch { /* публикация некритична — пользователь видит брифы */ }

      // Производство Higgsfield НЕ запускается автоматически (решение 08.10.2026): брифы и ТЗ сначала смотрит человек,
      // производство — кнопкой «(Пере)запустить производство».
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      generatingRef.current = false;
      setGenerating(false);
      setProgress(100);
    }
  };

  const updateStatus = async (id: string, status: BriefStatus, note?: string) => {
    setBusy(true);
    await briefStore.updateStatus(id, status, note);
    setBriefs(prev => prev.map(b => b.id === id ? { ...b, status, revisionNote: note ?? b.revisionNote } : b));
    setBusy(false);
  };

  const handleApprove = async (id: string) => {
    // Auto-approve flow убрал кнопку, но handler оставлен для совместимости BriefCard.
    const b = briefs.find(x => x.id === id);
    await updateStatus(id, b?.status === "approved" ? "pending" : "approved");
  };

  const handleRevisionConfirm = async (note: string) => {
    if (!revisionFor) return;
    await updateStatus(revisionFor, "needs_revision", note);
    setRevisionFor(null);
  };

  // ── Session list view ──────────────────────────────────────────────────────

  if (!sessionId) {
    return (
      <div>
        <PageHeader title="Брифы" subtitle="Выберите сессию для просмотра брифов" />
        {sessions.length === 0 ? <Empty icon="⚡" text="Нет сессий. Создайте в Конструкторе." /> : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {sessions.map(s => (
              <Card key={s.id}>
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: "#DDD" }}>{s.name}</div>
                    <div style={{ fontSize: 11, color: "#555" }}>{s.totalCombinations} комбинаций · {s.format.toUpperCase()}</div>
                  </div>
                  <Badge color={s.status === "done" ? "#6EC8A0" : "#555"}>{s.status === "done" ? "Готово" : "Черновик"}</Badge>
                  <Link href={`/briefs?session=${s.id}`}><Button size="sm" variant="primary">Открыть →</Button></Link>
                </div>
              </Card>
            ))}
          </div>
        )}
      </div>
    );
  }

  // ── Brief view ─────────────────────────────────────────────────────────────

  return (
    <div>
      {revisionFor && (
        <RevisionModal
          onConfirm={handleRevisionConfirm}
          onCancel={() => setRevisionFor(null)}
        />
      )}

      <PageHeader
        title="Брифы"
        subtitle={session ? `${session.name} · ${session.totalCombinations} комбинаций` : ""}
        action={
          <div style={{ display: "flex", gap: 8 }}>
            <Link href="/builder"><Button>← Конструктор</Button></Link>
            {briefs.length > 0 && <a href={`/api/briefs/docx?sessionId=${session?.id ?? ""}`} target="_blank" rel="noreferrer"><Button>📄 ТЗ в DOCX (все {briefs.length})</Button></a>}
            {briefs.length > 0 && <a href={`/api/briefs/gdoc?sessionId=${session?.id ?? ""}`} target="_blank" rel="noreferrer" title="Собрать ТЗ и открыть в Google Docs (документ переиспользуется, ссылка постоянная)"><Button>📝 Google Docs (все)</Button></a>}
            {briefs.length > 0 && (session?.packMetadata?.slots?.length ?? 0) > briefs.length && !generating && (
              <span title="Сгенерировать только слоты, у которых ещё нет брифа"><Button onClick={() => handleGenerate("missing")}>➕ Догенерировать недостающие ({(session?.packMetadata?.slots?.length ?? 0) - briefs.length})</Button></span>
            )}
            <Button variant="primary" onClick={() => handleGenerate("all")} disabled={generating}>
              {generating ? `⏳ ${progress}%` : briefs.length > 0 ? "🔄 Перегенерировать" : "✨ Генерировать брифы"}
            </Button>
          </div>
        }
      />

      {/* Pre-generate card */}
      {briefs.length === 0 && !generating && (
        <Card style={{ background: "rgba(232,170,66,0.04)", border: "1px solid rgba(232,170,66,0.15)" }}>
          <div style={{ fontSize: 13, color: "#AAA", lineHeight: 1.7, marginBottom: 16 }}>
            В паке <strong style={{ color: "#E8AA42" }}>{session?.totalCombinations || 0}</strong> слотов — на каждый будет бриф.
            Генерация идёт частями по 5 слотов, брифы появляются по мере готовности.
          </div>
          <Button variant="primary" size="lg" onClick={() => handleGenerate("all")}>
            ✨ Генерировать брифы
          </Button>
          {error && <div style={{ marginTop: 10, fontSize: 12, color: "#D96B6B" }}>Ошибка: {error}</div>}
        </Card>
      )}

      {generating && (
        <Card style={{ background: "rgba(232,170,66,0.04)", border: "1px solid rgba(232,170,66,0.15)", marginBottom: 16 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            <div style={{ flex: 1, height: 6, background: "rgba(255,255,255,0.06)", borderRadius: 3 }}>
              <div style={{ height: "100%", width: `${progress}%`, background: "#E8AA42", borderRadius: 3, transition: "width 0.3s" }} />
            </div>
            <span style={{ fontSize: 12, color: "#E8AA42", fontWeight: 700, minWidth: 50 }}>{progress}%</span>
            <span style={{ fontSize: 12, color: "#555" }}>{briefs.length} брифов</span>
          </div>
        </Card>
      )}

      {briefs.length > 0 && (
        <>
          {/* Stats — компактно, без approve/revision */}
          <Card style={{ marginBottom: 20, background: "rgba(110,200,160,0.04)", border: "1px solid rgba(110,200,160,0.15)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
              <div style={{ fontSize: 28, fontWeight: 800, color: "#6EC8A0" }}>{briefs.length}</div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13, color: "#DDD", fontWeight: 700 }}>Брифов сгенерировано</div>
                <div style={{ fontSize: 11, color: "#666", marginTop: 2 }}>
                  {pipelineStatus ?? "Производство Higgsfield запускается вручную — кнопкой справа, после проверки брифов и ТЗ."}
                </div>
              </div>
              <Button
                onClick={async () => {
                  if (!sessionId) return;
                  setBusy(true);
                  try {
                    const r = await fetch("/api/pack/produce", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ sessionId }),
                    });
                    const d = await r.json();
                    if (!d.ok) { alert(`Ошибка: ${d.error ?? "unknown"}`); return; }
                    startPipelinePolling();
                    const left = d.deferred ?? 0;
                    setPipelineStatus(`В производстве: ${d.submitted} · ранее: ${d.alreadyDone} · отложено: ${left} из ${d.total}`);
                    if (d.errors?.length) {
                      alert(`Ушло ${d.submitted}/${d.total}, ошибок ${d.failed ?? d.errors.length}:\n${d.errors[0]}\n\nНажми «(Пере)запустить» — успешные не дублируются, повторятся только упавшие.`);
                    } else if (d.done) {
                      alert(`✅ Все ${d.total} крео в производстве. Следи в /creatives.`);
                    } else {
                      alert(`Ушло ${d.submitted}, отложено ${left} из ${d.total}.\n\nЭто видео-крео: лимит Higgsfield — 4 одновременных задачи. Нажми «(Пере)запустить производство» ещё раз, когда первые догенерятся — дубли НЕ создаются (идемпотентно). Статика так не упирается.`);
                    }
                  } finally {
                    setBusy(false);
                  }
                }}
                disabled={busy}
              >
                {busy ? "⏳ Запускаю..." : "🎬 (Пере)запустить производство"}
              </Button>
              <Link href={`/creatives?session=${sessionId}`}>
                <Button variant="primary">→ Готовые крео</Button>
              </Link>
            </div>
          </Card>

          {/* Flat list (без батчей + фильтров) */}
          <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 16 }}>
            {briefs.map((b, i) => (
              <BriefCard
                key={b.id}
                brief={b}
                index={i}
                personas={personas} hooks={hooks} bodies={bodies} angles={angles}
                forms={forms} onReformulated={reloadAfterReformulate}
                onApprove={handleApprove}
                onRevision={(id) => setRevisionFor(id)}
                busy={busy}
              />
            ))}
          </div>

          {/* Published result */}
          {published.length > 0 && (
            <div style={{ marginTop: 16, padding: "16px 20px", background: "rgba(110,200,160,0.06)", border: "1px solid rgba(110,200,160,0.2)", borderRadius: 12 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: "#6EC8A0", marginBottom: 12 }}>
                ✓ Создано {published.length} креативов в базе данных
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {published.map(c => (
                  <span key={c.adName} style={{ fontSize: 11, fontWeight: 700, fontFamily: "monospace", color: "#DDD", background: "rgba(255,255,255,0.06)", padding: "4px 10px", borderRadius: 6 }}>
                    {c.adName}
                  </span>
                ))}
              </div>
              <div style={{ fontSize: 11, color: "#555", marginTop: 10 }}>
                Теперь загрузите эти названия в Meta Ads Manager. Когда запустите рекламу — данные подтянутся автоматически при следующей синхронизации.
              </div>
            </div>
          )}
        </>
      )}

      {error && <div style={{ marginTop: 10, fontSize: 12, color: "#D96B6B" }}>Ошибка: {error}</div>}
    </div>
  );
}

export default function BriefsPage() {
  return (
    <Suspense fallback={<div style={{ color: "#555", padding: 40 }}>Загрузка...</div>}>
      <BriefsContent />
    </Suspense>
  );
}
