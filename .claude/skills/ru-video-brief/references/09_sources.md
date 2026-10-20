# Источники и данные (где лежит полная версия)

Корень данных: `~/ru-reels/`

| Что | Путь | Использование в скилле |
|---|---|---|
| Полные правила v1.1 (9 документов) | `rules/00_README.md … 08_stress.md`, `rules/rules.json` | references/ — их копия; при расхождении главнее `rules/` |
| Индекс корпуса (5027 роликов) | `data/corpus.jsonl` | `scripts/lookup.py corpus "<фраза>"` — реальные примеры употребления с ссылкой на ролик |
| Аудио корпуса | `data/audio/*.m4a` | референсы интонации для диктора (по shortCode) |
| Разборы Gemini по роликам | `data/analysis/llm/*.json` | `scripts/inspire.py` — хуки по типу, фразы по функции |
| Сводный лист фактов | `data/analysis/facts.md` | когда нужна цифра, которой нет в references |
| Ударения (896 тыс. форм, Викисловарь) | `data/analysis/lang/stress.json` | `scripts/lookup.py stress <слово>`, автопроверка в `check_brief.py` |
| Ожегов–Шведова: пометы регистра | `data/analysis/lang/ozhegov_marks.json` | `scripts/lookup.py register <слово>`; лint книжной лексики |
| Частотник письменной нормы (НКРЯ 2011) | `data/analysis/lang/freq_written.json` | сравнение «речь vs письмо» |
| Полный текст Ожегова | `lang/raw/ozhegov.txt` | толкование слова: `scripts/lookup.py define <слово>` |
| Классика (29 книг пользователя, ~2.4 млн слов) | `lang/user/classics/*.txt` | `scripts/lookup.py classic "<фраза>"` — как оборот звучит у Чехова, Гоголя, Достоевского; референс ритма диалога |
| Обновление правил после новой отсечки | `analysis/update_all.sh "<label>" "<note>"` | перегенерирует rules/ → скопировать в references/ |

Смежные скиллы проекта:
- `hooks-from-competitors` — паттерны хуков конкурентов из Ads Library.
- `adlib-recon` — разбор рекламы конкурентов.
