-- 040: задания на экспорт ТЗ (Google Doc) — сборка идёт в фоне после ответа, страница /briefs/export опрашивает статус.
-- Причина: синхронный GET /api/briefs/gdoc ждал сборку DOCX + таймкоды Gemini + загрузку в Drive 1–3 минуты и падал 502/пустой вкладкой (16.10.2026).
create table if not exists brief_exports (
  id          uuid primary key default gen_random_uuid(),
  kind        text not null default 'gdoc',          -- gdoc | docx
  brief_id    uuid,
  session_id  uuid,
  status      text not null default 'pending',       -- pending | ready | error
  url         text,
  title       text,
  error       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists brief_exports_created_idx on brief_exports (created_at desc);
