"use client";
import { useEffect, useState, useCallback, useMemo } from "react";
import { conceptStore, actorStore } from "@/lib/store";
import type { Concept, Actor } from "@/lib/types";
import { Card, Button, Badge, Modal, Label, Empty, SectionTitle } from "@/components/ui";

// Две новые оси библиотеки (28.09.2026):
//  • Концепции видео (type of video) — мировая библиотека (~120 форматов: talking head,
//    UGC, стрит-интервью, скринкаст, 3D-метафора …) + флаг «наша» у тех, что мы запускали.
//  • Актёры — конкретные люди в кадре: реальные по имени (ANNA, PETER), ИИ-персонажи по кодам
//    WOM{n}/MAN{n}. Персона описывает, К КОМУ обращаемся; актёр — КТО в кадре.

const CONCEPT_COLOR = "#7B8CDE";
const ACTOR_COLOR = "#D9A86B";

// ── Концепции ──────────────────────────────────────────────────────────────────

function ConceptForm({ initial, onSave, onCancel }: {
  initial?: Partial<Concept>;
  onSave: (data: Omit<Concept, "id" | "createdAt">) => void;
  onCancel: () => void;
}) {
  const [form, setForm] = useState({
    code: initial?.code || "",
    name: initial?.name || "",
    nameEn: initial?.nameEn || "",
    category: initial?.category || "",
    description: initial?.description || "",
    whenWorks: initial?.whenWorks || "",
    example: initial?.example || "",
    isOurs: initial?.isOurs ?? false,
    oursNote: initial?.oursNote || "",
    color: initial?.color || CONCEPT_COLOR,
  });
  const f = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
    setForm(p => ({ ...p, [k]: e.target.value }));
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "grid", gridTemplateColumns: "90px 1fr 1fr", gap: 10 }}>
        <div><Label>Код</Label><input value={form.code} onChange={f("code")} placeholder="V121" /></div>
        <div><Label>Название *</Label><input value={form.name} onChange={f("name")} placeholder="Стрит-интервью" /></div>
        <div><Label>По-английски</Label><input value={form.nameEn} onChange={f("nameEn")} placeholder="Street interview" /></div>
      </div>
      <div><Label>Группа</Label><input value={form.category} onChange={f("category")} placeholder="Интервью и диалог" /></div>
      <div><Label>Что это и как устроено</Label><textarea value={form.description} onChange={f("description")} rows={3} /></div>
      <div><Label>Когда и зачем работает</Label><textarea value={form.whenWorks} onChange={f("whenWorks")} rows={2} /></div>
      <div><Label>Пример структуры / сцены</Label><textarea value={form.example} onChange={f("example")} rows={2} /></div>
      <div style={{ display: "flex", gap: 14, alignItems: "center" }}>
        <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12, color: "#CCC", cursor: "pointer" }}>
          <input type="checkbox" checked={form.isOurs} onChange={e => setForm(p => ({ ...p, isOurs: e.target.checked }))} /> Мы это запускали
        </label>
      </div>
      {form.isOurs && <div><Label>Как реализовано у нас</Label><textarea value={form.oursNote} onChange={f("oursNote")} rows={2} placeholder="Крео-примеры, нюансы исполнения" /></div>}
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <Button onClick={onCancel}>Отмена</Button>
        <Button variant="primary" onClick={() => form.name.trim() && onSave({ ...form, code: form.code.trim().toUpperCase() || undefined })}>Сохранить</Button>
      </div>
    </div>
  );
}

