import fs from "node:fs";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";

/**
 * Скилл ru-video-brief как системный промпт генерации брифов (с 20.10.2026).
 * Источник правды — папка скилла `.claude/skills/ru-video-brief` (та же, по которой бриф пишется руками):
 * SKILL.md + референсы + шаблон читаются с диска и уходят модели одним кешируемым блоком.
 * Файлы попадают в бандл Vercel через `outputFileTracingIncludes` в next.config.ts.
 * Если файла нет — падаем: бриф без методики хуже, чем бриф не сгенерированный.
 */
const SKILL_DIR = path.join(process.cwd(), ".claude", "skills", "ru-video-brief");
const SKILL_FILES = [
  "SKILL.md",
  "references/01_speech_profile.md",
  "references/02_syntax_rhythm.md",
  "references/03_hooks.md",
  "references/04_native_phrases.md",
  "references/05_structure_cta.md",
  "references/06_lexicon_register.md",
  "references/07_ban_prefer.md",
  "references/08_stress.md",
  "templates/brief.md",
];
/** Контекст конкретного продукта/компании — есть не в каждой установке скилла; читается, если файл на месте. */
const OPTIONAL_FILES = ["references/10_product_context.md"];

let cachedSkill: string | null = null;

export function loadRuVideoBriefSkill(): string {
  if (cachedSkill) return cachedSkill;
  const parts = SKILL_FILES.map(rel => {
    const p = path.join(SKILL_DIR, rel);
    let text: string;
    try { text = fs.readFileSync(p, "utf8"); }
    catch { throw new Error(`скилл ru-video-brief: нет файла ${rel} (${p}) — проверь .claude/skills/ru-video-brief и outputFileTracingIncludes`); }
    return `<file path="ru-video-brief/${rel}">\n${text.trim()}\n</file>`;
  });
  for (const rel of OPTIONAL_FILES) {
    try { parts.push(`<file path="ru-video-brief/${rel}">\n${fs.readFileSync(path.join(SKILL_DIR, rel), "utf8").trim()}\n</file>`); } catch { /* нет файла — нет контекста */ }
  }
  cachedSkill = parts.join("\n\n");
  return cachedSkill;
}

/** Системные блоки для вызова модели: [скилл (кеш)] + [правила Creative System]. Одинаковы для всех брифов пака → кеш промпта. */
export function ruVideoBriefSystem(extra: string): Anthropic.Messages.TextBlockParam[] {
  const intro = `Ты пишешь брифы на видео-креативы по скиллу ru-video-brief. Ниже — сам скилл: SKILL.md (воркфлоу, гейты), референсы 01–08 и 10, шаблон выдачи. Прочитай и применяй как инструкцию, а не как справку: речевой паспорт до текста, хук по типам с перевесом, реплики как говорят (нормы корпуса), нейтив-фразы из references/04 (5–8 на ролик), ударения по references/08, ноль слов из бан-листа references/07.`;
  return [
    { type: "text", text: `${intro}\n\n${loadRuVideoBriefSkill()}`, cache_control: { type: "ephemeral" } },
    { type: "text", text: extra },
  ];
}
