-- Credit terms: what each card reports, when it reports it, and the
-- utilization that card is supposed to land at.
--
-- The closing day already exists. `liabilities.statement_day` (003) IS the
-- statement CLOSING day — the day the issuer snapshots the balance it sends to
-- the bureaus — so nothing new is added for it here; a second column for the
-- same fact is two answers to one question. What was missing is the rest:
--
--   reports_day        the day the snapshot actually reaches the bureaus. It is
--                      usually a few days after the close and the owner rarely
--                      knows it, so it is nullable: null means "assume it is
--                      the closing day", which is the conservative reading.
--   utilization_target the percentage THIS card should report, in percent.
--                      Cards are not interchangeable — a 1,000 limit at 30% is
--                      300, and an owner rebuilding a thin file may want the
--                      one card with history under 10 and the rest under 30 —
--                      so the target is per card, overriding the installation
--                      default kept in `preferences` under 'utilization_target'.
--
-- `credit_scores` gains `bureau` and `source` as two separate facts, because
-- they are two: the bureau is what the score is ABOUT (Experian, Equifax,
-- TransUnion) and the source is where the owner read it (Credit Karma, the
-- card's own app). They shared one column until now, so the old value is
-- carried into `bureau` and nothing already recorded is lost.

alter table credit_scores add column if not exists bureau text;
alter table credit_scores add column if not exists source text;

-- Whatever was in the one column was, in practice, the bureau.
update credit_scores set bureau = bureau_or_source where bureau is null;

-- Kept and still written, so anything reading the old column keeps working.
alter table credit_scores alter column bureau_or_source drop not null;

create index if not exists credit_scores_bureau_idx
  on credit_scores (bureau, observed_on desc);

alter table liabilities add column if not exists reports_day int null;
alter table liabilities add column if not exists utilization_target numeric(5, 2) null;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'liabilities_reports_day_check'
  ) then
    alter table liabilities
      add constraint liabilities_reports_day_check
      check (reports_day is null or reports_day between 1 and 31);
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'liabilities_utilization_target_check'
  ) then
    alter table liabilities
      add constraint liabilities_utilization_target_check
      check (utilization_target is null or (utilization_target > 0 and utilization_target <= 100));
  end if;
end $$;

-- The installation default, 30%, as a preference the owner can move once.
insert into preferences (key, value) values ('utilization_target', '30'::jsonb)
  on conflict (key) do nothing;
