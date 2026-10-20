"use client";
import { useState, useEffect } from "react";
import Link from "next/link";
import { Card, Button, Badge, SectionTitle } from "@/components/ui";

// Оркестратор «Прогнать цикл»: последовательно гонит этапы пайплайна (клиентский,
// с живым прогрессом). Стоп перед генерацией пака — отчёт нужно глазами принять.
//   1 синк данных (Meta+Elly) → 2 маппинг → 3 ассеты → 4 Gemini-разбор → 5 отчёт.

type Status = "idle" | "run" | "done" | "error";
interface Stage { key: string; label: string; status: Status; detail?: string }

// Шаги цикла — свои у каждого канала. Meta: синк Meta + Elly → маппинг → ассеты → Gemini → отчёт.
// Google: синк крео + CRM (Elly) → Gemini → отчёт (маппинг кодов — на /mapping/google).
const STAGES_BY_CHANNEL: Record<string, Stage[]> = {
  meta: [
    { key: "sync",   label: "1. Синхронизация Meta + Elly", status: "idle" },
    { key: "map",    label: "2. Маппинг кодов",             status: "idle" },
    { key: "assets", label: "3. Ассеты креативов (Meta)",   status: "idle" },
    { key: "gemini", label: "4. Gemini-разбор крео",        status: "idle" },
    { key: "report", label: "5. Отчёт + проверка",          status: "idle" },
  ],
  google: [
    { key: "sync",   label: "1. Синхронизация Google Ads (крео + превью)", status: "idle" },
    { key: "crm",    label: "2. Лиды из CRM (Elly) по крео",               status: "idle" },
    { key: "gemini", label: "3. Gemini-разбор крео",                        status: "idle" },
    { key: "report", label: "4. Отчёт + проверка",                          status: "idle" },
  ],
  tiktok: [
    { key: "sync",   label: "1. Синхронизация TikTok Ads (объявления + медиа)", status: "idle" },
    { key: "crm",    label: "2. Лиды из CRM (Elly) по объявлениям",             status: "idle" },
    { key: "gemini", label: "3. Gemini-разбор крео",                             status: "idle" },
    { key: "report", label: "4. Отчёт + проверка",                               status: "idle" },
  ],
};

const SC: Record<Status, string> = { idle: "#555", run: "#48B8D0", done: "#6EC8A0", error: "#D96B6B" };
const ST: Record<Status, string> = { idle: "ждёт", run: "идёт…", done: "готово", error: "ошибка" };

async function post(url: string, body: unknown = {}) {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || d?.error) throw new Error(d?.error ?? `HTTP ${r.status}`);
  return d;
}

