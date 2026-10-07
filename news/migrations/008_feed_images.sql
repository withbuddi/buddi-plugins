alter table news.articles add column image_url text;
alter table news.articles add column image_caption text;
alter table news.articles add column image_credit text;
alter table news.articles add column image_key text;
alter table news.articles add column image_checked_at timestamptz;
-- Re-read feeds once to populate images on articles we already know.
update news.sources set etag = null, last_modified = null, next_at = now();