function ConceptCard({ c, onEdit, onDelete, onToggleOurs }: { c: Concept; onEdit: () => void; onDelete: () => void; onToggleOurs: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <Card style={{ border: c.isOurs ? `1px solid ${CONCEPT_COLOR}55` : "1px solid rgba(255,255,255,0.06)" }}>
      <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 4 }}>
            {c.code && <span style={{ fontFamily: "monospace", fontSize: 12, fontWeight: 700, color: CONCEPT_COLOR }}>{c.code}</span>}
            <span style={{ fontSize: 13, fontWeight: 700, color: "#DDD" }}>{c.name}</span>
            {c.nameEn && <span style={{ fontSize: 11, color: "#666" }}>{c.nameEn}</span>}
            {c.category && <Badge color="#888">{c.category}</Badge>}
            {c.isOurs ? <Badge color="#6EC8A0">★ наша</Badge> : <Badge color="#555">мировая</Badge>}
          </div>
          <div style={{ fontSize: 12, color: "#999", lineHeight: 1.5 }}>{c.description}</div>
          {open && (
            <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 6, fontSize: 12, color: "#AAA" }}>
              {c.whenWorks && <div><span style={{ color: "#666" }}>Когда работает: </span>{c.whenWorks}</div>}
              {c.example && <div><span style={{ color: "#666" }}>Пример: </span>{c.example}</div>}
              {c.isOurs && c.oursNote && <div><span style={{ color: "#6EC8A0" }}>У нас: </span>{c.oursNote}</div>}
            </div>
          )}
        </div>
        <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
          <Button size="sm" onClick={() => setOpen(!open)}>{open ? "Свернуть" : "Детали"}</Button>
          <Button size="sm" onClick={onToggleOurs}>{c.isOurs ? "Убрать из наших" : "★ Наша"}</Button>
          <Button size="sm" onClick={onEdit}>Изменить</Button>
          <Button size="sm" variant="danger" onClick={onDelete}>✕</Button>
        </div>
      </div>
    </Card>
  );
}

// ── Актёры ────────────────────────────────────────────────────────────────────

function ActorForm({ initial, onSave, onCancel }: {
  initial?: Partial<Actor>;
  onSave: (data: Omit<Actor, "id" | "createdAt">) => void;
  onCancel: () => void;
}) {
  const [form, setForm] = useState({
    code: initial?.code || "",
    name: initial?.name || "",
    kind: (initial?.kind || "real") as "real" | "ai",
    gender: (initial?.gender || "") as "" | "f" | "m",
    description: initial?.description || "",
    referenceUrl: initial?.referenceUrl || "",
    notes: initial?.notes || "",
  });
  const f = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
    setForm(p => ({ ...p, [k]: e.target.value }));
  const suggestAiCode = () => {
    const prefix = form.gender === "m" ? "MAN" : "WOM";
    setForm(p => ({ ...p, code: `${prefix}${Math.floor(1000 + Math.random() * 9000)}` }));
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
        <div><Label>Тип</Label>
          <select value={form.kind} onChange={f("kind")}>
            <option value="real">Реальный человек</option>
            <option value="ai">ИИ-персонаж</option>
          </select>
        </div>
        <div><Label>Пол</Label>
          <select value={form.gender} onChange={f("gender")}>
            <option value="">—</option><option value="f">Женщина</option><option value="m">Мужчина</option>
          </select>
        </div>
        <div><Label>Код *</Label>
          <div style={{ display: "flex", gap: 6 }}>
            <input value={form.code} onChange={f("code")} placeholder={form.kind === "ai" ? "WOM1987" : "ANNA"} style={{ flex: 1 }} />
            {form.kind === "ai" && <Button size="sm" onClick={suggestAiCode}>🎲</Button>}
          </div>
        </div>
      </div>
      <div><Label>Имя *</Label><input value={form.name} onChange={f("name")} placeholder={form.kind === "ai" ? "wom1987" : "Анна"} /></div>
      <div><Label>Внешность, возраст, типаж, манера</Label><textarea value={form.description} onChange={f("description")} rows={3} /></div>
      <div><Label>Кадр-референс (URL)</Label><input value={form.referenceUrl} onChange={f("referenceUrl")} placeholder="https://…/frame.jpg" /></div>
      <div><Label>Заметки</Label><textarea value={form.notes} onChange={f("notes")} rows={2} placeholder="Где снимался, что сработало" /></div>
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <Button onClick={onCancel}>Отмена</Button>
        <Button variant="primary" onClick={() => form.code.trim() && form.name.trim() && onSave({ ...form, gender: form.gender || null })}>Сохранить</Button>
      </div>
    </div>
  );
}

