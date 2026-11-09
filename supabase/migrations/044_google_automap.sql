-- 044 · Прокладка Google → коды формулировок (06.11.2026)
-- Отпечатки картинок (dHash 64 бит) для сопоставления Google-ассетов с размеченными Meta-креативами по визуалу.
create table if not exists creative_fingerprints (
  ad_name     text primary key,
  platform    text not null,              -- meta | google
  kind        text not null,              -- image | video_thumb
  dhash       text,                       -- 16 hex = 64 бита; null при ошибке
  source_url  text,
  error       text,
  computed_at timestamptz default now()
);
create index if not exists idx_creative_fingerprints_platform on creative_fingerprints (platform);
alter table creative_fingerprints enable row level security;
drop policy if exists "allow all" on creative_fingerprints;
create policy "allow all" on creative_fingerprints for all using (true) with check (true);

-- откуда взяты коды Google-креатива: Meta-креатив, с которым совпал визуал (копия), иначе null
alter table ad_name_mapping add column if not exists matched_ad text;
