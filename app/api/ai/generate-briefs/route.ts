import Anthropic from "@anthropic-ai/sdk";
import { NextRequest, NextResponse } from "next/server";
import type { ConstructorSession, Rule } from "@/lib/types";
import { createServiceClient } from "@/lib/supabase";
import { getAiContext, getBusiness, getProductFacts } from "@/lib/brief";
import { ruVideoBriefSystem } from "@/lib/ru-video-brief";
import { overlapNotes } from "@/lib/param-overlap";
import { FORMULATION_COLUMNS, rowToFormulation, ensureFormulation, loadFormulations, productOfCode, AXIS_LABEL, type Formulation, type FormulationRow, type Axis, type FormulationProduct } from "@/lib/formulations";
import { resolveParamRefs, type ParamRef } from "@/lib/param-lookup";
import { extractSpeech, lintSpeech, lintScenes, formatLintBlock } from "@/lib/speech-lint";
import { loadTeamNotes, formatTeamNotes } from "@/lib/weekly-notes";
import { getParamTimings } from "@/lib/param-timings";

// Факты продукта (нельзя перевирать в речи) — в brief.config.ts → product_facts; в код они не зашиты.

// Правила редактора — из правок ТЗ руками (11.10.2026, пак Бухгалтер ×12): что модель делала не так
const EDITOR_RULES = `ПРАВИЛА РЕДАКТОРА (обязательны; нарушения вернутся на правку):
1. ИИ-спикер не даёт личных свидетельств и не выдумывает доказательства: запрещены «я сам таких знаю, десятки», «мне это каждую неделю пишут», «я не вру», «я вам честно скажу», «напишите в комментариях — я отвечу». Опора — проверяемое и нейтральное: «это есть в открытом доступе», «я это регулярно слышу». Я-история (как мне 40, я посчитал) допустима, если она в формулировке.
2. Не унижать текущую работу зрителя и не приписывать ему личные атрибуты (возраст, здоровье, годы до пенсии): не «склад, уборка, доставка», «гробить здоровье», «тело не выдерживает», «работать вам ещё 20 лет» — а «работа не по профилю», «сколько ещё работать и кем», «зарплаты ниже, чем в бухгалтерии». Если такое есть в формулировке — воспроизводится дословно, но вокруг не усиливается.
3. Призыв = действие + место: «Пройдите тест под видео, займёт две минуты». Не «тест. две минуты.» без глагола и места. Комментарий — только как второй, необязательный призыв.
4. Запись речи: аббревиатуры и числа пишутся как есть — A2, C1, СНГ, 120-150 часов, 47 000 евро; никаких «а-два», «эс-эн-гэ», «сто двадцать – сто пятьдесят», никаких пометок «(произн.: …)». Ударения (U+0301) в трудных русских словах и немецкие термины кириллицей (да́тев, де́кра) — остаются.
5. Живая речь без наигранности: 1–2 заполнителя на 100 слов и не больше одного на реплику; эхо-повтор слова ради эмоции («прям… прям», «много, много», «тысячи. тысячи.») — максимум один на ролик; реплика не начинается с отдельного «Вот.»; не дублировать мысль второй фразой («Вообще наоборот», «да-да, не надо», «Голод, реально»). Регистр нейтрально-разговорный: «работают», не «сидят»; «дополнительно», не «допом»; «комментарий», не «коммент»; «я сначала подумал», не «я такой сначала».
6. Грамматика без ошибок модели: обращение «вы» с местоимением («почему вы терпите»), согласование («готовят на специалиста», «учат программу»), «знаете что?» без запятой. Любая реплика, которую нельзя прочитать вслух с первого раза, переписывается.
7. Плашка для ИИ-актёра на экране — «СГЕНЕРИРОВАНО ИИ» (кириллицей), не «AI GENERATED». Текст на экране повторяет речь: если в речи «сертификат» — на плашке тоже.`;

