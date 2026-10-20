"use client";
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import { Card, Badge, Empty } from "@/components/ui";

// ── Компании и конкуренты, за которыми следим (таблица competitor_companies, миграция 034) ──
// Один список из трёх источников, дубли склеены: Холдинги (страницы Meta по воронкам),
// ТОП-100 EdTech, рекламодатели по теме из трендвотчера (+ посев Google).

export interface Company {
  id: string;
  key: string;
  name: string;
  aliases: string[];
  groups: string[];
  region: string | null;
  website: string | null;
  domains: string[];
  meta_page_ids: string[];
  ads_library_urls: string[];
  funnel_links: string[];
  pages: string[];
  categories: string[];
  tw_sources: string[];
  tw_relevant: number;
  tw_winners: number;
  tw_strong: number;
  tw_max_reach: number;
  tw_max_days: number;
  active_pages: number;
  priority: string;
  notes: string | null;
}

const GROUP_META: Record<string, { label: string; color: string; hint: string }> = {
  trendwatcher:   { label: "Трендвотчер",     color: "#E8AA42", hint: "рекламодатели по теме профориентации (Meta / TikTok / Google), DE" },
  seed_google:    { label: "Посев Google",    color: "#6EC8A0", hint: "рекламодатели, по которым трендвотчер ходит в Google Transparency" },
  edtech_top100:  { label: "EdTech ТОП-100",  color: "#48B8D0", hint: "мировые онлайн-школы: сайт + страницы в Meta Ads Library" },
  holding_pages: { label: "Холдинги",  color: "#C490D1", hint: "бренды крупных холдингов — страницы Meta и их воронки" },
};

const adsLibraryByPage = (id: string) =>
  `https://www.facebook.com/ads/library/?active_status=all&ad_type=all&country=ALL&search_type=page&view_all_page_id=${id}`;

