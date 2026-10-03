/**
 * Fetching, politely (spec §4.1): every request through the host's `http`
 * area (the address guard, the shared transport), with a ten-second
 * deadline, a 2 MB cap and a conditional GET when the feed gave an ETag or a
 * Last-Modified; one request at a time to a host, a second after the last
 * (GDELT six, as it asks for five); a 429 and its Retry-After obeyed; the
 * redirects the transport does not follow, followed here, three at most, and
 * only to a host this plugin declared (or the same site).
 *
 * Each kind of source comes back as the same items: an RSS or Atom feed, a
 * Google News search (whose items name the outlet), Hacker News's front page
 * through Algolia, or a GDELT article list.
 */
import type { HttpArea, HttpResponse } from '@buddi/core/plugin';
import { decodeBytes, parseDate, parseFeed, plainText, clip, type FeedItem } from './feed.js';
import { outletHost } from './canonical.js';
import type { Language, SourceKind } from './starter.js';
import { VERSION } from './version.js';

export const USER_AGENT = `buddi-news/${VERSION} (+https://withbuddi.com/news)`;
export const FEED_MAX_BYTES = 2 * 1024 * 1024;
export const REQUEST_TIMEOUT_MS = 10_000;
export const IDLE_TIMEOUT_MS = 10_000;
export const MAX_ITEMS = 200;
export const HN_MIN_POINTS = 100;
export const HOST_GAP_MS = 1_000;
/** Hosts with their own gap: GDELT states one request per five seconds. */
export const HOST_GAPS: Record<string, number> = { 'api.gdeltproject.org': 6_000 };
const MAX_REDIRECTS = 3;

export interface FetchedItem extends FeedItem {
  /** Who wrote it, as the item names it (Google News, GDELT, Hacker News's link); empty for a publisher's own feed. */
  outletName: string;
  /** The outlet's domain, `lemonde.fr`; empty when unknown. */
  outletHost: string;
  language: Language;
  guid?: string;
}

export type FetchResult =
  | { status: 'ok'; items: FetchedItem[]; etag?: string; lastModified?: string; siteLink?: string; finalUrl?: string }
  | { status: 'not-modified'; finalUrl?: string };

/** A fetch that failed with a reason worth keeping on the source. */
export class FetchError extends Error {
  constructor(message: string, readonly httpStatus?: number, readonly retryAfterMs?: number) {
    super(message);
    this.name = 'FetchError';
  }
}

/** When each host may next be asked, and the request in flight to it: kept for the life of the process. */
const nextAllowed = new Map<string, number>();
const inFlight = new Map<string, Promise<unknown>>();

/** Wait until this host may be asked again, then book the next slot. */
export async function politeWait(host: string, now: () => number = Date.now, sleep = defaultSleep): Promise<void> {
  const gap = HOST_GAPS[host] ?? HOST_GAP_MS;
  const at = nextAllowed.get(host) ?? 0;
  const t = now();
  const start = Math.max(t, at);
  nextAllowed.set(host, start + gap);
  if (start > t) await sleep(start - t);
}