// 20 брифов × ~15-30 секунд каждый = до 10 минут.
// Hobby cap = 300s. Используем максимум; параллелизируем через batch чтобы уложиться.
export const maxDuration = 800; // Pro + fluid: один бриф = генерация (до ~2 мин) + проход линтера-правки (до ~1.5 мин)

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export async function POST(req: NextRequest) {
  const { session, rules, slotIds, skipExisting } = await req.json() as {
    session: ConstructorSession;
    rules: Rule[];
    slotIds?: number[];       // генерировать только эти слоты пака (клиент идёт частями по 5 — лимит функции 800 с)
    skipExisting?: boolean;   // пропустить слоты, у которых в сессии уже есть бриф с теми же кодами
  };
  const onlySlots = slotIds?.length ? new Set(slotIds) : null;
  // Параметры = формулировки (уникальные дословные тексты). Сервер резолвит их сам: по кодам слотов пака
  // или по id из ручного конструктора. Клиентские списки библиотеки больше не принимаются.
  const refById: Record<string, ParamRef> = {};
  // Заметки к параметру (бывшие «сценарии»): теперь это note формулировки в библиотеке
  const noteById: Record<string, string> = {};

  const activeRules = rules.filter(r => r.active);
  const rulesText = activeRules.length > 0
    ? `\nПРАВИЛА АДАПТАЦИИ:\n${activeRules.map((r, i) => `${i + 1}. ${r.title}: ${r.content}`).join("\n")}`
    : "";

  const supabase = createServiceClient();
  // 20.10.2026: полный отчёт и 20 Gemini-разборов виннеров/лузеров из промпта брифа убраны — направление пака уже
  // выбрано движком (слоты), а эти ~30k токенов топили правила речи. Бриф видит только донора слота и заметки команды.

  // Концепция видео пака (V-код) — режиссёрская рамка для всех брифов сессии
  const packConcept = (session as { packMetadata?: { concept?: { code?: string; name?: string } | null } }).packMetadata?.concept ?? null;
  let conceptText = "";
  if (packConcept?.code) {
    const { data: c } = await supabase.from("concepts")
      .select("code, name, category, description, when_works, example").eq("code", packConcept.code).maybeSingle();
    if (c) {
      conceptText = `
КОНЦЕПЦИЯ ВИДЕО (type of video) — ОБЯЗАТЕЛЬНА для всех брифов: ${c.code} — ${c.name}${c.category ? ` (${c.category})` : ""}.
` +
        `Что это: ${c.description ?? "—"}
Когда работает: ${c.when_works ?? "—"}
Пример: ${c.example ?? "—"}
` +
        `Сценарий, кадры и ТЗ на съёмку/монтаж строй строго в этой концепции; не подменяй её другим типом видео.
`;
    }
  }


  type Combo = {
    personaId: string | null; hookId: string; bodyId: string; angleId: string; actorCode?: string | null;
    category?: string; basedOnAd?: string; variedParam?: string; fromWinners?: string[];
  };
  const combinations: Combo[] = [];
  let skippedIncomplete = 0;
  // Актёры (кто в кадре) — описание в бриф
  const { data: actorRows } = await supabase.from("actors").select("code, name, kind, gender, description, reference_url");
  type ActorRow = { code: string; name: string; kind: string; gender: string | null; description: string | null; reference_url: string | null };
  const actorByCode = new Map(((actorRows ?? []) as ActorRow[]).map(a => [a.code.toUpperCase(), a]));

  // Pack-mode: session создана через /api/pack/generate → слоты с кодами формулировок → id формулировок.
  const packMeta = (session as { packMetadata?: { slots: Array<{
    slotId?: number;
    codes: { persona: string | null; hook: string | null; body: string | null; angle: string | null; actor?: string | null };
    category?: string; basedOnAd?: string; variedParam?: string; fromWinners?: string[];
  }> } }).packMetadata;
  let completedSlots = 0;
  if (packMeta?.slots?.length) {
    // ── Дозаполнение неполных слотов: хук, боди и энгл обязательны; актёр для видео — самый используемый подходящего типа.
    // ПЕРСОНА НЕ ДОЗАПОЛНЯЕТСЯ (решение 20.10.2026, пак Мед ×20): она берётся только от донора или как варьируемая ось пака;
    // null = без прямого обращения, имя объявления без MP-кода. Навязанная персона (чек-лист с баннера) дублировала боди
    // и ломала чистоту эксперимента «меняем только X». Обновлённые слоты сохраняются в pack_metadata.
    const packProduct: FormulationProduct = (() => {
      const pm = (session as { packMetadata?: { product?: string } }).packMetadata?.product;
      if (pm === "buchhalter" || pm === "medadmin") return pm;
      const any = packMeta.slots.flatMap(sl => [sl.codes.hook, sl.codes.body, sl.codes.angle, sl.codes.persona]).find((c): c is string => !!c && !!productOfCode(c));
      return (any && productOfCode(any)) || "buchhalter";
    })();
    const axes4: Axis[] = ["persona", "hook", "body", "angle"];
    const requiredAxes: Axis[] = ["hook", "body", "angle"];
    const incompleteSlots = packMeta.slots.filter(sl => requiredAxes.some(a => !sl.codes[a]) || (session.format !== "static" && !sl.codes.actor));
    if (incompleteSlots.length) {
      const lib = await loadFormulations(supabase, { product: packProduct });
      const libByCode = new Map(lib.map(f => [f.code, f]));
      const { data: usageRows } = await supabase.from("ad_name_mapping").select("persona_code, hook_code, body_code, angle_code, actor_code").eq("product", packProduct);
      const usage: Record<string, number> = {};
      for (const r of usageRows ?? []) for (const c of [r.persona_code, r.hook_code, r.body_code, r.angle_code, r.actor_code]) if (c) usage[c] = (usage[c] ?? 0) + 1;
      const candidates = (axis: Axis) => lib.filter(f => f.axis === axis).sort((a, b) => (usage[b.code] ?? 0) - (usage[a.code] ?? 0)).slice(0, 80);
      const wantKind = session.format === "human" ? "real" : "ai"; // производство ИИ (Higgsfield): реальные актёры только для HUMAN
      const bestActor = [...actorByCode.values()].filter(a => a.kind === wantKind).sort((a, b) => (usage[b.code] ?? 0) - (usage[a.code] ?? 0))[0] ?? [...actorByCode.values()][0];
      for (const sl of incompleteSlots) {
        const missing = requiredAxes.filter(a => !sl.codes[a]);
        if (missing.length) {
          const known = axes4.filter(a => sl.codes[a]).map(a => `${AXIS_LABEL[a]}: «${libByCode.get(sl.codes[a] as string)?.text ?? sl.codes[a]}»`).join("\n");
          const libBlock = missing.map(a => `${AXIS_LABEL[a]} — кандидаты:\n${candidates(a).map(f => `  ${f.code} [${usage[f.code] ?? 0} крео]: «${f.text.replace(/\s+/g, " ").slice(0, 160)}»`).join("\n") || "  (нет)"}`).join("\n\n");
          try {
            const msg = await client.messages.create({
              model: "claude-fable-5-1", max_tokens: 3000,
              messages: [{ role: "user", content: `В слоте пака не хватает параметров: ${missing.map(a => AXIS_LABEL[a]).join(", ")}. Каждый параметр = уникальная ДОСЛОВНАЯ формулировка (точный текст, который прозвучит/будет написан в креативе).
Известные параметры слота:
${known || "(нет)"}

${libBlock}

Для КАЖДОГО недостающего параметра выбери код существующей формулировки, которая логично сочетается с известными (предпочитай формулировки с крео), либо, если ни одна не подходит, напиши НОВЫЙ дословный текст.
Верни СТРОГО JSON без markdown: { "hook": { "code": "MH123456" } | { "text": "…" }, ... } — только недостающие оси.` }],
            });
            const text = msg.content.filter(b => b.type === "text").map(b => (b as { text?: string }).text ?? "").join("");
            const m = text.match(/\{[\s\S]*\}/);
            const pick = m ? (JSON.parse(m[0]) as Partial<Record<Axis, { code?: string; text?: string }>>) : {};
            for (const a of missing) {
              const v = pick[a];
              if (v?.code && libByCode.has(v.code.trim().toUpperCase())) sl.codes[a] = v.code.trim().toUpperCase();
              else if (v?.text && v.text.trim()) {
                const { formulation } = await ensureFormulation(supabase, { axis: a, product: packProduct, text: v.text, source: "brief", note: "дозаполнение слота пака при генерации брифов" });
                sl.codes[a] = formulation.code; libByCode.set(formulation.code, formulation);
              }
            }
          } catch (e) { console.warn("[gen-briefs] slot completion failed:", e instanceof Error ? e.message : e); }
        }
        if (session.format !== "static" && !sl.codes.actor && bestActor) sl.codes.actor = bestActor.code;
        if (requiredAxes.every(a => sl.codes[a])) completedSlots++;
      }
      await supabase.from("constructor_sessions").update({ pack_metadata: (session as { packMetadata?: unknown }).packMetadata }).eq("id", session.id);
    }
    const codes = Array.from(new Set(packMeta.slots.flatMap(s => [s.codes.persona, s.codes.hook, s.codes.body, s.codes.angle]).filter((c): c is string => !!c)));
    const byCode = new Map<string, Formulation>();
    for (let i = 0; i < codes.length; i += 200) {
      const { data } = await supabase.from("formulations").select(FORMULATION_COLUMNS).in("code", codes.slice(i, i + 200));
      for (const r of (data ?? []) as FormulationRow[]) { const f = rowToFormulation(r); byCode.set(f.code, f); refById[f.id] = { id: f.id, code: f.code, text: f.text, legacy: false }; if (f.note) noteById[f.id] = f.note; }
    }
    // уже готовые брифы сессии (по id формулировок) — чтобы догенерировать только недостающие
    const existing = new Set<string>();
    if (skipExisting) {
      const { data: ex } = await supabase.from("briefs").select("persona_id, hook_id, body_id, angle_id").eq("session_id", session.id);
      for (const b of ex ?? []) existing.add([b.persona_id, b.hook_id, b.body_id, b.angle_id].map(x => x ?? "").join("|"));
    }
    for (const slot of packMeta.slots) {
      if (onlySlots && !onlySlots.has((slot as { slotId?: number }).slotId ?? -1)) continue;
      const personaId = slot.codes.persona ? byCode.get(slot.codes.persona)?.id ?? null : null;
      const hookId    = slot.codes.hook    ? byCode.get(slot.codes.hook)?.id    : undefined;
      const bodyId    = slot.codes.body    ? byCode.get(slot.codes.body)?.id    : undefined;
      const angleId   = slot.codes.angle   ? byCode.get(slot.codes.angle)?.id   : undefined;
      // Хук, боди, энгл обязательны (сюда доходят только слоты, которые не удалось дозаполнить); персона может быть null
      if (!hookId || !bodyId || !angleId) { skippedIncomplete++; continue; }
      if (skipExisting && existing.has([personaId, hookId, bodyId, angleId].join("|"))) continue;
      combinations.push({
        personaId, hookId, bodyId, angleId, actorCode: slot.codes.actor ?? null,
        category: slot.category, basedOnAd: slot.basedOnAd, variedParam: slot.variedParam, fromWinners: slot.fromWinners,
      });
    }
  } else {
    // Ручной конструктор: декартово произведение выбранных формулировок (id).
    const ids = [...session.selectedPersonas, ...session.selectedHooks, ...session.selectedBodies, ...session.selectedAngles];
    Object.assign(refById, await resolveParamRefs(supabase, ids));
    const personasSel = session.selectedPersonas.length ? session.selectedPersonas : [null];
    for (const pId of personasSel)
      for (const hId of session.selectedHooks)
        for (const bId of session.selectedBodies)
          for (const aId of session.selectedAngles)
            combinations.push({ personaId: pId, hookId: hId, bodyId: bId, angleId: aId });
  }

  if (combinations.length === 0 && (skipExisting || onlySlots)) {
    return new Response(JSON.stringify({ __progress: 100 }) + "\n", { headers: { "Content-Type": "application/x-ndjson; charset=utf-8" } });
  }
  if (combinations.length === 0) {
    return new NextResponse(JSON.stringify({ error: skippedIncomplete
      ? `Все ${skippedIncomplete} слот(ов) пака неполные (нет хука/боди/энгла) — перегенерируй пак в конструкторе.`
      : "No combinations to generate. Session has neither pack_metadata.slots nor selected_* arrays." }), { status: 400 });
  }

  // Исполнение виннеров-доноров (Gemini-описание контента) → наследуем при размножении.
  const donorNames = Array.from(new Set(
    combinations.flatMap(c => [c.basedOnAd, ...(c.fromWinners ?? [])]).filter((n): n is string => !!n)
  ));
  const donorDesc = new Map<string, string>();
  if (donorNames.length > 0) {
    const { data: descs } = await supabase
      .from("gemini_analyses").select("ad_name, analysis").eq("mode", "creative_desc").in("ad_name", donorNames);
    for (const d of (descs ?? []) as { ad_name: string; analysis: string }[]) {
      const key = (d.ad_name ?? "").trim().toLowerCase();
      if (key && d.analysis && !donorDesc.has(key)) donorDesc.set(key, d.analysis);
    }
  }
  // Заметки команды по донорам из субъективного анализа недели — что сработало и что просили поменять
  const teamNotes = donorNames.length ? await loadTeamNotes(supabase, donorNames).catch(() => new Map()) : new Map();
  // Таймкоды параметров у доноров — в кеш заранее (ТЗ ставит ссылки на фрагменты хука/боди/энгла). Ошибки не блокируют генерацию.
  if (donorNames.length) {
    const { data: dAssets } = await supabase.from("meta_creatives").select("ad_name, video_id").in("ad_name", donorNames).not("video_id", "is", null);
    const { data: dMaps } = await supabase.from("ad_name_mapping").select("ad_name, persona_code, hook_code, body_code, angle_code").in("ad_name", donorNames);
    const dCodes = Array.from(new Set((dMaps ?? []).flatMap(m => [m.persona_code, m.hook_code, m.body_code, m.angle_code]).filter(Boolean))) as string[];
    const { data: dForms } = dCodes.length ? await supabase.from("formulations").select("code, text").in("code", dCodes) : { data: [] };
    const tOf = Object.fromEntries((dForms ?? []).map(f => [f.code, f.text]));
    const items = (dAssets ?? []).map(a => { const m = (dMaps ?? []).find(x => x.ad_name === a.ad_name); return { adName: a.ad_name, videoId: a.video_id as string, texts: { persona: m?.persona_code ? tOf[m.persona_code] : null, hook: m?.hook_code ? tOf[m.hook_code] : null, body: m?.body_code ? tOf[m.body_code] : null, angle: m?.angle_code ? tOf[m.angle_code] : null } }; });
    await getParamTimings(supabase, items, { maxNew: 10 }).catch(() => undefined);
  }
  const execOf = (c: Combo): string => {
    const names = [c.basedOnAd, ...(c.fromWinners ?? [])].filter((n): n is string => !!n);
    const parts = names.map(n => donorDesc.get(n.trim().toLowerCase())).filter(Boolean);
    const notes = names.map(n => { const t = formatTeamNotes(teamNotes.get(n.trim().toLowerCase())); return t ? `${n}: ${t}` : ""; }).filter(Boolean);
    if (parts.length === 0 && notes.length === 0) return "";
    const vary = c.variedParam ? ` Меняй ТОЛЬКО ${c.variedParam}; всё остальное исполнение (персонаж, сцену, визуал, динамику) СОХРАНИ.` : "";
    const exec = parts.length ? `\nИСПОЛНЕНИЕ ВИННЕРА-ДОНОРА (наследуй визуал/персонажа/сцену, не только коды):${vary}\n${parts.join("\n---\n")}` : "";
    const team = notes.length ? `\nЗАМЕТКИ КОМАНДЫ ПО ДОНОРУ (субъективный анализ недели — учесть обязательно: плюсы сохранить, ошибки не повторять, «что делаем» выполнить, если не противоречит формулировкам):\n${notes.join("\n")}` : "";
    return exec + team;
  };

  // Один бриф = один вызов. Анализ:
  //   при BATCH=4 → max_tokens=16k → реально 60-180с per batch и truncation.
  //   при BATCH=1 → max_tokens=6k → 20-30с per call, нет truncation.
  //   при concurrency=5 → 4 раунда × 30с = 120с — уверенно в Vercel 300s.
  const BATCH_SIZE = 1;
  const encoder = new TextEncoder();

  // Системный промпт видео-брифов: скилл ru-video-brief целиком (кеш) + правила Creative System поверх него
  const CS_RULES = `ПРАВИЛА CREATIVE SYSTEM ПОВЕРХ СКИЛЛА (единственные места, где они сильнее скилла):
1. Параметры креатива — дословные формулировки с кодами (персона, хук, боди, энгл). Они измеряются в аналитике по точному тексту: звучат или показываются на экране ДОСЛОВНО, без перефраза, сокращений и «улучшений». Шаг 3 скилла «3 варианта хука» = 3 варианта ПОДАЧИ первого кадра при одних и тех же словах хука.
2. Призыв для рекламы Meta Ads = действие + место: «Пройдите тест под видео, займёт две минуты». Комментарий — только вторым, необязательным. Правило скилла «не ссылка» здесь не действует: тест под видео и есть цель ролика.
3. Формат выдачи — шаблон из задания (расширяет templates/brief.md разделами ПАРАМЕТРЫ В РОЛИКЕ, ТЗ НА МОНТАЖ, ПРОМПТ ДЛЯ HIGGSFIELD). Раздел «Варианты для теста» не нужен: пак уже дизайн эксперимента. Шаг 7 (check_brief.py) выполнит система линтером после ответа — блок «Проверка речи» не писать.
4. Один ролик = одна мысль по шагам. Каждый параметр звучит один раз; что дублирует уже сказанное — только плашка на экране. Смена кадра каждые 5–7 с. Бюджет ≤ 2,2 слова в секунду, при нехватке поднимать хронометраж, а не резать формулировки.

${getProductFacts()}

${EDITOR_RULES}`;
  const briefSystem = session.format !== "static" ? ruVideoBriefSystem(CS_RULES) : undefined;

  const batches: typeof combinations[] = [];
  for (let i = 0; i < combinations.length; i += BATCH_SIZE) {
    batches.push(combinations.slice(i, i + BATCH_SIZE));
  }

  const stream = new ReadableStream({
    async start(controller) {
      try {
        let done = 0;
        // Запускаем все батчи параллельно
        const buildBatchPrompt = (batch: typeof combinations) => {
          const isVideo = session.format !== "static";
          const head = isVideo
            ? `Напиши бриф на видео-креатив по скиллу ru-video-brief из системного промпта: пройди шаги 2–6 (речевой паспорт до текста → хук → сценарий репликами как говорят → кадр, текст на экране, подача → ударения). Гейты качества скилла обязательны; текст реплик будет прогнан линтером, красные пункты вернутся на правку.

ВХОД (раздел «Вход» скилла):
1. Продукт и оффер: ${getBusiness().name}. ${getAiContext()}
2. Сегмент и Job: формулировки комбинации ниже — это дословный язык клиента из крео-виннеров; персона (если есть) — кому говорим.
3. Цель ролика: лиды (Meta Ads). Адресат — один на ролик, по умолчанию «вы» (если формулировки на «ты» — «ты»). Темп 125–135 сл/мин.
4. Площадка и формат: Meta Ads · ${session.format.toUpperCase()} (говорящая голова / сценка / закадр / UGC-селфи — выбери одно).
5. Длительность: 30 / 45 / 60 с — выбирай по объёму формулировок, бюджет ≤ 2,2 слова/с.
6. Ограничения: факты продукта и правила редактора из системного промпта; ниже — концепция видео и правила адаптации.
7. Вариантов: 1 сценарий; хук — 3 варианта подачи первого кадра при одних и тех же словах.
${conceptText}${rulesText}`
            : `Ты — копирайтер и дизайнер Meta Ads для ${getBusiness().name}.

${getAiContext()}

Формат объявления: ${session.format.toUpperCase()} (статичный баннер).
${conceptText}${rulesText}
Для каждой комбинации создай ПОЛНЫЙ ПАКЕТ: адаптированный контент + описание баннера + ТЗ на дизайн + промпт для Higgsfield.`;
          return `${head}

ПАРАМЕТРЫ КРЕАТИВА — ЭТО ДОСЛОВНЫЕ ФОРМУЛИРОВКИ (у каждой свой код). Они измеряются в аналитике по точному тексту, поэтому:
• хук, боди и энгл должны прозвучать / появиться на экране в креативе ДОСЛОВНО, без перефраза, сокращений и «улучшений» (можно только дополнять вокруг: связки, сцены, визуал, CTA);
• если задана персона — её фраза-обращение тоже звучит дословно (обычно в начале);
• adaptedHook / adaptedBody / adaptedAngle в ответе = сами формулировки БЕЗ изменений (копия текста). Всё творчество — в fullBrief.

${batch.map((combo, idx) => {
  const persona = combo.personaId ? refById[combo.personaId] : undefined;
  const hook = refById[combo.hookId];
  const body = refById[combo.bodyId];
  const angle = refById[combo.angleId];
  const sc = (id: string) => (noteById[id] ? ` Заметка к формулировке: "${noteById[id]}"` : "");
  const actor = combo.actorCode ? actorByCode.get(combo.actorCode.toUpperCase()) : undefined;
  const ov = isVideo && hook && body && angle ? overlapNotes({ persona: persona?.text ?? null, hook: hook.text, body: body.text, angle: angle.text }) : null;
  return `КОМБИНАЦИЯ ${idx + 1}:
Персона: ${persona ? `[${persona.code}] «${persona.text}» — обращение к аудитории дословно` : "без прямого обращения к аудитории (персона не задана)"}
Актёр: ${actor ? `[${actor.code}] ${actor.name} (${actor.kind === "real" ? "реальный человек" : "ИИ-персонаж"}${actor.gender ? `, ${actor.gender}` : ""})${actor.description ? ` — ${actor.description}` : ""}` : combo.actorCode ? `[${combo.actorCode}]` : "не задан — опиши персонажа сам в ПАРАМЕТРАХ"}
Хук [${hook?.code}]: «${hook?.text}»${sc(combo.hookId)}
Боди [${body?.code}]: «${body?.text}»${sc(combo.bodyId)}
Энгл [${angle?.code}]: «${angle?.text}»${sc(combo.angleId)}${ov?.text ? `\n${ov.text}` : ""}${execOf(combo)}`;
}).join("\n\n")}

Для fullBrief используй СТРОГО этот формат (секции разделены ---):

${isVideo ? `## ПАСПОРТ
| Поле | Значение |
|---|---|
| Цель ролика | лиды (Meta Ads) |
| Формат | ${session.format.toUpperCase()} · говорящая голова / сценка / закадр / UGC-селфи — выбери одно |
| Длительность | 30 / 45 / 60 с → бюджет слов ЖЁСТКИЙ: ≤ 2,2 слова на секунду (30 с ≤ 66 слов, 45 с ≤ 100, 60 с ≤ 130); факт: N слов |
| Обращение | ты / вы — ОДНО на ролик |
| Голос | я-история / эксперт-вы / друг-ты / сценка |
| Скелет | хук → боль или сомнение → поворот → условия (боди по строкам) → выгода (энгл) → призыв; одна мысль на сцену, без итогов и повторов |
| Призыв | пройти тест под видео — действие + место («Пройдите тест под видео, займёт две минуты»); комментарий — только вторым, необязательным |

---

## ПАРАМЕТРЫ В РОЛИКЕ
Каждый из параметров описан отдельно — где он стоит и как подан. Ни один не пропущен. Каждый параметр ЗВУЧИТ ОДИН РАЗ: если текст энгла или персоны буквально содержится в боди или в хуке — он произносится один раз в их составе, а в своей сцене только выделяется плашкой на экране. Персона и хук — одно вступление, а не два подряд.
| Параметр | Код | Текст дословно | Где в ролике (тайминг) | Как подан |
|---|---|---|---|---|
| Персона | <код> | «…» | 0:00–0:03 | речь / экран / оба + кто и как это говорит |
| Хук | <код> | «…» | … | … |
| Боди | <код> | «…» | … | … |
| Энгл | <код> | «…» | … | … |
| Актёр | <код> | кто в кадре: пол, возраст, лук, одежда | весь ролик | реальный / ИИ |
| Концепция | <V-код или —> | название | весь ролик | как реализована |

---

## ХУК
Дословно формулировка хука (её текст менять нельзя). Затем 3 варианта ПОДАЧИ первого кадра (A/B/C): что в кадре, действие, интонация — слова хука во всех трёх одинаковые.

---

## СЦЕНАРИЙ
Полный скрипт ролика ПО СЦЕНАМ. Каждая строка = одна сцена с таймингом. Реплика — речь дословно, как говорят, с ударениями для диктора в трудных словах (буква + U+0301: поняла́, звони́т, джобце́нтр); формулировки хука, боди и энгла вставлены дословно, без правок. Если персонажей несколько — в начале реплики имя: «ЛЕНА: …».
| Время | Сцена: локация, фон, ракурс, лук | Действие в кадре | Реплика (как говорят) | Текст на экране (≤ 6 слов) |
|---|---|---|---|---|
| 0:00–0:03 | кухня, утро, окно за спиной, крупный план, домашняя одежда | наливает чай, поворачивается к камере | … | … |
| 0:03–0:07 | улица у праксиса, вывеска, средний план, куртка | идёт и говорит на ходу | … | … |
ЛОГИКА ПОДАЧИ — главное. Ролик разворачивает ОДНУ мысль по шагам, и каждая сцена отвечает на вопрос, который возник в предыдущей:
1) зацепка 0–3 с: персона + хук как одно обращение (не два вступления подряд, без связок вроде «я это регулярно слышу» между ними);
2) боль или сомнение зрителя — одна сцена;
3) поворот: что меняется / в чём выход — одна сцена;
4) условия и как это работает = строки боди по порядку, одна-две строки на сцену, без вводных «что за работа?», «ну и коротко по итогу», без пересказа уже сказанного;
5) выгода = энгл: если его слова уже прозвучали внутри боди — второй раз НЕ читать, только плашка; если энгл — перечень тезисов через «|» (плашка-итог) или повторяет смысл боди другими словами («Мед. образование не нужно» при уже сказанном «Медицинского образования не нужно») — он идёт ТОЛЬКО текстом на экране одной плашкой целиком (для энгла лимит «≤ 6 слов» не действует), вслух не читается; если энгл — отдельная мысль, он звучит один раз здесь;
6) призыв: «пройдите тест под видео, займёт две минуты».
Запрещены: сводки и итоги («подведём итог», «ещё раз»), повтор одной мысли другими словами, две зацепки подряд, сцены-перебивки без реплики, которые не двигают мысль.
СМЕНА КАДРА КАЖДЫЕ 5–7 СЕКУНД (допустимо 4–8): на 30 с — 5–6 сцен, на 45 с — 7–8, на 60 с — 9–10. Сцена = одна мысль = одна реплика из 1–3 фраз. Соседние сцены различаются планом/ракурсом или локацией; менять локацию каждую сцену не нужно, дробить реплику на 3-секундные куски — нельзя.
БЮДЖЕТ СЛОВ: сначала посчитай слова формулировок (хук + боди + энгл + персона без дублей), остаток до лимита — связки и призыв. Если формулировки сами не влезают в выбранный хронометраж — увеличь его до 60 с, а не ужимай сцены; если не влезают и в 60 с — напиши в ПАСПОРТЕ строку «⚠ формулировки длиннее 60 с» и всё равно не сокращай их.
(речь: половина реплик по 2–5 слов, одна-две длинные по 15–20; 1–2 заполнителя на 100 слов и не больше одного на реплику; один контраст; эхо-повтор ради эмоции — максимум один на ролик; реплика не начинается с отдельного «Вот.»; ноль причастий и триад; аббревиатуры и числа как есть — A2, СНГ, 120-150)

