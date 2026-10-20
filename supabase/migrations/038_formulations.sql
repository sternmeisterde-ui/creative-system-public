-- 038 · Формулировки (06.10.2026)
-- Параметр креатива = ДОСЛОВНАЯ уникальная формулировка со своим неизменяемым кодом.
-- Группировка в категории (CS2 / MH1 / MB3 / MA1 …) отменена: любое отличие в тексте = новый параметр.
-- Код: {продукт}{ось}{6 цифр} — M/B (Медадмин/Бухгалтер) + P/H/B/A, напр. MH483920, BA102938.

create table if not exists formulations (
  id            uuid primary key default gen_random_uuid(),
  code          text not null unique,
  axis          text not null check (axis in ('persona','hook','body','angle')),
  product       text not null check (product in ('buchhalter','medadmin')),
  text          text not null,                 -- дословно, как в креативе
  text_key      text not null,                 -- NFC + trim + схлопнутые пробелы (только для поиска точного совпадения)
  source        text not null default 'manual',-- gemini | gemini-quotes | manual | brief
  legacy_code   text,                          -- старый групповой код, из которого мигрирован (только провенанс, в аналитике не используется)
  first_ad_name text,                          -- где впервые встречена
  note          text,
  created_at    timestamptz not null default now(),
  unique (axis, product, text_key)
);
create index if not exists formulations_axis_product_idx on formulations (axis, product);
alter table formulations enable row level security;
drop policy if exists formulations_all on formulations;
create policy formulations_all on formulations for all using (true) with check (true);

-- Маппинг: старые групповые коды сохраняем в legacy_* (провенанс), фиксируем кто и когда разметил.
alter table ad_name_mapping
  add column if not exists legacy_persona_code text,
  add column if not exists legacy_hook_code    text,
  add column if not exists legacy_body_code    text,
  add column if not exists legacy_angle_code   text,
  add column if not exists mapped_by           text,
  add column if not exists mapped_at           timestamptz;
update ad_name_mapping
   set legacy_persona_code = persona_code, legacy_hook_code = hook_code,
       legacy_body_code = body_code, legacy_angle_code = angle_code
 where legacy_persona_code is null and legacy_hook_code is null and legacy_body_code is null and legacy_angle_code is null
   and (persona_code is not null or hook_code is not null or body_code is not null or angle_code is not null);

-- Брифы и крео теперь ссылаются на formulations.id; старые строки держат id прежних таблиц → жёсткие FK снимаем.
alter table briefs    drop constraint if exists briefs_persona_id_fkey,    drop constraint if exists briefs_hook_id_fkey,
                      drop constraint if exists briefs_body_id_fkey,       drop constraint if exists briefs_angle_id_fkey;
alter table creatives drop constraint if exists creatives_persona_id_fkey, drop constraint if exists creatives_hook_id_fkey,
                      drop constraint if exists creatives_body_id_fkey,    drop constraint if exists creatives_angle_id_fkey;
