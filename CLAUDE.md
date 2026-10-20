# Creative System — карта проекта для AI-агента

Этот файл читает Claude Code при работе с репозиторием. Бизнес-контекст (продукт, аудитория, факты, голос бренда) —
только в `brief.config.ts`; сюда — архитектура и правила кода.

**Что уже заложено в архитектуру (без дат и истории):**
- Параметр креатива = уникальная дословная формулировка с неизменяемым кодом (`lib/formulations.ts`, таблица `formulations`): персона / хук / боди / энгл; любое отличие текста = новая формулировка. Правка текста в брифе = новая формулировка с `parent_code` (`/api/briefs/reformulate`).
- Пак = дизайн эксперимента (`lib/pack-engine.ts`): семьи виннера (меняется ровно одна ось), масштабирование HELPS-формулировок, разведка концепций, перенос между медиа; детерминированно, на последнем отчёте продукта (`lib/report-context.ts`). Персона в слоте только от донора или как варьируемая ось.
- Брифы пишутся скиллом `.claude/skills/ru-video-brief`: `lib/ru-video-brief.ts` читает SKILL.md + референсы + шаблон в системный промпт `/api/ai/generate-briefs` (кеш), поверх — правила из `brief.config.ts` (`product_facts`) и правила редактора; `lib/param-overlap.ts` гасит смысловой дубль параметров; гейт — `lib/speech-lint.ts`.
- ТЗ (бриф + референсы) — DOCX и Google Docs (`lib/brief-docx.ts`, `lib/gdrive.ts`); референс параметра = фрагмент видео-донора по Gemini-таймкодам (`lib/param-timings.ts`).
- Каналы Meta / Google / TikTok и продукты разведены: `components/ChannelContext.tsx`, `lib/product.ts` (токены продуктов — поправь под свои).
- PostgREST режет выборки на 1000 строк: `lib/paged.ts → fetchAll()`.

Creative System — внутренний инструмент производства рекламных креативов (Meta Ads, Google Ads, каркас TikTok). Цель: сократить цикл от гипотезы до запущенного объявления, автоматизировать генерацию брифов и анализ результатов.

**Деплой**: Vercel (см. README-DEPLOY.md)
**Запуск локально**: `npm run dev` → http://localhost:3000

---

## Стек
- **Frontend**: Next.js 16 App Router, TypeScript, inline styles (без CSS-модулей, без Tailwind в коде)
- **Backend**: Next.js API Routes (`app/api/**/route.ts`)
- **БД**: Supabase (PostgreSQL) — URL проекта в `NEXT_PUBLIC_SUPABASE_URL`
- **AI** (обновлено 30.09.2026): Anthropic SDK — `claude-opus-5-5` для разбора отчёта и субъективного анализа (разбор недели, документ «Что делаем»); `claude-fable-5-1` для конструктора (пак и перегенерация слота), сценариев и брифов; `claude-sonnet-4-6` остался в служебных роутах (рекомендации, инсайты конкурентов, классификация импорта)
- **Генерация контента**: Higgsfield API (`platform.higgsfield.ai`), auth: заголовки `hf-api-key` + `hf-secret`
- **Аналитика**: Meta Marketing API v21.0 + Elly (Plurio) по SSE
- **Алерты**: Telegram Bot API
- **Цветовая палитра**: `#E8AA42` (золото), `#6EC8A0` (зелёный), `#D96B6B` (красный), `#48B8D0` (голубой), `#C490D1` (фиолетовый), `#FF8B5A` (оранжевый)
- **Фон приложения**: `#08090D`

---

## Страницы и их назначение

