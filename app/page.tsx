"use client";
import { useEffect, useState } from "react";
import { formulationStore, sessionStore, briefStore } from "@/lib/store";
import { supabase } from "@/lib/supabase";
import { Card, PageHeader, Stat, Badge } from "@/components/ui";
import Link from "next/link";
import { CHANNELS } from "@/components/ChannelContext";

interface ChanStats { id: string; totalAds: number; winners: number; losers: number; spend: number; leads: number; quals: number }
interface LiveStats {
  totalAds: number;
  winners: number;
  losers: number;
  totalSpend: number;
  leads: number;
  quals: number;
  lastSync: string | null;
  byChannel: ChanStats[];
}

export default function Dashboard() {
  const [lib, setLib] = useState({ personas: 0, hooks: 0, bodies: 0, angles: 0, sessions: 0, briefs: 0 });
  const [live, setLive] = useState<LiveStats | null>(null);

  useEffect(() => {
    const load = async () => {
      const [forms, sessions, briefs] = await Promise.all([
        formulationStore.getAll(), sessionStore.getAll(), briefStore.getAll(),
      ]);
      const n = (axis: string) => forms.filter(f => f.axis === axis).length;
      setLib({ personas: n("persona"), hooks: n("hook"), bodies: n("body"), angles: n("angle"), sessions: sessions.length, briefs: briefs.length });

      // Общий даш по всем каналам: view отдаёт максимум 1000 строк — читаем страницами.
      const rows: { auto_status: string; spend: string; platform: string | null; leads: number; qual_leads: number }[] = [];
      for (let from = 0; ; from += 1000) {
        const { data: page } = await supabase.from("creative_performance").select("auto_status, spend, platform, leads, qual_leads").order("ad_id").range(from, from + 999);
        rows.push(...((page ?? []) as typeof rows));
        if (!page || page.length < 1000) break;
      }
      const { data: syncRow } = await supabase.from("meta_sync_log").select("synced_at").eq("status", "ok").order("synced_at", { ascending: false }).limit(1).single();
      const num = (v: unknown) => Number(v ?? 0) || 0;
      const agg = (list: typeof rows, id: string): ChanStats => ({
        id,
        totalAds: list.length,
        winners: list.filter(r => r.auto_status === "winner").length,
        losers: list.filter(r => r.auto_status === "loser").length,
        spend: list.reduce((s, r) => s + num(r.spend), 0),
        leads: list.reduce((s, r) => s + num(r.leads), 0),
        quals: list.reduce((s, r) => s + num(r.qual_leads), 0),
      });
      const all = agg(rows, "all");
      setLive({
        totalAds: all.totalAds, winners: all.winners, losers: all.losers, totalSpend: all.spend, leads: all.leads, quals: all.quals,
        lastSync: syncRow?.synced_at ?? null,
        byChannel: CHANNELS.filter(c => c.id !== "all").map(c => agg(rows.filter(r => (r.platform ?? "meta") === c.id), c.id)),
      });
    };
    load();
  }, []);

  const STEPS = [
    { href: "/library", icon: "📚", label: "Библиотека", desc: "Персоны, хуки, боди, энглы", color: "#48B8D0" },
    { href: "/builder", icon: "⚡", label: "Конструктор", desc: "AI выбирает топ-3 параметров", color: "#E8AA42" },
    { href: "/briefs", icon: "📋", label: "Брифы", desc: "Адаптированные брифы с AI", color: "#FF8B5A" },
    { href: "/panel", icon: "📡", label: "Панель", desc: "Живые метрики по каналам", color: "#6EC8A0" },
  ];

  return (
    <div>
      <PageHeader title="Creative System" subtitle="Производство и аналитика креативов: Meta · Google · TikTok — общий обзор, цикл внутри каждого канала" />

      {/* Общий даш по всем каналам */}
      {live && (
        <Card style={{ marginBottom: 16, background: "rgba(232,170,66,0.04)", border: "1px solid rgba(232,170,66,0.15)" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: "#E8AA42", textTransform: "uppercase", letterSpacing: 1 }}>
              ◎ Весь трафик — все каналы
            </div>
            {live.lastSync && (
              <span style={{ fontSize: 10, color: "#444" }}>
                Синк Meta: {new Date(live.lastSync).toLocaleString("ru")}
              </span>
            )}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: 20, marginBottom: 18 }}>
            <Stat label="Общий спенд" value={`€${live.totalSpend.toFixed(0)}`} color="#E8AA42" />
            <Stat label="Креативов" value={live.totalAds} />
            <Stat label="Лидов" value={live.leads} color="#6EC8A0" />
            <Stat label="Квал-лидов" value={live.quals} color="#6EC8A0" />
            <Stat label="CPL" value={live.leads > 0 ? `€${(live.totalSpend / live.leads).toFixed(1)}` : "—"} color="#48B8D0" />
            <Stat label="Виннеров / лузеров" value={`${live.winners} / ${live.losers}`} />
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10 }}>
            {live.byChannel.map(ch => {
              const meta = CHANNELS.find(c => c.id === ch.id)!;
              const share = live.totalSpend > 0 ? Math.round(ch.spend / live.totalSpend * 100) : 0;
              return (
                <Link key={ch.id} href={`/panel?channel=${ch.id}`} style={{ textDecoration: "none" }}>
                  <div style={{ padding: "12px 14px", borderRadius: 10, border: `1px solid ${meta.color}33`, background: `${meta.color}08` }}>
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
                      <span style={{ fontSize: 12, fontWeight: 700, color: meta.color }}>{meta.icon} {meta.label}</span>
                      <span style={{ fontSize: 10, color: "#666" }}>{ch.totalAds > 0 ? `${share} % спенда` : "нет данных"}</span>
                    </div>
                    {ch.totalAds > 0 ? (
                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6, fontSize: 12 }}>
                        <div><div style={{ fontWeight: 700, color: "#DDD" }}>€{ch.spend.toFixed(0)}</div><div style={{ fontSize: 10, color: "#555" }}>спенд</div></div>
                        <div><div style={{ fontWeight: 700, color: "#DDD" }}>{ch.totalAds}</div><div style={{ fontSize: 10, color: "#555" }}>крео</div></div>
                        <div><div style={{ fontWeight: 700, color: "#DDD" }}>{ch.leads > 0 ? `€${(ch.spend / ch.leads).toFixed(1)}` : "—"}</div><div style={{ fontSize: 10, color: "#555" }}>CPL · {ch.leads} лидов</div></div>
                      </div>
                    ) : (
                      <div style={{ fontSize: 11, color: "#555" }}>Канал не подключён или не синкался</div>
                    )}
                    <div style={{ marginTop: 8, fontSize: 11, color: meta.color }}>Цикл и панель канала →</div>
                  </div>
                </Link>
              );
            })}
          </div>
        </Card>
      )}

      {/* Library stats */}
      <Card style={{ marginBottom: 24 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: "#555", textTransform: "uppercase", letterSpacing: 1, marginBottom: 14 }}>
          Библиотека параметров
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: 20 }}>
          <Stat label="Персоны" value={lib.personas} color="#48B8D0" />
          <Stat label="Хуки" value={lib.hooks} color="#C490D1" />
          <Stat label="Боди" value={lib.bodies} color="#6EC8A0" />
          <Stat label="Энглы" value={lib.angles} color="#FF8B5A" />
          <Stat label="Сессии" value={lib.sessions} />
          <Stat label="Брифы" value={lib.briefs} />
        </div>
      </Card>

      {/* Process steps */}
      <div style={{ marginBottom: 24 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: "#555", textTransform: "uppercase", letterSpacing: 1, marginBottom: 14 }}>
          Процесс создания креативов
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          {STEPS.map((step, i) => (
            <Link key={step.href} href={step.href} style={{ textDecoration: "none", flex: 1 }}>
              <Card style={{ border: `1px solid ${step.color}20`, background: `${step.color}06`, cursor: "pointer", height: "100%" }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: step.color, marginBottom: 8, fontFamily: "monospace" }}>0{i + 1}</div>
                <div style={{ fontSize: 22, marginBottom: 10 }}>{step.icon}</div>
                <div style={{ fontSize: 13, fontWeight: 700, color: "#DDD", marginBottom: 4 }}>{step.label}</div>
                <div style={{ fontSize: 11, color: "#555", lineHeight: 1.5 }}>{step.desc}</div>
              </Card>
            </Link>
          ))}
        </div>
      </div>

      {/* Quick actions + Library health */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <Card>
          <div style={{ fontSize: 12, fontWeight: 700, color: "#888", marginBottom: 14 }}>Быстрые действия</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {[
              { href: "/library", label: "+ Добавить параметры в библиотеку", color: "#48B8D0" },
              { href: "/builder", label: "⚡ Новая сессия конструктора", color: "#E8AA42" },
              { href: "/pbi", label: "📊 Загрузить данные PBI (лиды)", color: "#C490D1" },
              { href: "/panel", label: "📡 Открыть приборную панель", color: "#6EC8A0" },
              { href: "/admin", label: "⚙️ Настроить правила и скиллы", color: "#FF8B5A" },
            ].map(a => (
              <Link key={a.href} href={a.href} style={{ fontSize: 12, color: a.color, textDecoration: "none", padding: "8px 12px", borderRadius: 8, background: `${a.color}08`, border: `1px solid ${a.color}18`, display: "block" }}>
                {a.label}
              </Link>
            ))}
          </div>
        </Card>

        <Card>
          <div style={{ fontSize: 12, fontWeight: 700, color: "#888", marginBottom: 14 }}>Готовность библиотеки</div>
          {[
            { label: "Персоны", value: lib.personas, color: "#48B8D0", min: 3 },
            { label: "Хуки", value: lib.hooks, color: "#C490D1", min: 3 },
            { label: "Боди", value: lib.bodies, color: "#6EC8A0", min: 3 },
            { label: "Энглы", value: lib.angles, color: "#FF8B5A", min: 3 },
          ].map(item => (
            <div key={item.label} style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
              <div style={{ fontSize: 11, color: "#777", width: 60 }}>{item.label}</div>
              <div style={{ flex: 1, height: 4, background: "rgba(255,255,255,0.05)", borderRadius: 2, overflow: "hidden" }}>
                <div style={{ height: "100%", width: `${Math.min(100, (item.value / item.min) * 100)}%`, background: item.color, borderRadius: 2 }} />
              </div>
              <Badge color={item.value >= item.min ? "#6EC8A0" : "#D96B6B"}>{item.value}</Badge>
            </div>
          ))}
          <div style={{ fontSize: 10, color: "#444", marginTop: 8 }}>Минимум 3 на параметр для запуска конструктора</div>
        </Card>
      </div>
    </div>
  );
}
