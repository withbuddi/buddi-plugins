-- speech: "Languages you speak" replaces the one language hint.
--
-- `listen_languages` holds ISO 639-1 codes, at most eight; empty lets the
-- service detect any. A stored hint that is already a code moves over here;
-- a name ("French") is read by the plugin as a one-element list until the
-- next save writes the list and clears `listen_language`.
alter table settings add column if not exists listen_languages text[] not null default '{}'
  check (cardinality(listen_languages) <= 8);

update settings
   set listen_languages = array[lower(substring(trim(listen_language) from '^([A-Za-z]{2})(?:[-_][A-Za-z0-9]{2,8})*$'))],
       listen_language = null
 where listen_language is not null
   and trim(listen_language) ~ '^[A-Za-z]{2}([-_][A-Za-z0-9]{2,8})*$'
   and cardinality(listen_languages) = 0;