| Путь | Назначение |
|------|-----------|
| `/` | Дашборд — статус системы, метрики, быстрые действия |
| `/library` | Библиотека формулировок — уникальные дословные параметры (персона/хук/боди/энгл) с кодами, концепции видео и актёры |
| `/admin` | Правила адаптации для генерации брифов |
| `/builder` | Конструктор — панель ограничений эксперимента (формат, размер, разведка концепций, блок-лист) + предпросмотр пака движка и история паков; тот же компонент `NextPack`, что и раздел «Следующий пак» в отчёте |
| `/briefs` | Брифы — генерация через Claude, аппрув, публикация |
| `/creatives` | Готовые крео — статус генерации Higgsfield, управление |
| `/panel` | Live-панель Meta Ads — CPL/CPQL, алерты, статус пакета |
| `/report` | Отчёт по массиву: канал из сайдбара + **период** (весь период = lifetime по view; пресеты 7/30 дней, этот/прошлый месяц, свой диапазон = окно дат через `lib/window-rows.ts` + Elly за окно; бивариат/комбо считаются по строкам окна через `lib/bivariate.ts` / `lib/combinations.ts`; `analysis_reports.date_from/date_to`, миграция 033; в окне нет age/ROAS/fake_winner). Сборка окна 2–4 мин (`maxDuration=300`) |
| `/weekly` | **Субъективный анализ крео** — понедельные снапшоты по всем крео + человеческая/AI-оценка |
| `/analytics` | Аналитика — параметры, комбинации, история, **бивариативный анализ** |
| `/mapping` | Маппинг объявлений — коды формулировок: Gemini выписывает текст по файлу (по одному / пачкой) или ручной выбор по тексту |
| `/competitors` | База конкурентов — импорт из Sheets, AI-инсайты |
| `/analyze` | Анализ креативов через Gemini Vision |
| `/pbi` | Загрузка данных PBI (лиды, квал. лиды, выручка) |
| `/database` | Прямой браузер Supabase таблиц |
| `/feedback` | Обратная связь по брифам |

---

## Производственный цикл (10 шагов)

```
1. Библиотека    → формулировки (уникальные дословные тексты параметров) + заметки к ним
2. Правила       → настроить правила адаптации в /admin
3. Конструктор   → пак слотов из формулировок на последнем отчёте продукта
4. Брифы         → генерация по методике ru-video-brief (гейт-линтер речи), авто-публикация
5. Публикация    → имена объявлений из кодов формулировок (MP…-MH…-MB…-MA…-V{n}-FORMAT)
   (вкладка «Сценарии» убрана 07.10.2026: формулировка = готовый текст параметра; заметка к параметру — formulations.note)
7. Генерация     → создать видео/статику через Higgsfield
8. Запуск        → вручную запустить в Meta Ads Manager
9. Мониторинг    → /panel — CPL/CPQL, алерты в Telegram
10. Анализ       → /analytics бивариативный → новые гипотезы → шаг 4
```

### Понедельный субъективный цикл (`/weekly`) — основа для шторма
Параллельная петля «данные → картина → решения → ТЗ», заменяет ручной разбор в Google Sheets:
```
1. Собрать неделю   → снапшот всех крео за пн–вс (spend/hook из Meta, лиды/квал из Plurio за окно)
2. Смотреть крео    → превью (резолвер /api/meta/thumb) + видео в лайтбоксе (/api/meta/video)
3. Разобрать        → Gemini вытаскивает параметры из СОДЕРЖАНИЯ (формат/персона/хук/энгл/боди), кеш по ad_name
4. Разбор недели    → Claude: паттерны + «над чем штормить» на уровне пачки (объективные агрегаты в коде)
5. «Что делаем?»    → команда фиксирует действие по каждому крео → собирается в «Ту-ду недели»
6. Документ         → Claude сводит всё в один markdown-док направлений → скачать .md → ТЗ на крео
```
Логика: система даёт объективную картину → команда добавляет субъективку → готовый вход для брифов. Превью/видео Meta протухают → всегда резолвятся на лету, не хранятся.

---

## Нейминг объявлений

Формат (с 06.10.2026): `{MP|BP}……-{MH|BH}……-{MB|BB}……-{MA|BA}……-V{n}-{ACTOR}-FORMAT` — коды формулировок (6 цифр), персона опциональна; концепция V и актёр — опциональны; старые имена `P2-H1-B3-A5-UGC-COM` парсер понимает.

Пример: `MP483920-MH120394-MB558201-MA903311-V19-ANNA-UGC`

