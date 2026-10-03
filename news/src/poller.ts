/**
 * The timer: `news.fetch`, a source in core's sense with no agent in the loop
 * (spec §4.1). Every minute it takes the sources that are due — at most
 * `SOURCES_PER_TICK`, four at a time, one request at a time per host — writes
 * what came, groups the new articles into stories, swaps a few Google News
 * redirects for the outlet's own link, fetches a couple of missing outlet logos, and once a day forgets what is past the retention.
 *
 * The offline contract: feeds keep only their latest items, so a machine that
 * slept a week catches up in one round and keeps the last 72 hours; a feed is
 * read to at most `MAX_ITEMS` items. Nothing here notifies anyone.
 */
import type { BuddiHost, Source } from '@buddi/core/plugin';
import { fetchLogo, fetchSource, FetchError, hostDeclared } from './fetch.js';
import { classifyPending, clusterTopic, regroupOpen, ingest, prune, recordFailure, recordSuccess, type SourceRow, type TopicLink } from './store.js';
import { resolvePending, RESOLVE_PER_TICK } from './resolve.js';
import { starterHosts } from './starter.js';

export const POLL_EVERY_SECONDS = 60;
export const SOURCES_PER_TICK = 8;
export const CONCURRENCY = 4;
export const LOGOS_PER_TICK = 2;
const LOGO_RETRY_MS = 30 * 86_400_000;
/** A kept logo is fetched again after a week (the outlet may have changed it). */
const LOGO_REFRESH_MS = 7 * 86_400_000;
const PRUNE_EVERY_MS = 86_400_000;

let running: Promise<RefreshReport> | null = null;
let declaredOnce = false;
let lastPrune = 0;
let logosMoved = false;
let classified = false;
let regrouped = false;

export interface RefreshReport {
  fetched: number;
  notModified: number;
  failed: number;
  added: number;
  stories: number;
  logos: number;
  /** Google News links resolved to the outlet's own. */
  links: number;
}

/** For tests: forget what this process did. */
export function resetPoller(): void {
  running = null;
  declaredOnce = false;
  lastPrune = 0;
  logosMoved = false;
  classified = false;
  regrouped = false;
}

/**
 * Declare the hosts the manifest cannot know: the owner's own feeds, and the
 * outlets Google News, Hacker News and GDELT named (their logos are fetched
 * from their sites). Runtime declarations last as long as the process, so
 * this runs on the first tick and after each change.
 */
export async function declareRuntimeHosts(buddi: BuddiHost): Promise<void> {
  const known = starterHosts();
  const uses = new Map<string, string>();
  const { rows: sources } = await buddi.db.query<{ url: string; final_url: string | null }>(`select url, final_url from news.sources where added_by = 'owner'`);
  for (const s of sources) {
    for (const address of [s.url, s.final_url]) {
      if (!address) continue;
      const host = new URL(address).hostname;
      if (!hostDeclared(host, known)) uses.set(host, 'A feed you added: the address is asked for its latest items.');
    }
  }
  const { rows: outlets } = await buddi.db.query<{ domain: string }>(`select domain from news.outlets`);
  for (const o of outlets) {
    if (hostDeclared(o.domain, known)) continue;
    uses.set(o.domain, 'An outlet in your news: its site is asked for its icon, once a month at most.');
    uses.set(`*.${o.domain}`, 'An outlet in your news: its site is asked for its icon, once a month at most.');
  }
  if (uses.size > 0) buddi.network.declare([...uses].map(([host, why]) => ({ host, why })));
  declaredOnce = true;
}

/** A redirect may go to a host this plugin declared, in the manifest or since. */
const allowHostFor = (buddi: BuddiHost) => (host: string): boolean =>
  hostDeclared(host, buddi.network.declared().map((d) => d.host));

/** Fetch what is due (or, with `topicId`, every source of that topic now), then cluster and tidy. One at a time. */
export function refresh(buddi: BuddiHost, opts: { topicId?: string; sleep?: (ms: number) => Promise<void> } = {}): Promise<RefreshReport> {
  if (running) return running;
  running = doRefresh(buddi, opts).finally(() => {
    running = null;
  });
  return running;
}

