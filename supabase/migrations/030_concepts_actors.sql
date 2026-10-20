-- ============================================================
-- Migration 030: две новые оси креатива — КОНЦЕПЦИЯ видео и АКТЁР
--
-- concepts — библиотека концепций (type of video: talking head, UGC, стрит-интервью,
--   скринкаст, 3D-метафора …). Единая таблица на «мировую» библиотеку (всё, что
--   существует в перформанс-видео) и «наши» концепции: is_ours = true у тех, что мы
--   реально запускали; ours_note — как это реализовано у нас. Код V{n}.
-- actors — конкретный актёр в кадре (не персона-описание): реальные люди по имени
--   (ANNA, PETER …) и ИИ-персонажи по кодам WOM{n}/MAN{n}.
-- ad_name_mapping получает concept_code / actor_code — коды подхватывает парсер имён
--   (parseAdNameWithMapping) и бивариат.
-- Имя объявления: P{n}-H{n}-B{n}-A{n}-V{n}-{ACTOR}-FORMAT (концепция и актёр опциональны,
--   старые имена без них парсятся как раньше).
-- ============================================================

create table if not exists concepts (
  id           uuid primary key default gen_random_uuid(),
  code         text unique,                      -- V1, V2, …
  name         text not null,                    -- название по-русски
  name_en      text,                              -- английское название/термин
  category     text,                              -- группа: «Говорящая голова», «UGC», «Интервью», …
  description  text,                              -- что это и как устроено
  when_works   text,                              -- когда и зачем работает, на какую задачу
  example      text,                              -- пример структуры / сцены
  is_ours      boolean not null default false,    -- запускали ли мы такую концепцию
  ours_note    text,                              -- как реализовано у нас (крео-примеры, нюансы)
  color        text,
  created_at   timestamptz not null default now()
);
create index if not exists concepts_is_ours_idx on concepts (is_ours);

create table if not exists actors (
  id             uuid primary key default gen_random_uuid(),
  code           text unique not null,            -- ANNA | PETER | WOM1987 | MAN17645
  name           text not null,                   -- Анна / wom1987
  kind           text not null default 'real' check (kind in ('real','ai')),
  gender         text check (gender in ('f','m') or gender is null),
  description    text,                            -- внешность, возраст, типаж, манера
  reference_url  text,                            -- кадр-референс (Storage)
  notes          text,                            -- где снимался, что сработало
  created_at     timestamptz not null default now()
);

alter table ad_name_mapping add column if not exists concept_code text;
alter table ad_name_mapping add column if not exists actor_code   text;
create index if not exists ad_name_mapping_concept_idx on ad_name_mapping (concept_code);
create index if not exists ad_name_mapping_actor_idx   on ad_name_mapping (actor_code);

-- RLS: как у остальных библиотечных таблиц (чтение с anon для клиентских страниц,
-- запись через service role). Если у personas RLS выключен — политики не нужны.
alter table concepts enable row level security;
alter table actors   enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where tablename = 'concepts' and policyname = 'concepts_read') then
    create policy concepts_read on concepts for select using (true);
  end if;
  if not exists (select 1 from pg_policies where tablename = 'concepts' and policyname = 'concepts_write') then
    create policy concepts_write on concepts for all using (true) with check (true);
  end if;
  if not exists (select 1 from pg_policies where tablename = 'actors' and policyname = 'actors_read') then
    create policy actors_read on actors for select using (true);
  end if;
  if not exists (select 1 from pg_policies where tablename = 'actors' and policyname = 'actors_write') then
    create policy actors_write on actors for all using (true) with check (true);
  end if;
end $$;
