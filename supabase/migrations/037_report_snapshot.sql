-- ============================================================
-- Migration 037: снапшот строк отчёта — основа для конструктора
-- analysis_reports.snapshot jsonb: { thresholds, rows: [{ad_name, auto_status, spend, cpl, cpql, leads, qual_leads, roas, risk_signals}] }
-- Конструктор → сценарии → брифы строятся на ПОСЛЕДНЕМ отчёте продукта, а не на живом view:
-- иначе пак опирался бы на другой набор виннеров/лузеров, чем тот, что человек принял в отчёте.
-- ============================================================
alter table analysis_reports add column if not exists snapshot jsonb;
