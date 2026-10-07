-- Remember the owner’s first-run model choice. Existing configured installations stay open.
alter table settings add column if not exists meaning_setup_done boolean not null default false;
update settings set meaning_setup_done = true where exists (select 1 from sources);
