import { NextRequest, NextResponse, after } from "next/server";
import { createServiceClient } from "@/lib/supabase";
import { getParamTimings } from "@/lib/param-timings";
// POST { sessionId } — посчитать таймкоды параметров у доноров и референсов пака в фоне (кеш gemini_analyses/timings).
// Экспорт ТЗ берёт таймкоды только из кеша, поэтому считаем их заранее: здесь и при генерации брифов.
export const maxDuration = 800;
export async function POST(req: NextRequest) {
  const { sessionId } = await req.json().catch(() => ({})) as { sessionId?: string };
  if (!sessionId) return NextResponse.json({ error: "sessionId обязателен" }, { status: 400 });
  const sb = createServiceClient();
  const { data: s } = await sb.from("constructor_sessions").select("pack_metadata").eq("id", sessionId).maybeSingle();
  const slots = ((s?.pack_metadata as { slots?: Array<{ basedOnAd?: string; fromWinners?: string[]; change?: { toCode?: string; fromCode?: string | null } }> } | null)?.slots ?? []);
  const donors = Array.from(new Set(slots.flatMap(x => [x.basedOnAd, ...(x.fromWinners ?? [])]).filter((n): n is string => !!n)));
  const codes = Array.from(new Set(slots.flatMap(x => [x.change?.toCode, x.change?.fromCode]).filter((c): c is string => !!c)));
  after(async () => {
    const names = new Set(donors);
    if (codes.length) {
      for (let off = 0; ; off += 1000) {
        const { data } = await sb.from("ad_name_mapping").select("ad_name, persona_code, hook_code, body_code, angle_code").order("ad_name").range(off, off + 999);
        for (const m of data ?? []) if ([m.persona_code, m.hook_code, m.body_code, m.angle_code].some(c => c && codes.includes(c))) names.add(m.ad_name);
        if (!data || data.length < 1000) break;
      }
    }
    const list = [...names];
    const { data: assets } = await sb.from("meta_creatives").select("ad_name, video_id").in("ad_name", list).not("video_id", "is", null);
    const { data: maps } = await sb.from("ad_name_mapping").select("ad_name, persona_code, hook_code, body_code, angle_code").in("ad_name", list);
    const allCodes = Array.from(new Set((maps ?? []).flatMap(m => [m.persona_code, m.hook_code, m.body_code, m.angle_code]).filter(Boolean))) as string[];
    const { data: forms } = allCodes.length ? await sb.from("formulations").select("code, text").in("code", allCodes) : { data: [] };
    const tOf = Object.fromEntries((forms ?? []).map(f => [f.code, f.text]));
    const items = (assets ?? []).map(a => { const m = (maps ?? []).find(x => x.ad_name === a.ad_name); return { adName: a.ad_name, videoId: a.video_id as string, texts: { persona: m?.persona_code ? tOf[m.persona_code] : null, hook: m?.hook_code ? tOf[m.hook_code] : null, body: m?.body_code ? tOf[m.body_code] : null, angle: m?.angle_code ? tOf[m.angle_code] : null } }; });
    await getParamTimings(sb, items, { maxNew: 20 }).catch(() => undefined);
  });
  return NextResponse.json({ ok: true, donors: donors.length });
}
