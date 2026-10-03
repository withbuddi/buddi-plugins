-- The Google sign-in card (calendar 0.3.1).
--
-- The card on Settings → Calendar finishes by itself when Google's answer
-- reaches buddi, so a sign-in is kept a little after it ends, to say how it
-- went: `finished_note` once the account is kept ("Signed in as …"), or
-- `problem` when Google refused or the calendars could not be read. A new
-- sign-in, Done or Cancel removes the row; so does its ten minutes running out.
alter table google_sign_in add column if not exists finished_note text;
alter table google_sign_in add column if not exists problem text;
