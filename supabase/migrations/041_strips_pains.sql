-- 041 · Приоритет Single pain в стрипах: оценка 1–10 и логика, почему такой приоритет (правят люди; по умолчанию — по доле сегмента).
create table if not exists strips_pains (
  product    text not null check (product in ('med','buh')),
  pain_key   text not null,
  pain       text,
  priority   int check (priority between 1 and 10),
  rationale  text,
  set_by     text, updated_at timestamptz not null default now(),
  primary key (product, pain_key)
);
alter table strips_pains enable row level security;
drop policy if exists strips_pains_all on strips_pains; create policy strips_pains_all on strips_pains for all using (true) with check (true);
