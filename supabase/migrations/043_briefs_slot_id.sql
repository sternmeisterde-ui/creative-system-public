-- 21.10.2026: бриф привязан к слоту пака. Дедупликация «догенерировать недостающие» шла по четырём кодам формулировок,
-- слоты с одинаковыми формулировками и разной концепцией (разведка V101/V103/V104) схлопывались в один бриф.
alter table briefs add column if not exists slot_id integer;
create index if not exists briefs_session_slot_idx on briefs (session_id, slot_id);
