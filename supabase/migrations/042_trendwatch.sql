-- 042 — Трендвотчинг конкурентов (trendwatch/): Tier 1 / Tier 2, правила отбора,
-- шорт-лист, разметка Gemini, решения человека. Таблицы с префиксом tw_.

create table if not exists tw_companies (
  id               uuid primary key default gen_random_uuid(),
  name             text not null unique,
  tier             int  not null check (tier in (1, 2)),
  list_source      text,                        -- holding | ua_edtech | de_edtech
  domains          text[] not null default '{}',
  meta_page_ids    text[] not null default '{}',
  ads_library_urls text[] not null default '{}',
  region           text,
  notes            text,
  active           boolean not null default true,
  created_at       timestamptz not null default now()
);

create table if not exists tw_runs (
  id          serial primary key,
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  note        text,
  stats       jsonb
);

-- Объявление = одна копия креатива в Ads Library.
create table if not exists tw_ads (
  ad_archive_id    text primary key,
  company_id       uuid not null references tw_companies(id) on delete cascade,
  page_id          text,
  page_name        text,
  is_active        boolean,
  start_date       date,
  end_date         date,
  collation_id     text,
  collation_count  int,
  display_format   text,
  title            text,
  body_text        text,
  link_url         text,
  cta_text         text,
  media_kind       text,                        -- video | image
  media_url        text,
  media_id         text,                        -- стабильный id ассета из URL fbcdn
  creative_key     text not null,
  eu_total_reach   bigint,
  reach_fetched_at timestamptz,
  first_seen_run   int,
  last_seen_run    int,
  raw              jsonb
);
create index if not exists tw_ads_company_idx  on tw_ads (company_id);
create index if not exists tw_ads_creative_idx on tw_ads (creative_key);

-- Креатив = склейка копий одного визуала и текста внутри компании.
create table if not exists tw_creatives (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references tw_companies(id) on delete cascade,
  creative_key    text not null unique,
  copies          int  not null default 1,
  first_start     date,
  last_end        date,
  days_active     int,                          -- объединение интервалов копий, до сегодня
  calendar_span   int,                          -- от первого старта до последнего показа
  is_active       boolean,
  restart         boolean not null default false,
  reach           bigint,                       -- сумма eu_total_reach по копиям
  reach_copies    int  not null default 0,
  media_kind      text,
  media_url       text,
  media_id        text,
  storage_path    text,
  storage_url     text,
  display_format  text,
  title           text,
  body_text       text,
  link_url        text,
  cta_text        text,
  sample_ad_id    text,
  -- отбор
  tier            int,
  rule            text,                         -- reach | days
  multiplier      numeric,                      -- к медиане компании
  grid_status     text not null default 'none', -- none | candidate | strong | priority | winner
  shortlisted     boolean not null default false,
  shortlisted_run int,
  -- разметка Gemini
  analysis        jsonb,
  analyzed_at     timestamptz,
  concept_code    text,
  concept_new     text,
  -- концепции и решение
  repeat_gate     text,                         -- yes | no
  decision        text,                         -- auto | take | skip
  decision_comment text,
  decided_by      text,
  decided_at      timestamptz,
  recheck         jsonb,
  exported_at     timestamptz,
  export_note     text,
  updated_at      timestamptz not null default now()
);
create index if not exists tw_creatives_company_idx on tw_creatives (company_id);
create index if not exists tw_creatives_short_idx   on tw_creatives (shortlisted) where shortlisted;
create index if not exists tw_creatives_concept_idx on tw_creatives (concept_code) where concept_code is not null;

create table if not exists tw_company_stats (
  company_id   uuid not null references tw_companies(id) on delete cascade,
  run_id       int  not null references tw_runs(id) on delete cascade,
  ads          int,
  creatives    int,
  median_days  numeric,
  median_reach numeric,
  reach_sample int,
  computed_at  timestamptz not null default now(),
  primary key (company_id, run_id)
);

create or replace view tw_concept_counts as
  select concept_code,
         count(*)                    as creatives,
         count(distinct company_id)  as companies
    from tw_creatives
   where shortlisted and concept_code is not null
   group by concept_code;

alter table tw_companies     enable row level security;
alter table tw_runs          enable row level security;
alter table tw_ads           enable row level security;
alter table tw_creatives     enable row level security;
alter table tw_company_stats enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where tablename='tw_creatives' and policyname='tw_creatives_read') then
    create policy tw_creatives_read on tw_creatives for select using (true);
  end if;
  if not exists (select 1 from pg_policies where tablename='tw_companies' and policyname='tw_companies_read') then
    create policy tw_companies_read on tw_companies for select using (true);
  end if;
end $$;

insert into storage.buckets (id, name, public) values ('tw-media', 'tw-media', true)
  on conflict (id) do nothing;

-- 16.10.2026 (синк 1): порядок выдачи в интерфейсе
alter table tw_creatives add column if not exists grid_rank int generated always as
  (case grid_status when 'winner' then 4 when 'priority' then 3 when 'strong' then 2 when 'candidate' then 1 else 0 end) stored;
create index if not exists tw_creatives_order_idx on tw_creatives (shortlisted, grid_rank desc, reach desc nulls last, days_active desc);
