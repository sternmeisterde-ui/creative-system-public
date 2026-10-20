// ── Двойная независимая проверка (Gemini + Codex/OpenAI) — общий модуль ─────────────────
// Вынесено из /api/analytics/report: тот же механизм проверяет отчёт и предложение пака («Следующий пак»).
// Codex-модели работают ТОЛЬКО через Responses API (/v1/responses); текст — output[].content[].text.
import type { ReportVerification, ReportVerifications } from "@/lib/types";

export function parseVerdict(raw: string, model: string): ReportVerification {
  try {
    const m = raw.match(/\{[\s\S]*\}/);
    const o = JSON.parse(m ? m[0] : raw) as Record<string, unknown>;
    const status = ["ok", "warning", "fail"].includes(String(o.status)) ? (o.status as ReportVerification["status"]) : "warning";
    const issues = Array.isArray(o.issues)
      ? (o.issues as Record<string, unknown>[]).slice(0, 12).map(i => ({
          severity: ["high", "medium", "low"].includes(String(i.severity)) ? (i.severity as "high" | "medium" | "low") : "medium",
          area: String(i.area ?? "—").slice(0, 80),
          detail: String(i.detail ?? "").slice(0, 400),
        }))
      : [];
    return { model, status, confidence: typeof o.confidence === "number" ? o.confidence : 0.5, issues, summary: String(o.summary ?? "").slice(0, 600) };
  } catch {
    return { model, status: "error", confidence: 0, issues: [], summary: "Не удалось разобрать ответ модели" };
  }
}

export async function verifyWithGemini(instruction: string, ctx: string): Promise<ReportVerification> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return { model: "gemini", status: "skipped", confidence: 0, issues: [], summary: "GEMINI_API_KEY не задан" };
  try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${key}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ text: `${instruction}\n\n${ctx}` }] }], generationConfig: { temperature: 0, responseMimeType: "application/json" } }),
    });
    if (!r.ok) return { model: "gemini", status: "error", confidence: 0, issues: [], summary: `Gemini HTTP ${r.status}` };
    const j = await r.json() as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
    return parseVerdict((j.candidates?.[0]?.content?.parts ?? []).map(p => p.text ?? "").join(""), "gemini");
  } catch (e) {
    return { model: "gemini", status: "error", confidence: 0, issues: [], summary: e instanceof Error ? e.message : String(e) };
  }
}

export async function verifyWithCodex(instruction: string, ctx: string): Promise<ReportVerification> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return { model: "codex", status: "skipped", confidence: 0, issues: [], summary: "OPENAI_API_KEY не задан" };
  const model = process.env.OPENAI_MODEL ?? "gpt-5.3-codex";
  try {
    const r = await fetch("https://api.openai.com/v1/responses", {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, instructions: instruction, input: ctx }),
    });
    if (!r.ok) {
      const body = await r.text().catch(() => "");
      let reason = "";
      try { const e = (JSON.parse(body) as { error?: { code?: string; message?: string } }).error; reason = [e?.code, e?.message?.slice(0, 140)].filter(Boolean).join(": "); } catch { reason = body.slice(0, 140); }
      return { model: "codex", status: "error", confidence: 0, issues: [], summary: `OpenAI HTTP ${r.status}${reason ? ` — ${reason}` : ""}` };
    }
    const j = await r.json() as { output?: { content?: { type?: string; text?: string }[] }[] };
    return parseVerdict((j.output ?? []).flatMap(o => o.content ?? []).map(c => c.text ?? "").join(""), "codex");
  } catch (e) {
    return { model: "codex", status: "error", confidence: 0, issues: [], summary: e instanceof Error ? e.message : String(e) };
  }
}

/** Обе проверки параллельно + консенсус: любой fail → fail, иначе warning → warning, иначе ok. */
export async function runDualVerification(instruction: string, ctx: string): Promise<ReportVerifications> {
  const checks = await Promise.all([verifyWithGemini(instruction, ctx), verifyWithCodex(instruction, ctx)]);
  const overall: ReportVerifications["overall"] = checks.some(c => c.status === "fail") ? "fail" : checks.some(c => c.status === "warning") ? "warning" : "ok";
  return { overall, checks };
}
