"use client";
// Страница ожидания экспорта ТЗ: опрашивает статус фонового задания и переходит в Google Doc, когда он готов.
import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";

function ExportWait() {
  const job = useSearchParams().get("job");
  const [state, setState] = useState<{ status: string; url?: string | null; error?: string | null; title?: string | null } | null>(null);
  const [sec, setSec] = useState(0);
  useEffect(() => {
    if (!job) return;
    let alive = true;
    const tick = async () => {
      try { const r = await fetch(`/api/briefs/export-status?job=${job}`, { cache: "no-store" }); const j = await r.json(); if (!alive) return; setState(j); if (j.status === "ready" && j.url) { window.location.replace(j.url); return; } if (j.status === "error") return; }
      catch { /* retry */ }
      if (alive) setTimeout(tick, 3000);
    };
    tick();
    const t = setInterval(() => setSec(s => s + 1), 1000);
    return () => { alive = false; clearInterval(t); };
  }, [job]);
  const box: React.CSSProperties = { maxWidth: 560, margin: "15vh auto", padding: 28, background: "#12141A", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 16, color: "#DDD", fontFamily: "-apple-system, Inter, sans-serif" };
  if (!job) return <div style={box}>Нет номера задания.</div>;
  if (state?.status === "error") return <div style={box}><div style={{ fontSize: 16, fontWeight: 700, color: "#D96B6B", marginBottom: 10 }}>Не удалось собрать ТЗ в Google Docs</div><div style={{ fontSize: 13, color: "#AAA", whiteSpace: "pre-wrap" }}>{state.error}</div><div style={{ marginTop: 14, fontSize: 12, color: "#888" }}>Вернись на вкладку «Брифы» и скачай DOCX — он собирается тем же кодом, без Google Drive.</div></div>;
  return (
    <div style={box}>
      <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 8 }}>Готовлю ТЗ в Google Docs…</div>
      <div style={{ fontSize: 13, color: "#AAA", lineHeight: 1.6 }}>Собираю бриф, референсы и фрагменты доноров, загружаю в Drive. Обычно 20–60 секунд, при первом открытии пака до 2–3 минут. Документ откроется здесь сам.</div>
      <div style={{ marginTop: 14, fontSize: 12, color: "#E8AA42" }}>{state?.status === "ready" ? "Открываю…" : `идёт ${sec} с`}</div>
      {state?.status === "ready" && state.url && <a href={state.url} style={{ color: "#48B8D0", fontSize: 13 }}>Открыть документ вручную</a>}
    </div>
  );
}
export default function Page() { return <Suspense fallback={null}><ExportWait /></Suspense>; }