async function doRefresh(buddi: BuddiHost, opts: { topicId?: string; sleep?: (ms: number) => Promise<void> }): Promise<RefreshReport> {
  const report: RefreshReport = { fetched: 0, notModified: 0, failed: 0, added: 0, stories: 0, logos: 0, links: 0 };
  const http = buddi.http;
  if (!http) return report;
  const db = buddi.db;
  if (!declaredOnce) await declareRuntimeHosts(buddi);
  const now = buddi.clock.now();
  // Articles from before 0.2.1 are read for deals once, before anything is clustered.
  if (!classified) classified = (await classifyPending(db)) < 2000;
  if (classified && !regrouped) {
    regrouped = true;
    const language = await buddi.owner.language().catch(() => undefined);
    const { rows: topics } = await db.query<{ id: string }>(`select id from news.topics`);
    let merged = 0;
    for (const t of topics) merged += await regroupOpen(db, t.id, now, language).catch((err) => { buddi.log(`news: could not regroup ${t.id}: ${err instanceof Error ? err.message : String(err)}`); return 0; });
    if (merged > 0) buddi.log(`news: ${merged} open stories joined to the one they tell`);
  }
  const { rows: due } = await db.query<SourceRow>(
    `select s.* from news.sources s
      where not s.muted
        and exists (select 1 from news.topic_sources ts join news.topics t on t.id = ts.topic_id
                     where ts.source_id = s.id and not (t.muted_until is not null and t.muted_until > $1)
                       and ($2::text is null or t.id = $2))
        and ($2::text is not null or (s.next_at <= $1 and s.state <> 'paused'))
      order by s.next_at limit $3`,
    [now, opts.topicId ?? null, opts.topicId ? 200 : SOURCES_PER_TICK],
  );
  const ids = due.map((s) => s.id);
  const { rows: linkRows } = await db.query<TopicLink & { source_id: string }>(
    `select ts.source_id, ts.topic_id, ts.filter, t.keywords from news.topic_sources ts join news.topics t on t.id = ts.topic_id where ts.source_id = any($1)`,
    [ids],
  );
  const touched = new Set<string>();
  const queue = [...due];
  const allowHost = allowHostFor(buddi);
  const worker = async (): Promise<void> => {
    for (let source = queue.shift(); source; source = queue.shift()) {
      const at = buddi.clock.now();
      try {
        const result = await fetchSource(
          http,
          { url: source.final_url ?? source.url, kind: source.kind, name: source.name, language: source.language, etag: source.etag, lastModified: source.last_modified },
          { allowHost, ...(opts.sleep ? { sleep: opts.sleep } : {}) },
        );
        const finalUrl = result.finalUrl ? { finalUrl: result.finalUrl } : {};
        if (result.status === 'not-modified') {
          report.notModified += 1;
          await recordSuccess(db, source, at, { keepValidators: true, ...finalUrl });
          continue;
        }
        report.fetched += 1;
        const links = linkRows.filter((l) => l.source_id === source.id);
        const added = await ingest(db, source, links, result.items, at);
        report.added += added;
        if (added > 0) for (const l of links) touched.add(l.topic_id);
        await recordSuccess(db, source, at, { ...(result.etag ? { etag: result.etag } : {}), ...(result.lastModified ? { lastModified: result.lastModified } : {}), ...finalUrl });
      } catch (err) {
        report.failed += 1;
        const message = err instanceof Error ? err.message : String(err);
        const state = await recordFailure(db, source, at, message, err instanceof FetchError ? err.retryAfterMs : undefined);
        buddi.log(`news: ${source.id} failed (${state}): ${message}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, due.length) }, worker));
  if (touched.size > 0) {
    const language = await buddi.owner.language().catch(() => undefined);
    for (const topicId of touched) report.stories += (await clusterTopic(db, topicId, language)).created;
    await declareRuntimeHosts(buddi);
  }
  report.links = await resolvePending(db, http, now, RESOLVE_PER_TICK, (line) => buddi.log(line), opts.sleep);
  await moveKeptLogos(buddi);
  report.logos = await fetchMissingLogos(buddi, LOGOS_PER_TICK, opts.sleep);
  if (now.getTime() - lastPrune >= PRUNE_EVERY_MS) {
    lastPrune = now.getTime();
    await prune(db, now);
  }
  return report;
}

/**
 * Fetch logos for outlets that have none (spec §4.7) and refresh the ones a
 * week old, the outlets with the most articles first; at most `limit`. Each is
 * kept through the host's assets area (host API 1.27) under the outlet's id,
 * which core re-draws as PNGs and buddi serves; the page never reaches the
 * outlet. A candidate the area refuses (WebP) gives way to the next one. A
 * refresh that finds nothing keeps the logo it had.
 */
export async function fetchMissingLogos(buddi: BuddiHost, limit: number, sleep?: (ms: number) => Promise<void>, onlyOutlet?: string): Promise<number> {
  const http = buddi.http;
  const assets = buddi.assets;
  if (!http || !assets) return 0;
  const db = buddi.db;
  const now = buddi.clock.now();
  const { rows } = await db.query<{ id: string; domain: string; logo_key: string | null }>(
    `select o.id, o.domain, o.logo_key from news.outlets o
      where ($3::text is null or o.id = $3)
        and ((o.logo_key is null and (o.logo_fetched_at is null or o.logo_fetched_at < $1))
          or (o.logo_key is not null and o.logo_fetched_at < $4))
      order by (o.logo_key is null) desc, (select count(*) from news.articles a where a.outlet_id = o.id) desc, o.created_at
      limit $2`,
    [new Date(now.getTime() - LOGO_RETRY_MS), limit, onlyOutlet ?? null, new Date(now.getTime() - LOGO_REFRESH_MS)],
  );
  let saved = 0;
  for (const outlet of rows) {
    const keep = async (logo: { bytes: Buffer; mime: string }): Promise<boolean> => {
      try {
        await assets.put(outlet.id, logo.bytes, logo.mime);
        return true;
      } catch (err) {
        buddi.log(`news: the logo of ${outlet.domain} was not kept: ${err instanceof Error ? err.message : String(err)}`);
        return false;
      }
    };
    const logo = await fetchLogo(http, `https://${outlet.domain}/`, { allowHost: allowHostFor(buddi), keep, ...(sleep ? { sleep } : {}) }).catch(() => null);
    if (logo) saved += 1;
    await db.query(`update news.outlets set logo_key = $2, logo_fetched_at = $3 where id = $1`, [outlet.id, logo ? outlet.id : outlet.logo_key, now]);
  }
  return saved;
}


/**
 * Logos kept by 0.1.0 in the plugin's own table, handed to the assets area
 * once (news 0.2.0): each row is put under its key and deleted; one the area
 * refuses is deleted and its outlet asked again on the next tick.
 */
export async function moveKeptLogos(buddi: BuddiHost): Promise<number> {
  if (logosMoved || !buddi.assets) return 0;
  const db = buddi.db;
  const { rows } = await db.query<{ key: string; mime: string; bytes: Buffer }>(`select key, mime, bytes from news.logos order by key limit 200`);
  let moved = 0;
  for (const row of rows) {
    try {
      await buddi.assets.put(row.key, row.bytes, row.mime);
      moved += 1;
    } catch {
      await db.query(`update news.outlets set logo_key = null, logo_fetched_at = null where logo_key = $1`, [row.key]);
    }
    await db.query(`delete from news.logos where key = $1`, [row.key]);
  }
  if (rows.length < 200) logosMoved = true;
  return moved;
}

export const fetchSourceDefinition: Source = {
  id: 'news.fetch',
  description: 'Fetches the news sources that are due (each every 15 to 30 minutes, backing off when one fails), groups new articles into stories, and fetches missing outlet logos.',
  every: POLL_EVERY_SECONDS,
  async poll(ctx) {
    const buddi = ctx.buddi;
    if (!buddi) return;
    const { rows } = await buddi.db.query<{ n: number }>(`select count(*)::int as n from news.sources where not muted`);
    if ((rows[0]?.n ?? 0) === 0) return; // Nothing to follow yet: a valid state, not a failure.
    const report = await refresh(buddi);
    if (report.fetched + report.failed + report.notModified > 0) {
      buddi.log(`news: ${report.fetched} fetched, ${report.notModified} unchanged, ${report.failed} failed, ${report.added} new, ${report.stories} new stories`);
    }
  },
};
