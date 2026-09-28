-- The account already chosen on Settings → Image becomes a binding
-- (docs/specs/plugin-host-api.md §4.2 `accounts`), once.
--
-- `ctx.buddi.accounts` resolves only a model account the owner bound to this
-- plugin, and choosing one on Settings → Image is what binds it now
-- (`image.set_settings` calls `accounts.bind`). A choice made before that had
-- no binding; this carries it over, so the next picture draws with the same
-- account without the owner choosing it again. The owner made that choice on
-- this plugin's own page, which is exactly what a binding records.
do $$
begin
  if to_regclass('core.plugin_account_bindings') is not null then
    insert into core.plugin_account_bindings (plugin, account_id)
    select 'image', account_id from image.settings where account_id is not null
    on conflict do nothing;
  end if;
end
$$;