function ActorCard({ a, onEdit, onDelete }: { a: Actor; onEdit: () => void; onDelete: () => void }) {
  return (
    <Card>
      <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
        {a.referenceUrl ? (
          <img src={a.referenceUrl} alt="" style={{ width: 56, height: 56, borderRadius: 10, objectFit: "cover", background: "#0d0f15", flexShrink: 0 }} />
        ) : (
          <div style={{ width: 56, height: 56, borderRadius: 10, background: "rgba(255,255,255,0.04)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 22, flexShrink: 0 }}>
            {a.kind === "ai" ? "🤖" : "🎬"}
          </div>
        )}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 4 }}>
            <span style={{ fontFamily: "monospace", fontSize: 12, fontWeight: 700, color: ACTOR_COLOR }}>{a.code}</span>
            <span style={{ fontSize: 13, fontWeight: 700, color: "#DDD" }}>{a.name}</span>
            <Badge color={a.kind === "ai" ? "#C490D1" : "#6EC8A0"}>{a.kind === "ai" ? "ИИ" : "реальный"}</Badge>
            {a.gender && <Badge color="#888">{a.gender === "f" ? "жен." : "муж."}</Badge>}
          </div>
          {a.description && <div style={{ fontSize: 12, color: "#999", lineHeight: 1.5 }}>{a.description}</div>}
          {a.notes && <div style={{ fontSize: 11, color: "#666", marginTop: 4 }}>{a.notes}</div>}
        </div>
        <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
          <Button size="sm" onClick={onEdit}>Изменить</Button>
          <Button size="sm" variant="danger" onClick={onDelete}>✕</Button>
        </div>
      </div>
    </Card>
  );
}

// ── Вкладки ───────────────────────────────────────────────────────────────────

export function ConceptsTab() {
  const [items, setItems] = useState<Concept[]>([]);
  const [scope, setScope] = useState<"ours" | "all">("ours");
  const [cat, setCat] = useState<string>("all");
  const [q, setQ] = useState("");
  const [modal, setModal] = useState<{ open: boolean; editing?: Concept }>({ open: false });

  const reload = useCallback(async () => setItems(await conceptStore.getAll()), []);
  useEffect(() => { reload(); }, [reload]);

  const cats = useMemo(() => Array.from(new Set(items.map(c => c.category).filter(Boolean))) as string[], [items]);
  const shown = items
    .filter(c => scope === "all" || c.isOurs)
    .filter(c => cat === "all" || c.category === cat)
    .filter(c => !q || (c.name + " " + (c.nameEn ?? "") + " " + (c.description ?? "") + " " + (c.code ?? "")).toLowerCase().includes(q.toLowerCase()));
  const oursCount = items.filter(c => c.isOurs).length;

  const save = async (data: Omit<Concept, "id" | "createdAt">) => {
    if (modal.editing) await conceptStore.update(modal.editing.id, data); else await conceptStore.save(data);
    setModal({ open: false }); await reload();
  };

  return (
    <div>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 14 }}>
        <SectionTitle color={CONCEPT_COLOR} icon="🎞">Концепции видео</SectionTitle>
        <div style={{ flex: 1 }} />
        <div style={{ display: "flex", gap: 4 }}>
          {([["ours", `★ Наши (${oursCount})`], ["all", `Мировая библиотека (${items.length})`]] as const).map(([v, l]) => (
            <button key={v} onClick={() => setScope(v)} style={{
              padding: "6px 12px", borderRadius: 8, fontSize: 11, cursor: "pointer", fontFamily: "inherit", fontWeight: scope === v ? 700 : 400,
              border: scope === v ? `1px solid ${CONCEPT_COLOR}66` : "1px solid rgba(255,255,255,0.06)", background: scope === v ? `${CONCEPT_COLOR}1A` : "rgba(255,255,255,0.02)", color: scope === v ? CONCEPT_COLOR : "#666",
            }}>{l}</button>
          ))}
        </div>
        <select value={cat} onChange={e => setCat(e.target.value)} style={{ fontSize: 11, padding: "6px 8px", width: 220 }}>
          <option value="all">Все группы</option>
          {cats.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
        <input value={q} onChange={e => setQ(e.target.value)} placeholder="поиск: talking head, интервью, V19…" style={{ fontSize: 11, padding: "6px 10px", width: 240 }} />
        <Button variant="primary" onClick={() => setModal({ open: true })}>+ Концепция</Button>
      </div>
      <p style={{ fontSize: 12, color: "#666", margin: "0 0 12px", lineHeight: 1.5 }}>
        Концепция — это тип видео (type of video): как ролик устроен как формат, независимо от хука, боди и энгла. Мировая библиотека — всё, что существует в перформанс-видео;
        «★ наши» — концепции, которые мы реально запускали (флаг ставится вручную или разметкой Gemini по нашим роликам). В имени объявления концепция идёт кодом V{"{n}"}.
      </p>
      {shown.length === 0 ? <Empty icon="🎞" text={scope === "ours" ? "Наших концепций пока не отмечено. Переключитесь на мировую библиотеку и отметьте ★ те, что запускали." : "Ничего не найдено."} /> : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {shown.map(c => (
            <ConceptCard key={c.id} c={c}
              onEdit={() => setModal({ open: true, editing: c })}
              onDelete={async () => { if (confirm(`Удалить концепцию ${c.code} ${c.name}?`)) { await conceptStore.delete(c.id); await reload(); } }}
              onToggleOurs={async () => { await conceptStore.update(c.id, { isOurs: !c.isOurs }); await reload(); }} />
          ))}
        </div>
      )}
      <Modal open={modal.open} onClose={() => setModal({ open: false })} title={modal.editing ? "Изменить концепцию" : "Новая концепция"}>
        <ConceptForm initial={modal.editing} onSave={save} onCancel={() => setModal({ open: false })} />
      </Modal>
    </div>
  );
}