export default function CycleRunner({ channel = "meta" }: { channel?: string }) {
  const STAGES = STAGES_BY_CHANNEL[channel] ?? [];
  const [stages, setStages] = useState<Stage[]>(STAGES);
  const [running, setRunning] = useState(false);
  useEffect(() => { setStages(STAGES_BY_CHANNEL[channel] ?? []); setDone(false); }, [channel]);
  const [done, setDone] = useState(false);

  const set = (key: string, status: Status, detail?: string) =>
    setStages(prev => prev.map(s => s.key === key ? { ...s, status, detail: detail ?? s.detail } : s));

  const run = async () => {
    setRunning(true); setDone(false);
    setStages(STAGES.map(s => ({ ...s, status: "idle", detail: undefined })));
    try {
      if (channel === "google" || channel === "tiktok") {
        set("sync", "run", channel === "google" ? "Google Ads…" : "TikTok Ads…");
        const g = await post(`/api/${channel}/sync`);
        if (g.error) throw new Error(g.error);
        set("sync", "done", `${g.syncedRows ?? "?"} строк`);
        set("crm", "run");
        const c = await post(`/api/${channel}/crm-sync`);
        set("crm", "done", c.aborted ? "частичный ответ Plurio — повтори" : `${c.synced ?? "?"} строк`);
      } else {
        // 1. Данные
        set("sync", "run", "Meta…");
        await post("/api/meta/sync");
        set("sync", "run", "Elly…");
        await post("/api/pbi/elly-sync");
        set("sync", "done");

        // 2. Маппинг
        set("map", "run");
        await post("/api/naming/assign");
        set("map", "done");

        // 3. Ассеты
        set("assets", "run");
        const a = await post("/api/meta/creatives");
        const ads = (a.results ?? []).reduce((n: number, r: { ads?: number }) => n + (r.ads ?? 0), 0);
        set("assets", "done", `${ads} крео`);
      }

      // Gemini-разбор (чанками до конца) — только крео этого канала
      set("gemini", "run", "запуск…");
      let total = 0;
      for (let i = 0; i < 80; i++) {
        const g = await post("/api/gemini/batch", { limit: 4, platform: channel });
        total += g.processed ?? 0;
        set("gemini", "run", `разобрано ${total}, осталось ${g.remaining}`);
        if (!g.remaining || g.remaining === 0) break;
        if (!g.processed) break; // нечего обрабатывать
      }
      set("gemini", "done", `разобрано ${total}`);

      // Отчёт по каналу
      set("report", "run");
      const rep = await post("/api/analytics/report", { platform: channel });
      const overall = rep?.report?.verifications?.overall ?? "—";
      set("report", "done", `проверка: ${overall}`);
      setDone(true);
    } catch (e) {
      setStages(prev => prev.map(s => s.status === "run" ? { ...s, status: "error", detail: e instanceof Error ? e.message : String(e) } : s));
    } finally {
      setRunning(false);
    }
  };

  if (!STAGES.length) {
    return (
      <Card>
        <SectionTitle icon="🔄" color="#48B8D0">Прогнать цикл</SectionTitle>
        <p style={{ fontSize: 12, color: "#666", marginTop: 4 }}>{channel === "all" ? "Цикл идёт по каналам: выберите Meta или Google в сайдбаре." : "Для этого канала цикл ещё не подключён."}</p>
      </Card>
    );
  }

  return (
    <Card>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <SectionTitle icon="🔄" color="#48B8D0">Прогнать цикл · {channel === "google" ? "Google Ads" : channel === "tiktok" ? "TikTok Ads" : "Meta Ads"}</SectionTitle>
        <Button variant="primary" onClick={run} disabled={running}>
          {running ? "⏳ Идёт…" : "▶ Прогнать цикл"}
        </Button>
      </div>
      <p style={{ fontSize: 12, color: "#666", marginTop: -4, marginBottom: 12 }}>
        {channel === "google" ? "Крео и превью из Google Ads → лиды из CRM → Gemini-разбор → отчёт по каналу." : channel === "tiktok" ? "Объявления и медиа из TikTok Ads → лиды из CRM (источник TikTok) → Gemini-разбор → отчёт по каналу." : "Данные → маппинг → ассеты → Gemini-разбор → отчёт по каналу."} Останавливается перед генерацией пака — отчёт нужно принять глазами.
      </p>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {stages.map(s => (
          <div key={s.key} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: 13 }}>
            <span style={{ color: s.status === "idle" ? "#777" : "#DDD" }}>{s.label}</span>
            <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
              {s.detail && <span style={{ fontSize: 11, color: "#888" }}>{s.detail}</span>}
              <Badge color={SC[s.status]}>{ST[s.status]}</Badge>
            </span>
          </div>
        ))}
      </div>
      {done && (
        <div style={{ marginTop: 12, fontSize: 13, color: "#6EC8A0" }}>
          ✅ Цикл завершён. <Link href={`/report?channel=${channel}`} style={{ color: "#48B8D0" }}>Открыть отчёт →</Link> Если проверка ok/warning — можно идти в генерацию пака.
        </div>
      )}
    </Card>
  );
}
