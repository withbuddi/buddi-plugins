-- Mark paid (the Money page's Coming up): the last occurrence of a recurring
-- item the owner said is already paid. Occurrences on or before it are left out
-- of Coming up, the cash-flow projection and a card's statement forecast, so a
-- bill paid early is not spent a second time on its due date.
alter table recurring_items add column if not exists paid_through date null;
