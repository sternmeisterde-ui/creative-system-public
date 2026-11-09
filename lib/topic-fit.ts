import { contentTokens } from "@/lib/param-overlap";

/**
 * Смысловая совместимость формулировок слота (21.10.2026, пак Бух ×10, слот 1: персона-цитата про язык
 * «как собака ей Богу. Всё понимаю, а сказать не могу» открыла стрит-интервью про зарплаты — шов «это про язык, а теперь про деньги»).
 * Две детерминированные проверки:
 *  1) вид персоны: обращение / наименование сегмента / история от первого лица / утверждение. История от первого лица
 *     в концепциях «Интервью и диалог» не может быть вступлением ведущего — только репликой собеседника.
 *  2) темы: лексикон тем; кандидат с темами, не пересекающимися с темами остальных осей, — чужой.
 */
export type PersonaKind = "address" | "segment" | "story" | "statement";

const FIRST_PERSON = /(^|[^а-яё])(я|мне|меня|мной|мой|моя|моё|мои|сама|сам|у меня|могу|хочу|знаю|понимаю|думаю|работаю|сижу|иду|живу|боюсь|устала|устал|сдавала|сдавал|отработала|отработал|пошла|пошёл|посчитала|посчитал|думала|думал|сказала|сказал|получаю|не тяну)(?=$|[^а-яё])/u;
const ADDRESS = /(^|[^а-яё])(вы|вас|вам|ваш\w*|ты|тебе|тебя|твой|твоя|твои|хотите|хочешь|устали|ищете|ищешь|готовы|живёте|живете|работаете|работаешь|если|кто|для тех|представьте|спросите)(?=$|[^а-яё])/u;
const SEGMENT = /^(ищем|для |русскоязычн|мигрант|врач|медсестр|медик|бухгалтер|тем, кто|тех, кто)|^[А-ЯЁA-Z\s,.:—–-]{6,}$/u;

export function personaKind(text: string): PersonaKind {
  const t = text.normalize("NFC").replace(/́/g, "").trim();
  const low = t.toLowerCase();
  if (ADDRESS.test(low) || low.endsWith("?")) return "address";
  if (SEGMENT.test(t)) return "segment";
  if (FIRST_PERSON.test(low) || /[а-яё]+(аю|яю|ую|ею)(?=$|[^а-яё])/u.test(low)) return "story";
  return "statement";
}

const THEMES: Record<string, RegExp> = {
  язык: /немецк|язык|\b[abс][12]\b|\bв[12]\b|сказа|понима|говор|учебник|слов[ао]|fachsprach|approbation|апробац/iu,
  деньги: /зарплат|евро|€|нетто|брутто|получа|зарабат|деньг|доход|mini-?job|\b603\b|\b\d{4}\b/iu,
  тяжёлая_работа: /смен[аыу]|ночн|склад|касс|уборк|ног[иа]\b|спин|колен|тяж[её]л|физич|pflege|флеге|стройк|тел[оа]\b|сил[ыа]\b|не тяну|на ногах/iu,
  возраст: /\b4\d\b|\b5\d\b|возраст|старше|поздно|поезд ушел|после 45/iu,
  квалификация: /образован|диплом|опыт|резюме|подтверд|сертификат|экзамен/iu,
  профессия: /професс|курс|обучен|учить|выучить|переучит|бухгалтер|регистратур|ресепш|праксис|praxis|медицин|клиник|офис/iu,
  оплата: /бесплатн|оплат|пособи/iu,
  семья: /дети|детей|мам[аыу]|ребён|семь[яи]|декрет/iu,
};

export function themes(text: string): Set<string> {
  const t = text.normalize("NFC").replace(/́/g, "");
  return new Set(Object.entries(THEMES).filter(([, rx]) => rx.test(t)).map(([k]) => k));
}

export interface TopicFit { fits: boolean; shared: string[]; candidate: string[] }

/** Кандидат совместим, если у него нет тем (нейтрален) или хотя бы одна тема общая с остальными осями. */
export function topicFit(candidate: string, others: Array<string | null | undefined>): TopicFit {
  const c = [...themes(candidate)];
  const pool = new Set(others.filter((x): x is string => !!x).flatMap(x => [...themes(x)]));
  const shared = c.filter(x => pool.has(x));
  return { fits: c.length === 0 || shared.length > 0, shared, candidate: c };
}

export const INTERVIEW_CATEGORY = /интервью|диалог|interview/iu;

/** Отсылка к третьему лицу или событию вне кадра («эта женщина», «на звонке», «мне написали»): такой текст нельзя начинать без ввода референта. */
export const DEIXIS = /(^|[^а-яё])(эта женщина|этот мужчина|эта девушка|она сказала|он сказал|на звонке|по телефону|мне написал[аи]?|написал[аи]? мне|одна (моя )?(знакомая|клиентка|ученица)|мне позвонил[аи]?)(?=$|[^а-яё])/iu;
export function deixisRef(text: string): string | null { const m = DEIXIS.exec(text.normalize("NFC").replace(/\u0301/g, "")); return m ? m[2] : null; }

/** Роль персоны в ролике: в интервью история от первого лица — реплика собеседника, не вступление ведущего. */
export function personaRole(persona: string | null | undefined, conceptCategory?: string | null): "host" | "interviewee" | null {
  if (!persona) return null;
  return personaKind(persona) === "story" && !!conceptCategory && INTERVIEW_CATEGORY.test(conceptCategory) ? "interviewee" : "host";
}

/** Проверка тем слота: null — всё в порядке, иначе причина, по которой слот не собирается. */
export function slotCoherenceIssue(p: { persona?: string | null; hook: string; body: string; angle: string; conceptCategory?: string | null; changedAxis?: string | null }): string | null {
  if (p.persona) {
    const fit = topicFit(p.persona, [p.hook, p.body, p.angle]);
    if (!fit.fits) return `персона про «${fit.candidate.join(", ")}», а хук/боди/энгл — про другое: тем в пересечении нет`;
  }
  if (p.changedAxis === "hook") {
    const fit = topicFit(p.hook, [p.body, p.angle, p.persona]);
    if (!fit.fits) return `хук про «${fit.candidate.join(", ")}», а боди/энгл — про другое: тем в пересечении нет`;
  }
  return null;
}