export default function Companies() {
  const [rows, setRows] = useState<Company[]>([]);
  const [loading, setLoading] = useState(true);
  const [group, setGroup] = useState<string>("all");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string; notes: string; priority: string } | null>(null);

  const load = async () => {
    setLoading(true);
    const { data } = await supabase.from("competitor_companies").select("*").order("tw_strong", { ascending: false }).order("active_pages", { ascending: false }).order("name").range(0, 1999);
    setRows((data ?? []) as Company[]);
    setLoading(false);
  };
  useEffect(() => { load(); }, []);

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    return rows.filter(r =>
      (group === "all" || r.groups.includes(group)) &&
      (!s || [r.name, ...r.aliases, ...r.domains, ...r.pages, ...r.categories].some(x => x.toLowerCase().includes(s))),
    );
  }, [rows, group, q]);

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: rows.length };
    for (const r of rows) for (const g of r.groups) c[g] = (c[g] ?? 0) + 1;
    return c;
  }, [rows]);

  const save = async () => {
    if (!editing) return;
    await supabase.from("competitor_companies").update({ notes: editing.notes || null, priority: editing.priority, updated_at: new Date().toISOString() }).eq("id", editing.id);
    setEditing(null); load();
  };

  const fmt = (n: number) => n.toLocaleString("ru-RU");

  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 10, marginBottom: 14 }}>
        {[["all", "Всего компаний", "#DDD"], ...Object.entries(GROUP_META).map(([k, m]) => [k, m.label, m.color])].map(([k, label, color]) => (
          <Card key={k} style={{ textAlign: "center", cursor: "pointer", border: group === k ? `1px solid ${color}66` : undefined, background: group === k ? `${color}12` : undefined }} onClick={() => setGroup(k)}>
            <div style={{ fontSize: 22, fontWeight: 800, color }}>{counts[k] ?? 0}</div>
            <div style={{ fontSize: 10, color: "#666", marginTop: 2 }}>{label}</div>
          </Card>
        ))}
      </div>

      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 10, flexWrap: "wrap" }}>
        <span style={{ fontSize: 11, color: "#555" }}>{group === "all" ? "Дубли между источниками склеены по имени и домену." : GROUP_META[group]?.hint}</span>
        <input value={q} onChange={e => setQ(e.target.value)} placeholder="Поиск по имени, домену, странице, категории…" style={{ marginLeft: "auto", width: 300, fontSize: 12, padding: "6px 12px" }} />
      </div>

      {loading ? <Empty icon="⏳" text="Загрузка…" /> : filtered.length === 0 ? <Empty icon="🔍" text="Ничего не найдено." /> : (
        <Card style={{ padding: 0, overflow: "hidden" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
            <thead>
              <tr style={{ color: "#555", fontSize: 10, textTransform: "uppercase", letterSpacing: 0.5, textAlign: "left" }}>
                {["Компания", "Источники", "Регион", "Домены / сайт", "Страниц Meta", "Крео по теме", "Winners", "Макс. охват", "Макс. дней", "Приоритет"].map(h => (
                  <th key={h} style={{ padding: "10px 12px", borderBottom: "1px solid rgba(255,255,255,0.06)", fontWeight: 700 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map(r => {
                const isOpen = open === r.id;
                return (
                  <>
                    <tr key={r.id} onClick={() => setOpen(isOpen ? null : r.id)} style={{ cursor: "pointer", borderBottom: "1px solid rgba(255,255,255,0.04)", background: isOpen ? "rgba(255,255,255,0.03)" : undefined }}>
                      <td style={{ padding: "9px 12px" }}>
                        <div style={{ fontWeight: 700, color: "#EEE" }}>{r.name}</div>
                        {r.aliases.length > 0 && <div style={{ fontSize: 10, color: "#555" }}>{r.aliases.slice(0, 3).join(" · ")}{r.aliases.length > 3 ? ` +${r.aliases.length - 3}` : ""}</div>}
                      </td>
                      <td style={{ padding: "9px 12px" }}>
                        <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                          {r.groups.map(g => <Badge key={g} color={GROUP_META[g]?.color ?? "#888"}>{GROUP_META[g]?.label ?? g}</Badge>)}
                        </div>
                      </td>
                      <td style={{ padding: "9px 12px", color: "#888" }}>{r.region ?? "—"}</td>
                      <td style={{ padding: "9px 12px", color: "#9AB", fontFamily: "monospace", fontSize: 11 }}>
                        {r.website ? <a href={r.website} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()} style={{ color: "#48B8D0" }}>{r.website.replace(/^https?:\/\/(www\.)?/, "")}</a> : (r.domains[0] ?? "—")}
                        {r.domains.length > 1 && <span style={{ color: "#555" }}> +{r.domains.length - 1}</span>}
                      </td>
                      <td style={{ padding: "9px 12px", color: "#AAA" }}>{r.meta_page_ids.length}{r.active_pages ? <span style={{ color: "#6EC8A0" }}> · {r.active_pages} акт.</span> : null}</td>
                      <td style={{ padding: "9px 12px", color: r.tw_relevant ? "#DDD" : "#444" }}>{r.tw_relevant || "—"}</td>
                      <td style={{ padding: "9px 12px", color: r.tw_winners ? "#6EC8A0" : "#444", fontWeight: 700 }}>{r.tw_winners || "—"}{r.tw_strong > r.tw_winners ? <span style={{ color: "#666", fontWeight: 400 }}> / {r.tw_strong}</span> : null}</td>
                      <td style={{ padding: "9px 12px", color: r.tw_max_reach ? "#DDD" : "#444" }}>{r.tw_max_reach ? fmt(r.tw_max_reach) : "—"}</td>
                      <td style={{ padding: "9px 12px", color: r.tw_max_days ? "#DDD" : "#444" }}>{r.tw_max_days || "—"}</td>
                      <td style={{ padding: "9px 12px" }}><Badge color={r.priority === "core" ? "#E8AA42" : r.priority === "archive" ? "#555" : "#888"}>{r.priority}</Badge></td>
                    </tr>
                    {isOpen && (
                      <tr key={r.id + "_d"} style={{ background: "rgba(255,255,255,0.02)", borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
                        <td colSpan={10} style={{ padding: "12px 16px" }}>
                          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, fontSize: 12 }}>
                            <div>
                              {r.categories.length > 0 && <div style={{ marginBottom: 8 }}><span style={{ color: "#666" }}>Категории трендвотчера: </span>{r.categories.join(", ")}</div>}
                              {r.tw_sources.length > 0 && <div style={{ marginBottom: 8 }}><span style={{ color: "#666" }}>Где найден: </span>{r.tw_sources.join(", ")}</div>}
                              {r.domains.length > 0 && <div style={{ marginBottom: 8 }}><span style={{ color: "#666" }}>Домены: </span><span style={{ fontFamily: "monospace" }}>{r.domains.join(", ")}</span></div>}
                              {r.meta_page_ids.length > 0 && (
                                <div style={{ marginBottom: 8 }}>
                                  <span style={{ color: "#666" }}>Meta Ads Library: </span>
                                  {r.meta_page_ids.slice(0, 12).map(id => <a key={id} href={adsLibraryByPage(id)} target="_blank" rel="noreferrer" style={{ color: "#48B8D0", marginRight: 8, fontFamily: "monospace", fontSize: 11 }}>{id}</a>)}
                                  {r.meta_page_ids.length > 12 && <span style={{ color: "#555" }}>+{r.meta_page_ids.length - 12}</span>}
                                </div>
                              )}
                              {r.funnel_links.length > 0 && (
                                <div style={{ marginBottom: 8 }}>
                                  <span style={{ color: "#666" }}>Воронки: </span>
                                  {r.funnel_links.slice(0, 6).map(u => <div key={u}><a href={u} target="_blank" rel="noreferrer" style={{ color: "#9AB", fontSize: 11, wordBreak: "break-all" }}>{u.slice(0, 110)}</a></div>)}
                                  {r.funnel_links.length > 6 && <span style={{ color: "#555" }}>+{r.funnel_links.length - 6}</span>}
                                </div>
                              )}
                            </div>
                            <div>
                              {r.pages.length > 0 && (
                                <div style={{ marginBottom: 8 }}>
                                  <span style={{ color: "#666" }}>Страницы Meta ({r.pages.length}): </span>
                                  <div style={{ color: "#AAA", fontSize: 11, lineHeight: 1.6, maxHeight: 140, overflowY: "auto" }}>{r.pages.join(" · ")}</div>
                                </div>
                              )}
                              <div style={{ display: "flex", gap: 8, alignItems: "flex-end", marginTop: 6 }}>
                                <label style={{ fontSize: 10, color: "#666" }}>Приоритет
                                  <select value={editing?.id === r.id ? editing.priority : r.priority} onChange={e => setEditing({ id: r.id, notes: editing?.id === r.id ? editing.notes : (r.notes ?? ""), priority: e.target.value })}
                                    style={{ display: "block", marginTop: 4, fontSize: 12, padding: "5px 8px", background: "rgba(255,255,255,0.04)", color: "#DDD", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 6 }}>
                                    <option value="core">core — ядро, смотрим каждую неделю</option>
                                    <option value="watch">watch — наблюдаем</option>
                                    <option value="archive">archive — не актуально</option>
                                  </select>
                                </label>
                                <label style={{ fontSize: 10, color: "#666", flex: 1 }}>Заметка
                                  <input value={editing?.id === r.id ? editing.notes : (r.notes ?? "")} onChange={e => setEditing({ id: r.id, notes: e.target.value, priority: editing?.id === r.id ? editing.priority : r.priority })}
                                    placeholder="почему следим / что смотреть" style={{ display: "block", width: "100%", marginTop: 4, fontSize: 12, padding: "5px 8px" }} />
                                </label>
                                {editing?.id === r.id && <button onClick={save} style={{ fontSize: 11, padding: "6px 12px", borderRadius: 6, background: "rgba(232,170,66,0.15)", border: "1px solid rgba(232,170,66,0.4)", color: "#E8AA42", cursor: "pointer", fontFamily: "inherit" }}>Сохранить</button>}
                              </div>
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </>
                );
              })}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
