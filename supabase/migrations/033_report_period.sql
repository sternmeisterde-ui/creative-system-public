-- ============================================================
-- Migration 033: отчёт за произвольный период
-- analysis_reports.date_from / date_to — окно дат, за которое собран отчёт
-- (NULL = lifetime по view creative_performance, как раньше).
-- ============================================================
alter table analysis_reports add column if not exists date_from date;
alter table analysis_reports add column if not exists date_to   date;
