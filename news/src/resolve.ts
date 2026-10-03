/**
 * A Google News item's own link (news 0.2.1). Google News links every item
 * through `news.google.com/rss/articles/<id>`, which no longer redirects: the
 * page carries a signature, and Google's own decoder answers the outlet's
 * address for it. So: one GET of the page (following any redirect, ten
 * seconds, 1 MB at most), one POST to the decoder, and the answer kept on the
 * article. An old-style id that holds the address itself is read without
 * asking anything. When it fails the redirect stays, marked `unresolved`, and
 * is not asked again.
 *
 * A few items a tick, newest first, so a first fetch of a busy search does
 * not hold the timer up.
 */
import type { BuddiHost, HttpArea } from '@buddi/core/plugin';
import { canonicalUrl } from './canonical.js';
import { politeGet, politePost } from './fetch.js';
import { isDeal } from './text.js';

type Db = BuddiHost['db'];

export const GNEWS_HOST = 'news.google.com';
export const RESOLVE_PER_TICK = 8;
export const RESOLVE_PAGE_MAX_BYTES = 1024 * 1024;
/** Items older than this keep their redirect: nobody opens them any more. */
export const RESOLVE_WINDOW_MS = 48 * 3600_000;
/** How long an edition waits for its picks' links. */
export const RESOLVE_BUDGET_MS = 25_000;
const DECODER = `https://${GNEWS_HOST}/_/DotsSplashUi/data/batchexecute`;

/** The item id of a Google News article link, or null for any other address. */
export function googleNewsId(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.hostname !== GNEWS_HOST) return null;
  const m = /^\/(?:rss\/)?articles\/([A-Za-z0-9_-]+)$/.exec(u.pathname);
  return m ? m[1]! : null;
}

/** An outlet's address, as kept: http(s), not Google's own, canonical. Null for anything else. */
export function outletLink(candidate: string): string | null {
  let u: URL;
  try {
    u = new URL(candidate);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (/(^|\.)google\.[a-z.]+$/i.test(u.hostname) || /(^|\.)gstatic\.com$/i.test(u.hostname)) return null;
  return canonicalUrl(u.toString());
}

/** The address an old-style id holds in its bytes (`CBMi…` with the URL inside), or null for the new style. */
export function decodeOffline(id: string): string | null {
  let bytes: Buffer;
  try {
    bytes = Buffer.from(id, 'base64url');
  } catch {
    return null;
  }
  const text = bytes.toString('latin1');
  if (text.includes('AU_yqL')) return null;
  const m = /https?:\/\/[\x21-\x7e]+/.exec(text);
  return m ? outletLink(m[0]) : null;
}

/** The page's signature and timestamp, which the decoder asks for. */
export function signatureOf(html: string): { ts: string; sg: string } | null {
  const sg = /data-n-a-sg="([^"]+)"/.exec(html)?.[1];
  const ts = /data-n-a-ts="(\d+)"/.exec(html)?.[1];
  return sg && ts ? { ts, sg } : null;
}

/** The decoder's form body for one id. */
export function decoderBody(id: string, sig: { ts: string; sg: string }): string {
  const inner = JSON.stringify([
    'garturlreq',
    [['X', 'X', ['X', 'X'], null, null, 1, 1, 'US:en', null, 1, null, null, null, null, null, 0, 1], 'X', 'X', 1, [1, 1, 1], 1, 1, null, 0, 0, null, 0],
    id,
    Number(sig.ts),
    sig.sg,
  ]);
  return `f.req=${encodeURIComponent(JSON.stringify([[['Fbv4je', inner, null, 'generic']]]))}`;
}

