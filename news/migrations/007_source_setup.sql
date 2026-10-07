-- An explicit custom-source choice survives reloads; configured sources finish setup.
alter table settings add column if not exists custom_source_setup boolean not null default false;