- **P** = Персона (дословное обращение), **H** = Хук, **B** = Боди, **A** = Энгл — каждый код = одна уникальная дословная формулировка (`formulations`)
- **V** = Концепция видео (type of video: talking head, UGC, стрит-интервью, скринкаст, 3D-метафора…) — таблица `concepts`, мировая библиотека ~120 кодов (`data/world_concepts.json`, сид `scripts/seed-concepts.py`), флаг `is_ours` у тех, что мы запускали
- **ACTOR** = конкретный человек в кадре — таблица `actors`: реальные по имени (`ANNA`, `PETER`…, список для парсера в `brief.config.ts → real_actor_codes`), ИИ-персонажи по кодам `WOM{n}` / `MAN{n}`
- **FORMAT**: `UGC`, `STATIC`, `ANIMATION`, `HUMAN`, `MIXED`
- Для старых крео концепция и актёр живут в `ad_name_mapping.concept_code / actor_code` (миграция 030); бивариат и параметры считают их как отдельные оси
- **Критерии виннера**: CPL ≤ cpl_target + CPQL ≤ cpql_target + показы ≥ min_impressions_for_status (таблица `app_settings`)
- Парсинг/сборка: `lib/naming.ts` → `parseAdName()`, `buildAdName()`
- Маппинг нестандартных имён: таблица `ad_name_mapping`

---

## База данных (Supabase)

### Основные таблицы
| Таблица | Назначение |
|---------|-----------|
| `formulations` | **Формулировки (038)** — code (MH483920/BA102938), axis, product, text (дословно), text_key, source, legacy_code, first_ad_name, note; unique(axis, product, text_key) |
| `personas` / `hooks` / `bodies` / `angles` | Архив прежней библиотеки категорий (до 06.10.2026) — только чтение старых брифов |
| `constructor_sessions` | Сессии конструктора — selectedPersonas[], selectedHooks[], etc. |
| `scenarios` | Устарела (вкладка убрана 07.10.2026), таблица осталась без потребителей |
| `briefs` | Брифы — sessionId, paramIds, adaptedContent, fullBrief, status |
| `creatives` | Готовые крео — personaId, hookId, bodyId, angleId, format, metaAdId |
| `rules` | Правила адаптации для промтов |
| `meta_ads` | Данные Meta API — upsert по unique(adId, date) |
| `pbi_metrics` | Данные PBI — leads, qualLeads, revenue по adId |
| `ad_name_mapping` | Коды формулировок объявления (persona/hook/body/angle_code) + concept_code, actor_code, product, mapped_by/mapped_at, legacy_* (старые групповые коды) |
| `concepts` | Концепции видео (V{n}): мировая библиотека + is_ours/ours_note |
| `actors` | Актёры: code (ANNA / WOM1987), kind real/ai, gender, description, reference_url |
| `competitor_concepts` | Концепты конкурентов — source, rawData, status |
| `competitor_companies` | **Компании и конкуренты, за которыми следим** (миграция 034, 30.09.2026): список компаний из импорта (страницы Meta, сайты, рекламодатели по теме); поля groups[], meta_page_ids[], funnel_links[], tw_* метрики, priority core/watch/archive, notes. Вкладка «🏢 Компании» на `/competitors` (`app/competitors/Companies.tsx`). Источник правды — эта таблица |
| `creative_alerts` | Алерты — alertType, dismissed |
| `creative_generations` | Записи генераций Higgsfield |
| `weekly_creative_reports` | Понедельные снапшоты субъективного анализа — week_start/end, rows[] (замороженные метрики per-крео), summary (AI-разбор недели, 027), summary_note (шторм команды, 027), document (итоговый док «Что делаем», 029) |
| `weekly_creative_notes` | Оценка per-крео в снапшоте — note (человек) + ai_note (Gemini) + todo («Что делаем?», 028), грань (report_id, ad_id) |

### Ключевые views
- `creative_performance` — объединяет `meta_ads` + `pbi_metrics`, вычисляет CPL, CPQL, `auto_status` (winner/loser/testing/unknown)