/** The outlet's address in the decoder's answer, or null. */
export function parseDecoder(text: string): string | null {
  const body = text.replace(/^\)\]\}'\s*/, '');
  try {
    const outer = JSON.parse(body) as unknown[];
    for (const entry of outer) {
      if (!Array.isArray(entry) || entry[0] !== 'wrb.fr' || typeof entry[2] !== 'string') continue;
      const inner = JSON.parse(entry[2]) as unknown[];
      if (inner[0] === 'garturlres' && typeof inner[1] === 'string') return outletLink(inner[1]);
    }
  } catch {
    // Not the shape it was: fall back to finding the address in the text.
  }
  const m = /garturlres\\?",\\?"(https?:[^"\\]+)/.exec(body);
  return m ? outletLink(m[1]!) : null;
}

/** The outlet's own address for a Google News link, or null when it could not be had. */
export async function resolveGoogleNews(http: HttpArea, url: string, opts: { sleep?: (ms: number) => Promise<void> } = {}): Promise<string | null> {
  const id = googleNewsId(url);
  if (!id) return null;
  const offline = decodeOffline(id);
  if (offline) return offline;
  const { response, url: landed } = await politeGet(http, url, {
    maxBytes: RESOLVE_PAGE_MAX_BYTES,
    headers: { accept: 'text/html' },
    // Off Google, the redirect is the answer: the outlet is not asked.
    stopAt: (next) => next.hostname !== GNEWS_HOST,
    ...(opts.sleep ? { sleep: opts.sleep } : {}),
  });
  // A redirect that led off Google is the answer itself.
  if (new URL(landed).hostname !== GNEWS_HOST) return outletLink(landed);
  if (!response.ok) return null;
  const sig = signatureOf(await response.text());
  if (!sig) return null;
  const answer = await politePost(http, DECODER, decoderBody(id, sig), opts.sleep ? { sleep: opts.sleep } : {});
  if (!answer.ok) return null;
  return parseDecoder(await answer.text());
}

/**
 * Resolve these rows' links, one after another, until `deadline`: the
 * outlet's address replaces the redirect in `url` (and in `url_canonical`,
 * unless another row already has it), and an address in an outlet's deals
 * section makes it a deal; a failure keeps the redirect, marked. Writing is
 * best effort (an export reads on a read-only pool): the answer is the
 * addresses found, by article id.
 */
async function resolveRows(
  db: Db, http: HttpArea, rows: Array<{ id: string; url: string; title: string }>, now: Date,
  opts: { log?: (line: string) => void; sleep?: (ms: number) => Promise<void>; deadline?: number },
): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  for (const row of rows) {
    if (opts.deadline !== undefined && Date.now() >= opts.deadline) break;
    let link: string | null = null;
    try {
      link = await resolveGoogleNews(http, row.url, opts.sleep ? { sleep: opts.sleep } : {});
    } catch (err) {
      opts.log?.(`news: could not resolve a Google News link: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (link) found.set(row.id, link);
    try {
      if (link) {
        await db.query(
          `update news.articles set url = $2, link_state = 'resolved', link_tried_at = $3,
             url_canonical = case when exists (select 1 from news.articles o where o.url_canonical = $2 and o.id <> $1) then url_canonical else $2 end,
             kind = case when $4 then 'deal' else kind end
           where id = $1`,
          [row.id, link, now, isDeal(row.title, link)],
        );
      } else {
        await db.query(`update news.articles set link_state = 'unresolved', link_tried_at = $2 where id = $1`, [row.id, now]);
      }
    } catch {
      // A read-only pool: the address is still used for this answer.
    }
  }
  return found;
}

/** Resolve the newest Google News links not tried yet, at most `limit`. Answers how many were resolved. */
export async function resolvePending(db: Db, http: HttpArea, now: Date, limit = RESOLVE_PER_TICK, log: (line: string) => void = () => undefined, sleep?: (ms: number) => Promise<void>): Promise<number> {
  const { rows } = await db.query<{ id: string; url: string; title: string }>(
    `select id, url, title from news.articles
      where link_state is null and url like 'https://news.google.com/%' and published_at > $1
      order by published_at desc limit $2`,
    [new Date(now.getTime() - RESOLVE_WINDOW_MS), limit],
  );
  return (await resolveRows(db, http, rows, now, { log, ...(sleep ? { sleep } : {}) })).size;
}

/**
 * Resolve, now, the links of these articles not tried yet (an edition's
 * picks), within `budgetMs`: an edition links the outlet even when the timer
 * has not reached them. Answers the addresses found, by article id.
 */
export async function resolveNow(db: Db, http: HttpArea, articleIds: string[], now: Date, budgetMs = RESOLVE_BUDGET_MS): Promise<Map<string, string>> {
  if (articleIds.length === 0) return new Map();
  const { rows } = await db.query<{ id: string; url: string; title: string }>(
    `select id, url, title from news.articles where id = any($1) and link_state is null and url like 'https://news.google.com/%'`,
    [articleIds],
  );
  return resolveRows(db, http, rows, now, { deadline: Date.now() + budgetMs });
}
