-- news 0.2.4: the clustering rules' version the open stories were grouped by.
-- When the plugin's `CLUSTER_RULES` is past it, the first tick groups the last
-- 48 hours' open stories again once and records the new version here.
alter table settings add column if not exists cluster_rules integer not null default 0;