/** Run `fn` when no other request to `host` is in flight: one at a time per host. */
async function oneAtATime<T>(host: string, fn: () => Promise<T>): Promise<T> {
  const before = inFlight.get(host) ?? Promise.resolve();
  const mine = before.catch(() => undefined).then(fn);
  inFlight.set(host, mine);
  try {
    return await mine;
  } finally {
    if (inFlight.get(host) === mine) inFlight.delete(host);
  }
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** For tests: forget every host's slot. */
export function resetPoliteness(): void {
  nextAllowed.clear();
  inFlight.clear();
}

/** `example.co.uk` for `feeds.example.co.uk`, `lemonde.fr` for `www.lemonde.fr`: the site a host belongs to, near enough. */
export function siteOf(host: string): string {
  const labels = host.toLowerCase().split('.');
  const twoPart = /^(co|com|org|net|gov|ac)\.[a-z]{2}$/.test(labels.slice(-2).join('.'));
  return labels.slice(twoPart ? -3 : -2).join('.');
}

/** Whether a host is in a declared list (`host` or `*.domain`). */
export function hostDeclared(host: string, declared: readonly string[]): boolean {
  const h = host.toLowerCase();
  return declared.some((d) => (d.startsWith('*.') ? h.endsWith(d.slice(1)) : h === d.toLowerCase()));
}

export interface GetOptions {
  headers?: Record<string, string>;
  maxBytes?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Whether a redirect may go to this host; same site always may. Absent, any host may. */
  allowHost?: (host: string) => boolean;
}

/** GET with a deadline, the host's turn, and redirects followed by hand. `permanent` is where a 301 or 308 led. */
export async function politeGet(http: HttpArea, url: string, options: GetOptions = {}): Promise<{ response: HttpResponse; url: string; permanent?: string }> {
  let at = url;
  let permanent: string | undefined;
  let allPermanent = true;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const host = new URL(at).hostname;
    const response = await oneAtATime(host, async () => {
      await politeWait(host, Date.now, options.sleep);
      return http.request({
        url: at,
        method: 'GET',
        headers: { 'user-agent': USER_AGENT, accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, application/json;q=0.9, */*;q=0.5', ...options.headers },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        idleTimeoutMs: IDLE_TIMEOUT_MS,
        maxBytes: options.maxBytes ?? FEED_MAX_BYTES,
      });
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      if (!location) throw new FetchError(`answered ${response.status} without saying where`, response.status);
      const next = new URL(location, at);
      if (next.protocol !== 'https:' && next.protocol !== 'http:') throw new FetchError('redirected somewhere that is not the web');
      if (siteOf(next.hostname) !== siteOf(host) && options.allowHost && !options.allowHost(next.hostname)) {
        throw new FetchError(`redirected to ${next.hostname}, which this plugin has not declared`);
      }
      allPermanent &&= response.status === 301 || response.status === 308;
      at = next.toString();
      if (allPermanent) permanent = at;
      continue;
    }
    return { response, url: at, ...(permanent ? { permanent } : {}) };
  }
  throw new FetchError(`redirected more than ${MAX_REDIRECTS} times`);
}

/** Milliseconds a Retry-After asks for: seconds or an HTTP date; undefined when absent or unreadable. */
export function retryAfterMs(value: string | null, now: number = Date.now()): number | undefined {
  if (!value) return undefined;
  if (/^\d+$/.test(value.trim())) return Number(value.trim()) * 1000;
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

function failed(response: HttpResponse): FetchError {
  const reason = `answered ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`;
  return new FetchError(reason, response.status, response.status === 429 || response.status === 503 ? retryAfterMs(response.headers.get('retry-after')) : undefined);
}

export interface SourceToFetch {
  url: string;
  kind: SourceKind;
  name: string;
  language: Language;
  etag?: string | null;
  lastModified?: string | null;
}

export interface FetchOptions {
  sleep?: (ms: number) => Promise<void>;
  allowHost?: (host: string) => boolean;
}

/** Fetch one source and read its items. Throws `FetchError` (or the transport's error) on failure. */
export async function fetchSource(http: HttpArea, source: SourceToFetch, options: FetchOptions = {}): Promise<FetchResult> {
  const headers: Record<string, string> = {};
  if (source.etag) headers['if-none-match'] = source.etag;
  if (source.lastModified) headers['if-modified-since'] = source.lastModified;
  const { response, url, permanent } = await politeGet(http, source.url, { headers, ...options });
  const moved = permanent ? { finalUrl: permanent } : {};
  if (response.status === 304) return { status: 'not-modified', ...moved };
  if (!response.ok) throw failed(response);
  const etag = response.headers.get('etag') ?? undefined;
  const lastModified = response.headers.get('last-modified') ?? undefined;
  const bytes = new Uint8Array(await response.arrayBuffer());
  const validators = { ...(etag ? { etag } : {}), ...(lastModified ? { lastModified } : {}), ...moved };
  if (source.kind === 'gdelt') return { status: 'ok', items: readGdelt(bytes), ...validators };
  if (source.kind === 'hn') return { status: 'ok', items: readHackerNews(bytes), ...validators };

  const text = decodeBytes(bytes, response.headers.get('content-type'));
  let feed;
  try {
    feed = parseFeed(text, url, MAX_ITEMS);
  } catch (err) {
    throw new FetchError(err instanceof Error ? err.message : String(err));
  }
  const items = feed.items.map((item): FetchedItem => {
    if (source.kind === 'gnews') {
      // Google News's description is the title again with the outlet's name: no lead.
      return { ...item, summary: '', outletName: item.outlet?.name ?? '', outletHost: item.outlet?.url ? outletHost(item.outlet.url) : '', language: source.language };
    }
    return { ...item, outletName: '', outletHost: '', language: source.language };
  });
  return { status: 'ok', items, ...validators, ...(feed.link ? { siteLink: feed.link } : {}) };
}

interface AlgoliaHit {
  objectID?: string;
  title?: string;
  url?: string | null;
  points?: number;
  created_at_i?: number;
  story_text?: string | null;
}

/** Hacker News's front page through Algolia: stories with at least `HN_MIN_POINTS` points; the discussion when there is no link. */
export function readHackerNews(bytes: Uint8Array): FetchedItem[] {
  let body: { hits?: AlgoliaHit[] };
  try {
    body = JSON.parse(new TextDecoder('utf-8').decode(bytes)) as { hits?: AlgoliaHit[] };
  } catch {
    throw new FetchError('Hacker News answered something that is not JSON');
  }
  const items: FetchedItem[] = [];
  for (const hit of body.hits ?? []) {
    if (!hit.title || !hit.objectID || (hit.points ?? 0) < HN_MIN_POINTS) continue;
    const discussion = `https://news.ycombinator.com/item?id=${hit.objectID}`;
    const url = hit.url || discussion;
    const host = hit.url ? outletHost(hit.url) : 'news.ycombinator.com';
    items.push({
      title: plainText(hit.title),
      url,
      summary: hit.story_text ? clip(plainText(hit.story_text)) : '',
      publishedAt: hit.created_at_i ? new Date(hit.created_at_i * 1000) : null,
      categories: [],
      outletName: hit.url ? host : 'Hacker News',
      outletHost: host,
      language: 'en',
      guid: discussion,
    });
  }
  return items.slice(0, MAX_ITEMS);
}

interface GdeltArticle {
  url?: string;
  title?: string;
  seendate?: string;
  domain?: string;
  language?: string;
}

/** GDELT's article list: `{ articles: [{ url, title, seendate: 20261003T051500Z, domain, language }] }`. */
export function readGdelt(bytes: Uint8Array): FetchedItem[] {
  const text = new TextDecoder('utf-8').decode(bytes).trim();
  if (!text.startsWith('{')) throw new FetchError(text ? `GDELT said: ${clip(text, 120)}` : 'GDELT answered nothing');
  let body: { articles?: GdeltArticle[] };
  try {
    body = JSON.parse(text) as { articles?: GdeltArticle[] };
  } catch {
    throw new FetchError('GDELT answered something that is not JSON');
  }
  const items: FetchedItem[] = [];
  for (const a of (body.articles ?? []).slice(0, MAX_ITEMS)) {
    if (!a.url || !a.title) continue;
    const language: Language | undefined = a.language === 'French' ? 'fr' : a.language === 'English' ? 'en' : undefined;
    if (!language) continue;
    const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(a.seendate ?? '');
    const host = (a.domain ?? outletHost(a.url)).replace(/^www\./, '');
    items.push({
      title: plainText(a.title),
      url: a.url,
      summary: '',
      publishedAt: m ? new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!)) : parseDate(a.seendate),
      categories: [],
      outletName: host,
      outletHost: host,
      language,
    });
  }
  return items;
}

/* ------------------------------------------------------------------ *
 * Logos
 * ------------------------------------------------------------------ */

export const LOGO_MAX_BYTES = 256 * 1024;
const PAGE_MAX_BYTES = 512 * 1024;

export interface Logo {
  bytes: Buffer;
  mime: string;
  url: string;
}

/** The icon links of a page, best first: apple-touch-icon, then a sized icon, then any icon. */
export function iconLinks(html: string, base: string): string[] {
  const found: Array<{ href: string; score: number }> = [];
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0];
    const rel = /\brel\s*=\s*["']?([^"'>]+)/i.exec(tag)?.[1]?.toLowerCase() ?? '';
    const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    if (!href || !/\b(icon|apple-touch-icon(-precomposed)?)\b/.test(rel)) continue;
    if (/\.svg(\?|$)/i.test(href) || /image\/svg/i.test(tag)) continue;
    const size = Number(/\bsizes\s*=\s*["']?(\d+)x\d+/i.exec(tag)?.[1] ?? 0);
    const score = (rel.includes('apple-touch-icon') ? 1000 : 0) + (size >= 32 && size <= 256 ? size : size > 256 ? 50 : 16);
    try {
      found.push({ href: new URL(href, base).toString(), score });
    } catch {
      // A broken href: skip it.
    }
  }
  return found.sort((a, b) => b.score - a.score).map((f) => f.href);
}

/**
 * An outlet's logo (spec §4.7): its page's icon links, then
 * `/apple-touch-icon.png`, then `/favicon.ico`. Raster only, at most 256 KB.
 * `keep` is asked of each candidate in turn — the assets area refuses some
 * kinds (WebP) — and the first it keeps is the answer. Null when none
 * answers or none is kept.
 */
export async function fetchLogo(
  http: HttpArea, site: string, options: FetchOptions & { keep?: (logo: Logo) => Promise<boolean> } = {},
): Promise<Logo | null> {
  const { keep, ...get } = options;
  const candidates: string[] = [];
  try {
    const { response, url } = await politeGet(http, site, { maxBytes: PAGE_MAX_BYTES, headers: { accept: 'text/html' }, ...get });
    if (response.ok) candidates.push(...iconLinks(new TextDecoder('utf-8').decode(await response.arrayBuffer()), url));
  } catch {
    // The page did not answer: try the conventional address.
  }
  candidates.push(new URL('/apple-touch-icon.png', site).toString(), new URL('/favicon.ico', site).toString());
  for (const candidate of [...new Set(candidates)].slice(0, 5)) {
    try {
      const { response, url } = await politeGet(http, candidate, { maxBytes: LOGO_MAX_BYTES, headers: { accept: 'image/*' }, ...get });
      if (!response.ok) continue;
      const bytes = Buffer.from(await response.arrayBuffer());
      // What the bytes are decides, not what the server says: an HTML error page served as image/png is not a logo.
      const mime = sniffImage(bytes);
      if (!mime || bytes.length > LOGO_MAX_BYTES) continue;
      const logo = { bytes, mime, url };
      if (keep && !(await keep(logo))) continue;
      return logo;
    } catch {
      // Too large, refused, timed out: the next candidate.
    }
  }
  return null;
}

/** What the bytes are, by their first ones; undefined for anything but the raster kinds a logo may be. */
export function sniffImage(bytes: Buffer): string | undefined {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 6 && /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('latin1'))) return 'image/gif';
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (bytes.length >= 4 && bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 1 && bytes[3] === 0) return 'image/x-icon';
  return undefined;
}