### Клиенты Supabase
- `lib/supabase.ts` → `supabase` (anon, клиент) / `createServiceClient()` (service role, сервер)
- На API routes **всегда** использовать `createServiceClient()`

---

## API Routes

### AI
| Роут | Назначение |
|------|-----------|
| `POST /api/ai/generate-briefs` | Генерация брифов через Claude Opus (streaming) |
| `POST /api/ai/recommend` | Рекомендации параметров |
| `POST /api/ai/analyze-performance` | Анализ результатов через Claude |
| `POST /api/ai/competitor-insights` | AI-инсайты по топ-20 конкурентам (параллельные запросы) |
| `POST /api/ai/competitor-hypothesis` | Гипотезы по одобренным концептам |

### Генерация (Higgsfield)
| Роут | Назначение |
|------|-----------|
| `POST /api/creative-gen/generate` | Одиночная генерация (фото/видео) |
| `GET /api/creative-gen/status` | Поллинг статуса генерации |
| `POST /api/creative-gen/generate-scenes` | Мульти-сцена видео |
| `POST /api/creative-gen/generate-voices` | Войсовер |
| `POST /api/creative-gen/lipsync-scenes` | Lip-sync |
| `POST /api/creative-gen/stitch-scenes` | Склейка сцен |

### Google Ads (грейн — креатив)
| Роут | Назначение |
|------|-----------|
| `POST /api/google/sync` | Спенд/показы/клики по КРЕАТИВАМ (lifetime, полная замена `platform='google'`): `google:asset:<id>` — картинка/YouTube PMax (`asset_group_asset` с метриками, API v25), `google:ad:<id>` — объявление Search/Demand Gen/Video, `google:rest:<campaignId>` — остаток кампании без крео. Заодно пишет каталог превью в `meta_creatives` |
| `POST /api/google/crm-sync` | Лиды/квал/выручка из Elly (source=google) → по крео: Search/DG по AdId напрямую, PMax — CRM-лиды кампании пропорционально конверсиям Google (оценка). Логика — `lib/google-creatives.ts` |
| `POST /api/google/assets` | Алиас синка для кнопки на `/mapping/google` |

- Имя крео = `asset <id> · имя файла / заголовок YouTube` — ключ маппинга P·H·B·A и джойна лидов.
- Ролики YouTube у рекламы unlisted → Gemini их по ссылке не читает. `scripts/google-video-backfill.py` (локально, yt-dlp) кладёт mp4 в Storage `creatives/google/`, синк ссылку сохраняет; `/api/gemini/batch` описывает только скачанные.

### TikTok Ads (грейн — объявление)
| Роут | Назначение |
|------|-----------|
| `POST /api/tiktok/sync` | Спенд/показы/клики/видео-метрики по ОБЪЯВЛЕНИЯМ (Marketing API v1.3 `report/integrated/get`, `query_lifetime`, полная замена `platform='tiktok'`): ключ `tiktok:ad:<id>`, ad_name = имя объявления; каталог превью в `meta_creatives` (cover + временный preview_url mp4). video_plays=video_play_actions, video_3s=video_watched_2s, video_thruplay=video_watched_6s. Логика — `lib/tiktok.ts` |
| `POST /api/tiktok/crm-sync` | Лиды/квал/выручка из Elly (`SourceGroupName='TikTok'`, AdId+AdName заполнены) → `pbi_metrics` с ключами `tiktok:%` (миграция 032 включила их во view), джойн с крео по имени объявления. Проверен 29.09.2026: 127 строк |

- Активация: `TIKTOK_ACCESS_TOKEN` (long-lived токен приложения TikTok for Business Marketing API, scope Ads Management + Reporting) + `TIKTOK_ADVERTISER_ID` в env Vercel — **несколько кабинетов через запятую** (`id1,id2`; один токен, авторизованный на оба; синк обходит все, `account_id` строки = кабинет); без них `/api/tiktok/sync` отдаёт 503, канал в UI помечен «не активен». Опционально `TIKTOK_API_URL` (sandbox). Имена метрик API взяты из документации — при первом живом синке сверить ответ.
- Недельный срез `/weekly` для TikTok берёт отчёт за окно дат напрямую из API (не lifetime) + Elly source=tiktok. Gemini-разбор перед описанием берёт свежий preview_url (старые протухают).
- Кроны: 07:30 sync, 08:30 crm-sync (vercel.json).