---

## ПОДАЧА ДЛЯ ДИКТОРА
Темп … сл/мин. Где пауза (перед панчем, после вопроса), где ускориться (перечисление), где интонация вверх. Заполнители (1–2 на 100 слов): … Единственный повтор: … Контраст: …

---

## ТЗ НА МОНТАЖ
Ритм: [быстрый / средний / медленный]
Музыка: [описание стиля/настроения]
Текстовые оверлеи: [что и когда показывать на экране; плашки повторяют речь дословно; для ИИ-актёра — плашка «СГЕНЕРИРОВАНО ИИ»]
Субтитры: [нужны / не нужны, стиль]
Переходы: [описание]
Цветокоррекция: [теплая / холодная / нейтральная + почему]

---

## ПРОМПТ ДЛЯ HIGGSFIELD
[Готовый промпт на английском для text-to-video, 2–4 предложения: стиль, действие персонажа, атмосфера, камера]` : `## ОПИСАНИЕ БАННЕРА
[Адаптированный заголовок, подзаголовок, основной текст, CTA-кнопка]

---

## ТЗ НА ДИЗАЙН
Фон: [описание]
Главный визуал: [что изображено]
Заголовок: [текст + размер + расположение]
Цветовая схема: [цвета + hex если нужно]
CTA-кнопка: [текст + цвет]
Дополнительно: [логотип, доп. элементы]

