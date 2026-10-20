-- ============================================================
-- Migration 035: продукт (Бухгалтер / Медадмин) в отчётах и недельных срезах
-- product: 'all' | 'buchhalter' | 'medadmin' — по какому продукту собран отчёт/неделя.
-- ad_name_mapping.product — явное переопределение эвристики lib/product.ts для конкретного имени.
-- ============================================================
alter table analysis_reports add column if not exists product text not null default 'all';
alter table weekly_creative_reports add column if not exists product text not null default 'all';
drop index if exists uq_weekly_reports_window;
create unique index if not exists uq_weekly_reports_window on weekly_creative_reports (platform, product, week_start, week_end);
alter table ad_name_mapping add column if not exists product text;
