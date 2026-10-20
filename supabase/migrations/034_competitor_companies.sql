-- ============================================================
-- Migration 034: competitor_companies — единый список конкурентов и компаний, за которыми следим
--
-- Источники (склеены по имени/домену, 30.09.2026):
--   holding_pages  — страницы Meta из «Холдинги — Ad Activity & Funnels» (бренд = домен воронки)
--   edtech_top100   — «ТОП-100 EdTech онлайн-школ мира» (сайт + Meta Ads Library page ids)
--   trendwatcher    — рекламодатели по теме из trendwatcher/data/trendwatcher.db (профориентация, DE)
--   seed_google     — посев рекламодателей Google Transparency из trendwatcher/config.yaml
-- Метрики tw_* — из трендвотчера (релевантных крео, winners, winner+strong, макс. охват/дни).
-- ============================================================

create table if not exists competitor_companies (
  id               uuid primary key default gen_random_uuid(),
  key              text unique not null,          -- служебный ключ склейки
  name             text not null,
  aliases          text[] not null default '{}',
  groups           text[] not null default '{}',  -- holding_pages | edtech_top100 | trendwatcher | seed_google
  region           text,
  website          text,
  domains          text[] not null default '{}',
  meta_page_ids    text[] not null default '{}',
  ads_library_urls text[] not null default '{}',
  funnel_links     text[] not null default '{}',
  pages            text[] not null default '{}',  -- имена страниц Meta [статус]
  categories       text[] not null default '{}',  -- категории трендвотчера
  tw_sources       text[] not null default '{}',
  tw_relevant      integer not null default 0,
  tw_winners       integer not null default 0,
  tw_strong        integer not null default 0,
  tw_max_reach     bigint  not null default 0,
  tw_max_days      integer not null default 0,
  active_pages     integer not null default 0,
  priority         text not null default 'watch', -- core | watch | archive
  notes            text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists idx_competitor_companies_groups on competitor_companies using gin (groups);
alter table competitor_companies enable row level security;
create policy "allow all" on competitor_companies for all using (true) with check (true);