### Аналитика
| Роут | Назначение |
|------|-----------|
| `GET /api/analytics/report/docx?id=` | Отчёт по массиву в DOCX (библиотека `docx`): шапка продукт·канал·период, проверка Gemini+Codex, KPI, HELPS/HURTS, hook rate, семьи, комбо, конкуренты, нарратив markdown→Word (заголовки, списки, таблицы). Кнопка «📄 Скачать DOCX» на `/report` |
| `GET /api/analytics/params` | Агрегация по кодам параметров (`?platform=`) |
| `GET /api/analytics/combinations` | Комбинации пар параметров |
| `GET /api/analytics/lineage` | Генеалогия сессий |
| `GET /api/analytics/bivariate` | **Бивариативный анализ** (split + семьи), `?platform=` |
| `GET /api/analytics/pack-health` | Здоровье пакета (доля виннеров) |
| `POST /api/analytics/early-stop` | Рекомендации по остановке |
| `GET/POST /api/analytics/weekly` | Понедельный снапшот по каналу (`platform` в теле/квери, default meta; google = только Google API + Elly source=google; all = оба): POST берёт spend/показы/клики/hook из meta_ads за окно, **лиды/квал — из Plurio за то же окно** (`syncElly(weekStart,weekEnd)`, т.к. дневной истории лидов в БД нет), join meta_creatives (фильтр по ad_id/имени — не вся таблица), GET листает/отдаёт. `maxDuration=300` |
| `POST /api/analytics/weekly/note` | Сохранение субъективной заметки (note) и/или «Что делаем?» (todo) раздельно / генерация AI-разбора (Gemini flash) |
| `POST /api/analytics/weekly/document` | Итоговый док «Что делаем»: Claude сводит todo + разбор недели + шторм + параметры в один markdown-документ направлений → ТЗ (колонка document) |

### Meta / Данные
| Роут | Назначение |
|------|-----------|
| `POST /api/meta/sync` | Синхронизация данных из Meta API |
| `POST /api/meta/creatives` | Ингест ассетов крео (thumbnail/image/video_id) для превью и Gemini — обходит com+gov+смешанный кабинет (`META_AD_ACCOUNT_ID_MIXED`), с пагинацией |
| `GET /api/meta/video?videoId=` | 302 на свежий CDN-mp4 (`resolveMetaVideoSource`) — для просмотра видео-крео (source временный, резолвим по клику) |
| `GET /api/meta/thumb?adId=` | 302 на свежий thumbnail/image крео из Graph — превью Meta протухают за дни (403), поэтому НЕ хранятся, резолвятся на лету по ad_id |
| `POST/GET /api/gemini/params` | Структурный разбор крео на параметры (формат/персона/хук/энгл/боди/чем силён/над чем штормить) через `analyzeCreativeParams`; кеш в `gemini_analyses(creative_params)` по ad_name; GET отдаёт карту для /weekly |
| `POST /api/analytics/weekly/summary` | Сводный разбор недели: агрегаты в коде + Claude синтезирует паттерны по параметрам («над чем штормить» на уровне пачки); generate → summary, note → summary_note |
| `POST /api/meta/pause` | Остановка объявлений через API |
| `POST /api/pbi/upload` | Загрузка данных PBI |
| `POST /api/pbi/elly-sync` | Синхронизация с Elly (Plurio) по SSE |
| `GET /api/pbi/stats` | Статистика PBI |

### Алерты
- `POST /api/alerts/check` — проверка лузеров, отправка в Telegram
- Логика: `lib/alert-check.ts`
- Типы: `cpl_spike`, `pack_dying`, `winner_found`, `loser_detected`
- Активное объявление = спенд ≥ €1 за последний день

---