---

## ПРОМПТ ДЛЯ HIGGSFIELD
[Готовый промпт на английском для text-to-image, 2–3 предложения: стиль, визуал, настроение]`}`;
        };

        // Обработать один батч → выплюнуть все брифы в stream
        const processBatch = async (batch: typeof combinations, batchIdx: number) => {
          const t0 = Date.now();
          console.log(`[gen-briefs] batch ${batchIdx} START (${batch.length} combos)`);
          const msgStream = client.messages.stream({
            model: "claude-fable-5-1",
            ...(briefSystem ? { system: briefSystem } : {}),
            // fullBrief в формате ru-video-brief ≈ 4–6k tokens, плюс у Fable 5.1 часть бюджета уходит в thinking-блок:
            // при 8k были обрывы (stop_reason=max_tokens, блоки thinking+tool_use без текста). Берём 16k.
            max_tokens: 24000,
            tools: [{
              name: "generate_briefs",
              description: "Сгенерировать адаптированные брифы для каждой комбинации",
              input_schema: {
                type: "object" as const,
                properties: {
                  briefs: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        idx: { type: "number" },
                        adaptedHook: { type: "string" },
                        adaptedBody: { type: "string" },
                        adaptedAngle: { type: "string" },
                        fullBrief: { type: "string" },
                      },
                      required: ["idx", "adaptedHook", "adaptedBody", "adaptedAngle", "fullBrief"],
                    },
                  },
                },
                required: ["briefs"],
              },
            }],
            // claude-fable-5-1 не поддерживает tool_choice "tool"/"any" (400 invalid_request_error) — только auto + явная просьба в промпте.
            tool_choice: { type: "auto" },
            messages: [{ role: "user", content: buildBatchPrompt(batch) + "\n\nОтвет верни ТОЛЬКО вызовом инструмента generate_briefs (без текста вне инструмента)." }],
          });

          const msg = await msgStream.finalMessage();
          console.log(`[gen-briefs] batch ${batchIdx} CLAUDE ok ${Date.now() - t0}ms`);
          type BriefOut = { idx: number; adaptedHook: string; adaptedBody: string; adaptedAngle: string; fullBrief: string };
          const toolUse = msg.content.find(b => b.type === "tool_use") as { type: "tool_use"; input: { briefs: BriefOut[] } } | undefined;
          let batchResults: BriefOut[] = toolUse?.input?.briefs ?? [];
          if (batchResults.length === 0) {
            // Фолбэк: модель ответила текстом — ищем JSON с briefs в тексте
            const text = msg.content.filter(b => b.type === "text").map(b => (b as { text?: string }).text ?? "").join("");
            const m = text.match(/\{[\s\S]*"briefs"[\s\S]*\}/);
            if (m) { try { batchResults = (JSON.parse(m[0]) as { briefs?: BriefOut[] }).briefs ?? []; } catch { /* ниже отчитаемся ошибкой */ } }
            if (batchResults.length === 0) throw new Error(`модель не вернула брифы (stop_reason=${msg.stop_reason ?? "?"}, блоки: ${msg.content.map(b => b.type).join(",")})`);
          }
          console.log(`[gen-briefs] batch ${batchIdx} GOT ${batchResults.length} briefs from Claude`);

          // Position-based: игнорируем result.idx (Claude может вернуть 1-based
          // или другой порядок — теряем брифы из-за неправильного индекса).
          // Доверяем порядку в массиве: batchResults[i] ← batch[i].
          for (let i = 0; i < batchResults.length; i++) {
            const combo = batch[i];
            const result = batchResults[i];
            if (!combo || !result) continue;
            // Гейт живой речи (скилл ru-video-brief): линтер → при красных один проход правки → блок «Проверка речи» в бриф.
            if (session.format !== "static") {
              const protectedTexts = [combo.personaId ? refById[combo.personaId]?.text : "", refById[combo.hookId]?.text, refById[combo.bodyId]?.text, refById[combo.angleId]?.text].filter((t): t is string => !!t);
              const dialog = /сценка|диалог/i.test(result.fullBrief.slice(0, 1500));
              let lint = lintSpeech(extractSpeech(result.fullBrief), { protectedTexts, dialog });
              lint.issues.push(...lintScenes(result.fullBrief));
              let pass = 1;
              if (lint.issues.length) {
                try {
                  const fix = await client.messages.create({
                    model: "claude-fable-5-1", max_tokens: 16000,
                    ...(briefSystem ? { system: briefSystem } : {}),
                    messages: [{ role: "user", content: `Ниже бриф на видео. Линтер нашёл красные пункты — перепиши таблицу «СЦЕНАРИЙ» (и при необходимости хук), чтобы снять замечания: «слов больше бюджета» — вырезай связки, вводные, итоги и повторы, формулировки не трогай (если не влезает даже так — подними хронометраж до 60 с); «монтаж дробный» — объединяй соседние сцены в 5–7-секундные с одной мыслью; «повтор мысли» — оставь мысль один раз (энгл, уже прозвучавший в боди, второй раз не читать); «кадры повторяются» — смени план/ракурс или локацию. Формулировки параметров (хук/боди/энгл/персона) — неизменяемый текст, их не трогать. Структуру и остальные секции сохрани. Верни бриф целиком, без комментариев.

КРАСНЫЕ ПУНКТЫ:
${lint.issues.map(x => `- ${x}`).join("\n")}
${lint.warns.length ? `\nЖЁЛТЫЕ (по возможности):\n${lint.warns.map(x => `- ${x}`).join("\n")}` : ""}

Правь по скиллу ru-video-brief из системного промпта (нормы речи, нейтив-фразы, бан-лист, ударения).

БРИФ:
${result.fullBrief}` }],
                  });
                  const fixed = fix.content.filter(b => b.type === "text").map(b => (b as { text?: string }).text ?? "").join("").trim();
                  if (fixed.length > 200) { result.fullBrief = fixed; lint = lintSpeech(extractSpeech(fixed), { protectedTexts, dialog }); lint.issues.push(...lintScenes(fixed)); pass = 2; }
                } catch (e) { console.warn("[gen-briefs] lint-fix pass failed:", e instanceof Error ? e.message : e); }
              }
              result.fullBrief = `${result.fullBrief.trim()}\n\n---\n\n${formatLintBlock(lint, pass)}`;
            }
            const brief = {
              personaId: combo.personaId,
              hookId: combo.hookId,
              bodyId: combo.bodyId,
              angleId: combo.angleId,
              format: session.format,
              adaptedHook: result.adaptedHook,
              adaptedBody: result.adaptedBody,
              adaptedAngle: result.adaptedAngle,
              fullBrief: result.fullBrief,
            };
            controller.enqueue(encoder.encode(JSON.stringify(brief) + "\n"));
            done++;
            controller.enqueue(encoder.encode(JSON.stringify({ __progress: Math.round((done / combinations.length) * 100) }) + "\n"));
          }
        };

        // Concurrent с лимитом 4. С BATCH=1 — нагрузка per-call мала,
        // 4 параллельных уверенно не упираются в Anthropic TPM.
        const CONCURRENCY = 6; // пак ≤ 6 брифов уходит одним раундом (бриф с линтер-правкой — до ~6 мин); maxDuration 800
        const errors: string[] = [];
        const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
        const wrapped = async (batch: typeof combinations, idx: number) => {
          for (let attempt = 1; attempt <= 3; attempt++) {
            try {
              // Hard timeout на один бриф (генерация + линтер-правка) — чтобы зависший
              // запрос не блокировал worker'а и не съедал maxDuration.
              await Promise.race([
                processBatch(batch, idx),
                new Promise<never>((_, rej) =>
                  setTimeout(() => rej(new Error(`per-call timeout 400s`)), 400_000)
                ),
              ]);
              return;
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e);
              const isRateLimit = /429|rate.?limit|overload/i.test(msg);
              if (attempt < 3 && isRateLimit) {
                console.warn(`[gen-briefs] batch ${idx} attempt ${attempt} rate-limited, retry`);
                await sleep(2000 * attempt);
                continue;
              }
              console.error(`[gen-briefs] batch ${idx} failed (attempt ${attempt}):`, msg);
              errors.push(`batch ${idx}: ${msg}`);
              return;
            }
          }
        };
        // Простой semaphore без deps
        const queue = batches.map((b, i) => ({ batch: b, idx: i }));
        const workers = Array.from({ length: CONCURRENCY }, async () => {
          while (queue.length > 0) {
            const item = queue.shift();
            if (!item) break;
            await wrapped(item.batch, item.idx);
          }
        });
        await Promise.all(workers);

        if (completedSlots > 0) {
          controller.enqueue(encoder.encode(JSON.stringify({ __warning: `${completedSlots} слот(ов) были без части параметров — недостающие дозаполнены из библиотеки/новыми формулировками и сохранены в пак` }) + "\n"));
        }
        if (skippedIncomplete > 0) {
          controller.enqueue(encoder.encode(JSON.stringify({ __warning: `${skippedIncomplete} слот(ов) пропущено: не удалось дозаполнить персону/хук/боди/энгл — перегенерируй пак` }) + "\n"));
        }
        if (errors.length > 0) {
          // Не throw — все успешные брифы уже отправлены клиенту.
          // Сообщаем об ошибках отдельным JSON-line с __warning.
          controller.enqueue(encoder.encode(JSON.stringify({
            __warning: `${errors.length} батч(ей) с ошибками: ${errors.join("; ")}`,
          }) + "\n"));
        }
      } catch (e) {
        controller.enqueue(encoder.encode(JSON.stringify({ __error: e instanceof Error ? e.message : String(e) }) + "\n"));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8" },
  });
}
