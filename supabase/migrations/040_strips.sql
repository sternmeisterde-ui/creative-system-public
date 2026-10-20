-- 040 · Стрипы: хуки и тела креативов как элементы, которые команда правит, оценивает и ведёт по статусам (14.10.2026).
-- Источник — мультиагентная система strips/ (агент 1 джобы → агент 2 хуки → агент 3 тело). Код формулировки Creative System
-- (formulations.code) присваивается при выборе: точное совпадение текста → существующий код, иначе новый; правка = новая формулировка с parent_code.
create table if not exists strips_items (
  id            uuid primary key default gen_random_uuid(),
  product       text not null check (product in ('med','buh')),
  kind          text not null check (kind in ('hook','body')),
  pain_key      text not null,                 -- BP-ti-pi из strips_<product>.json
  big_problem   text, topic text, segment text, segment_share numeric,
  pain          text not null,
  original_text text not null,                 -- как написал агент
  text          text not null,                 -- текущая версия после правок людей
  first_frame   text,
  formula       text, formula_name text, pattern_source text,
  agent_version text,                          -- v3-fable-pero …
  hook_id       uuid references strips_items(id), -- для тела: из какого хука собрано
  status        text not null default 'new' check (status in ('new','chosen','brief','test','winner','dropped')),
  gates         jsonb not null default '{}'::jsonb,   -- {real:true|false|null, brand:…, compliant:…, before_after:…}
  score_avg     numeric, score_n int not null default 0,
  cs_code       text,                          -- код формулировки Creative System
  edited_by     text, edited_at timestamptz,
  created_at    timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (product, kind, pain_key, original_text)
);
create index if not exists strips_items_product_idx on strips_items (product, kind, status);
create table if not exists strips_scores (
  id        uuid primary key default gen_random_uuid(),
  item_id   uuid not null references strips_items(id) on delete cascade,
  voter     text not null,
  score     int check (score between 1 and 10),
  gates     jsonb not null default '{}'::jsonb,
  comment   text,
  created_at timestamptz not null default now(),
  unique (item_id, voter)
);
create table if not exists strips_edits (
  id        uuid primary key default gen_random_uuid(),
  item_id   uuid not null references strips_items(id) on delete cascade,
  editor    text, before text, after text, field text not null default 'text',
  created_at timestamptz not null default now()
);
alter table strips_items enable row level security; alter table strips_scores enable row level security; alter table strips_edits enable row level security;
drop policy if exists strips_items_all on strips_items;  create policy strips_items_all  on strips_items  for all using (true) with check (true);
drop policy if exists strips_scores_all on strips_scores; create policy strips_scores_all on strips_scores for all using (true) with check (true);
drop policy if exists strips_edits_all on strips_edits;  create policy strips_edits_all  on strips_edits  for all using (true) with check (true);