export function ActorsTab() {
  const [items, setItems] = useState<Actor[]>([]);
  const [kind, setKind] = useState<"all" | "real" | "ai">("all");
  const [modal, setModal] = useState<{ open: boolean; editing?: Actor }>({ open: false });
  const reload = useCallback(async () => setItems(await actorStore.getAll()), []);
  useEffect(() => { reload(); }, [reload]);
  const shown = items.filter(a => kind === "all" || a.kind === kind);
  const save = async (data: Omit<Actor, "id" | "createdAt">) => {
    if (modal.editing) await actorStore.update(modal.editing.id, data); else await actorStore.save(data);
    setModal({ open: false }); await reload();
  };
  return (
    <div>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 14 }}>
        <SectionTitle color={ACTOR_COLOR} icon="🎭">Актёры</SectionTitle>
        <div style={{ flex: 1 }} />
        <div style={{ display: "flex", gap: 4 }}>
          {([["all", `Все (${items.length})`], ["real", `Реальные (${items.filter(a => a.kind === "real").length})`], ["ai", `ИИ (${items.filter(a => a.kind === "ai").length})`]] as const).map(([v, l]) => (
            <button key={v} onClick={() => setKind(v)} style={{
              padding: "6px 12px", borderRadius: 8, fontSize: 11, cursor: "pointer", fontFamily: "inherit", fontWeight: kind === v ? 700 : 400,
              border: kind === v ? `1px solid ${ACTOR_COLOR}66` : "1px solid rgba(255,255,255,0.06)", background: kind === v ? `${ACTOR_COLOR}1A` : "rgba(255,255,255,0.02)", color: kind === v ? ACTOR_COLOR : "#666",
            }}>{l}</button>
          ))}
        </div>
        <Button variant="primary" onClick={() => setModal({ open: true })}>+ Актёр</Button>
      </div>
      <p style={{ fontSize: 12, color: "#666", margin: "0 0 12px", lineHeight: 1.5 }}>
        Актёр — конкретный человек в кадре, а не описание персонажа. Реальные люди — по имени (ANNA, PETER …), ИИ-персонажи — по кодам WOM{"{n}"} / MAN{"{n}"}.
        Один и тот же скрипт с разными актёрами даёт разный результат, поэтому актёр — отдельная ось аналитики. Новых реальных актёров нужно также добавить в список real_actor_codes в brief.config.ts, чтобы парсер имён их узнавал.
      </p>
      {shown.length === 0 ? <Empty icon="🎭" text="Актёров пока нет." /> : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {shown.map(a => <ActorCard key={a.id} a={a} onEdit={() => setModal({ open: true, editing: a })} onDelete={async () => { if (confirm(`Удалить актёра ${a.code}?`)) { await actorStore.delete(a.id); await reload(); } }} />)}
        </div>
      )}
      <Modal open={modal.open} onClose={() => setModal({ open: false })} title={modal.editing ? "Изменить актёра" : "Новый актёр"}>
        <ActorForm initial={modal.editing} onSave={save} onCancel={() => setModal({ open: false })} />
      </Modal>
    </div>
  );
}
