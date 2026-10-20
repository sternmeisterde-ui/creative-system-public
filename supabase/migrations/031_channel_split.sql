-- ============================================================
-- Migration 031: разделение каналов (Meta / Google / TikTok)
--
-- У каждого канала — свой цикл, отчёт и субъективный анализ, плюс общий дашборд.
-- analysis_reports.platform — канал отчёта ('meta' | 'google' | 'tiktok' | 'all');
--   старые снапшоты считались по всему массиву → 'all'.
-- weekly_creative_reports.platform — канал недельного среза; старые срезы были
--   по Meta (Google туда попал только в один срез 14–20.09, он пересобирается).
--   Уникальность окна теперь на (platform, week_start, week_end).
-- ============================================================

alter table analysis_reports add column if not exists platform text not null default 'all';
create index if not exists analysis_reports_platform_idx on analysis_reports (platform, created_at desc);

alter table weekly_creative_reports add column if not exists platform text not null default 'meta';
drop index if exists uq_weekly_reports_window;
create unique index if not exists uq_weekly_reports_window on weekly_creative_reports (platform, week_start, week_end);