## Бивариативный анализ (`/analytics` → таб "Бивариативный")

Метод: split-test на наблюдательных данных.
- **X** = бинарный признак (код параметра, format, flow)
- **Y** = blended CPL = SUM(spend)/SUM(leads) по группе
- **Ratio** = CPL(X=1) / CPL(X=0)
- **Вердикт**: `< 0.75` → HELPS · `> 1.33` → HURTS · иначе → NEUTRAL
- Минимум 3 лида в каждой группе, иначе INSUFFICIENT

**Слой 1 — Параметрический split**: роут `GET /api/analytics/bivariate`
**Слой 2 — Семьи (генеалогия)**: группировка по 3 из 4 кодов, 4-й варьируется. Фильтр: спенд ≥ €20 на члена семьи.

---

## Интеграции

### Meta Marketing API
- Версия: v21.0
- Кабинеты: env `META_AD_ACCOUNT_ID_COM` / `META_AD_ACCOUNT_ID_GOV` (+ опционально `META_AD_ACCOUNT_ID_MIXED`)
- Токен: `process.env.META_ACCESS_TOKEN`

### Higgsfield API
- Base URL: `platform.higgsfield.ai`
- Auth: два заголовка `hf-api-key` + `hf-secret`
- Статика (`static`) → text-to-image (nano-banana-v2 и др.)
- Видео (все остальные) → text-to-video (kling-2.6-pro и др.)
- Модели: `lib/higgsfield-models.ts`

### Финальный монтаж — локальный ffmpeg-воркер
- Бэкенд монтажа выбирается env-флагом `MONTAGE_BACKEND` (`local` по умолчанию | `creatomate` fallback).
- **local**: `auto-advance`, когда все сцены залипсинкены, ставит группе `status='ready_montage'`
  (Creatomate НЕ вызывается). Локальный `scripts/montage-worker.mjs` (Node, на Mac, как `pack-poll.sh`)
  забирает такие группы и собирает видео по рецептам скилла `.claude/skills/video-montage`:
  CFR-нормализация 1080×1920@30 → concat → пословные субтитры из `word_timestamps` → BGM → QA → `final_url`.
- Субтитры — **PNG-overlay** (Pillow `gen_text_overlay.py` + ffmpeg `overlay ... enable`), а НЕ libass:
  homebrew-сборка ffmpeg идёт без libass/drawtext. PNG короткими входами + `setpts`-сдвиг (≈1 мин на ролик).
- Запуск: `npm run montage` (поллинг) или `npm run montage:once`. Финал → Storage bucket `scene-final`.
- Авто-запуск на Mac: LaunchAgent `scripts/launchd/com.example.creative-system.montage-worker.plist` (см. `scripts/launchd/README.md`) — крутится фоном, рестартует при падении. Логи: `~/Library/Logs/montage-worker.{out,err}.log`.
- Конфиг env: `MONTAGE_FONT` (impact/helvetica), `MONTAGE_BGM_VOLUME` (нужен `assets/bgm/default.mp3`),
  `MONTAGE_UNIQUIFY` (анти-фингерпринт для репостов), `MONTAGE_MAX_WORDS`, `MONTAGE_POLL_SECONDS`.
- Статусы группы: `… → lipsync → ready_montage → montaging → done | error`.

### Elly (Plurio) — сквозная аналитика
- SSE-подключение через `POST /api/pbi/elly-sync`
- Подтягивает leads, qualLeads, revenue по adId

### Telegram Bot
- Токен: `process.env.TELEGRAM_BOT_TOKEN`
- Chat ID: `process.env.TELEGRAM_CHAT_ID`
- Алерты: лузеры, выгорание пакета, виннеры

### Конкуренты
- Импорт из Google Sheets: `POST /api/competitors/sheets` → `POST /api/competitors/import`
- Автоматизация: n8n + Apify → webhook `POST /api/competitors/import`
- AI-классификация типа концепта при импорте

---

## Ключевые файлы

