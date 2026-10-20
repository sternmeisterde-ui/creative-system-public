-- 039: провенанс правок формулировок из брифа (11.10.2026, решение: правка = новая формулировка).
-- parent_code — код формулировки, из которой текст был отредактирован в ТЗ; сама формулировка-родитель не меняется.
alter table formulations add column if not exists parent_code text;
create index if not exists formulations_parent_code_idx on formulations (parent_code) where parent_code is not null;