| Файл | Что там |
|------|---------|
| `lib/types.ts` | Все доменные типы |
| `lib/store.ts` | Data layer — CRUD обёртки над Supabase |
| `lib/naming.ts` | Парсинг/сборка имён объявлений (коды формулировок + старый формат) |
| `lib/formulations.ts` | Формулировки: textKey, коды, ensureFormulation, loadLabelMap, applyExtraction |
| `lib/param-lookup.ts` | id параметра брифа/крео → код + текст (formulations, fallback — старые таблицы) |
| `scripts/sql.mjs` | SQL к Supabase через Management API (миграции: `node scripts/sql.mjs --file …`) |
| `lib/alert-check.ts` | Логика алертов + Telegram |
| `lib/higgsfield-models.ts` | Реестр моделей Higgsfield |
| `lib/supabase.ts` | Supabase клиенты |
| `scripts/montage-worker.mjs` | Локальный ffmpeg-воркер финального монтажа (MONTAGE_BACKEND=local) |
| `.claude/skills/video-montage/` | Скилл монтажа (SKILL.md + gen_subs.py / gen_text_overlay.py) |
| `components/ui.tsx` | Дизайн-система: Card, Button, Badge, Modal, PageHeader и др. |
| `components/Sidebar.tsx` | Навигация |
| `components/AppShell.tsx` | Лейаут |
| `.env.local` | Все секреты (никогда не коммитить) |

---

## Правила кода

- Строгая типизация TypeScript, никаких `any`
- API routes: всегда `createServiceClient()` (service role)
- Инлайн стили везде (не CSS-модули, не Tailwind классы)
- Функции ≤ 50 строк, файлы ≤ 800 строк
- Нет `console.log` в production
- Не добавлять фичи "на будущее", только то что нужно сейчас
- Prefer editing existing files over creating new ones


---

## Правила живой речи (ru-reels, с 28.09.2026)

Брифы и voice-over генерируются с блоком правил живой русской речи, извлечённых из корпуса 5027 русскоязычных рилсов
с речью живых людей (проект `ru-reels`, правила v1.1 в `ru-reels/rules/`).

- `lib/speech-rules.ts` — `SPEECH_RULES_BLOCK` (полный, для сценариев/брифов) и `SPEECH_RULES_VOICE_BLOCK` (короткий, для монологов 25–35 слов и ElevenLabs), `SPEECH_BAN_WORDS`, `SPEECH_PREFER_MAP`, `STRESS_HINTS`. Данные: `lib/speech-rules.json` (копия `ru-reels/rules/rules.json`).
- Вставлено в промпты: `app/api/ai/generate-briefs` (видео-формат; с 07.10.2026 бриф собирается по формату скилла ru-video-brief и проходит гейт `lib/speech-lint.ts`), `app/api/creative-gen/generate-voices` (extractDialogue → ElevenLabs; в репликах ставятся ударения U+0301 и немецкие термины кириллицей).
- Ключевые нормы: медиана реплики 6 слов, 2–3 заполнителя на 100 слов, «я» присутствует, один адресат (ты/вы), хук ≤ 12 слов без приветствия и анонса, призыв — комментарий/подписка/директ (не ссылка, не «сохрани»), ноль причастий и триад, бан книжных/ИИ-слов.
- Ручная работа и проверка: скилл `.claude/skills/ru-video-brief` (SKILL.md + линтер `scripts/check_brief.py`, справка `lookup.py`, референсы `inspire.py`). Скрипты запускать python из `ru-reels/.venv`.
- Обновление после новой отсечки корпуса: `ru-reels/analysis/update_all.sh "<label>" "<note>"` → скопировать `rules/rules.json` в `lib/speech-rules.json` и в `.claude/skills/ru-video-brief/references/`, при необходимости поправить текст блока в `lib/speech-rules.ts`.
- Решение бизнеса (28.09.2026): мягкий разговорный сленг разрешён и желателен (прям, реально, круто, кайф, норм, окей, блин, капец, жесть, база, огонь); исключены мат, жёсткий молодёжный сленг (кринж, краш, вайб) и анекдоты. Зафиксировано в `brief.config.ts` → `brand_voice.style_notes`.
