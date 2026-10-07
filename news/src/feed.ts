import { feedImage, type FeedImage } from './feed-images.js';
/**
 * RSS 2.0, RSS 1.0 (RDF) and Atom, read into one shape. Pure: bytes and the
 * address they came from in, items out.
 *
 * - The bytes are decoded by the charset the answer names, else the one the
 *   XML declaration names, else a BOM, else UTF-8 (and windows-1252 when
 *   UTF-8 does not fit and nothing was named, as old French feeds need).
 * - Links are resolved against `xml:base`, then the address of the feed, so a
 *   relative `/2026/10/story` becomes an absolute URL.
 * - Titles and summaries lose their markup and entities (including the
 *   doubly escaped `&amp;#8217;` some feeds send); a summary keeps its first
 *   `LEAD_MAX` characters at a word boundary.
 * - At most `maxItems`, newest first; an item without a title or a link is
 *   left out.
 */
import { ATOM, CONTENT, DC, RDF, RSS1, childOf, childrenOf, decodeEntities, deepText, parseXml, type XmlElement } from './xml.js';

export interface FeedItem {
  image?: FeedImage;
  title: string;
  url: string;
  summary: string;
  publishedAt: Date | null;
  categories: string[];
  /** Google News: the outlet the item comes from. */
  outlet?: { name: string; url?: string };
}

export interface ParsedFeed {
  format: 'rss' | 'rdf' | 'atom';
  title: string;
  /** The site the feed belongs to, absolute. */
  link?: string;
  language?: string;
  items: FeedItem[];
}

export const LEAD_MAX = 600;
export const DEFAULT_MAX_ITEMS = 50;

/** Decode an answer's bytes into text, by the charset it names or its XML declaration says. */
export function decodeBytes(bytes: Uint8Array, contentType?: string | null): string {
  const declared = charsetOf(contentType ?? '') ?? xmlDeclaredCharset(bytes);
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return new TextDecoder('utf-8').decode(bytes.subarray(3));
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  if (declared) {
    try {
      return new TextDecoder(declared === 'iso-8859-1' || declared === 'latin1' ? 'windows-1252' : declared).decode(bytes);
    } catch {
      // A label TextDecoder does not know: fall through to UTF-8.
    }
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

function charsetOf(contentType: string): string | undefined {
  const m = /charset\s*=\s*"?([\w.:-]+)"?/i.exec(contentType);
  return m ? m[1]!.toLowerCase() : undefined;
}

function xmlDeclaredCharset(bytes: Uint8Array): string | undefined {
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 200));
  const m = /^\s*<\?xml[^>]*encoding\s*=\s*["']([\w.:-]+)["']/i.exec(head.replace(/^﻿|^ï»¿/, ''));
  return m ? m[1]!.toLowerCase() : undefined;
}

/** Strip markup and entities, collapse white space. Twice through entities: `&amp;#8217;` is a quote. */
export function plainText(html: string): string {
  let text = html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/p>|<\/div>|<\/li>/gi, ' ')
    .replace(/<[^>]*>/g, ' ');
  text = decodeEntities(decodeEntities(text));
  // Entities may have spelled markup (`&lt;p&gt;`): strip what that left.
  text = text.replace(/<[^>]*>/g, ' ');
  return text.replace(/[\s ]+/g, ' ').trim();
}

/** The first `max` characters at a word boundary, with an ellipsis when cut. */
export function clip(text: string, max = LEAD_MAX): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.5 ? cut.slice(0, space) : cut).replace(/[\s,;:.-]+$/, '')}…`;
}

/** An absolute http(s) URL, or undefined. */
export function absolute(href: string | undefined, base: string | undefined): string | undefined {
  const raw = href?.trim();
  if (!raw) return undefined;
  try {
    const url = base ? new URL(raw, base) : new URL(raw);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

const MONTHS: Record<string, string> = {
  jan: 'Jan', feb: 'Feb', fev: 'Feb', fév: 'Feb', mar: 'Mar', apr: 'Apr', avr: 'Apr', may: 'May', mai: 'May', jun: 'Jun',
  juin: 'Jun', jul: 'Jul', juil: 'Jul', aug: 'Aug', aou: 'Aug', aoû: 'Aug', sep: 'Sep', sept: 'Sep', oct: 'Oct', nov: 'Nov', dec: 'Dec', déc: 'Dec',
};

/** RFC 822 (with the zones and French month names feeds use), ISO 8601; null when it is not a date. */
export function parseDate(raw: string | undefined): Date | null {
  const text = raw?.trim();
  if (!text) return null;
  let at = Date.parse(text);
  if (Number.isNaN(at)) {
    // "Sam, 03 oct 2026 07:24:53 +0200", "03 Oct 2026 07:24 EST", a two-digit year.
    const m = /(\d{1,2})\s+([a-zéû]+)\.?\s+(\d{2,4})\s+(\d{1,2}:\d{2}(?::\d{2})?)\s*([+-]\d{4}|[A-Z]{1,4})?/i.exec(text);
    if (m) {
      const month = MONTHS[m[2]!.toLowerCase()] ?? MONTHS[m[2]!.toLowerCase().slice(0, 3)];
      const year = m[3]!.length === 2 ? `20${m[3]}` : m[3];
      if (month) at = Date.parse(`${m[1]} ${month} ${year} ${m[4]} ${m[5] ?? 'GMT'}`);
    }
  }
  if (Number.isNaN(at)) return null;
  return new Date(at);
}

export function parseFeed(text: string, feedUrl: string, maxItems = DEFAULT_MAX_ITEMS): ParsedFeed {
  const doc = parseXml(text);
  let parsed: ParsedFeed;
  if (doc.name === 'rss') parsed = readRss(doc, feedUrl);
  else if (doc.ns === ATOM && doc.name === 'feed') parsed = readAtom(doc, feedUrl);
  else if (doc.ns === RDF && doc.name === 'RDF') parsed = readRdf(doc, feedUrl);
  else throw new Error(`this is not a feed (its root is <${doc.qname}>)`);
  const items = parsed.items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => (b.item.publishedAt?.getTime() ?? 0) - (a.item.publishedAt?.getTime() ?? 0) || a.index - b.index)
    .slice(0, maxItems)
    .map(({ item }) => item);
  return { ...parsed, items };
}

const textOf = (el: XmlElement | undefined): string => (el ? plainText(deepText(el)) : '');

/** An element in no namespace or in RSS 1.0's (RDF feeds put their items there). */
const plain = (el: XmlElement | undefined, name: string): XmlElement | undefined => childOf(el, '', name) ?? childOf(el, RSS1, name);

function readRss(doc: XmlElement, feedUrl: string): ParsedFeed {
  const channel = plain(doc, 'channel');
  if (!channel) throw new Error('this RSS feed has no channel');
  const base = absolute(doc.attrs.base ?? channel.attrs.base, feedUrl) ?? feedUrl;
  const link = absolute(plain(channel, 'link')?.text, base);
  const items = childrenOf(channel, '', 'item').map((item) => rssItem(item, absolute(item.attrs.base, base) ?? base)).filter((i): i is FeedItem => i !== null);
  const language = plain(channel, 'language')?.text.trim() || childOf(channel, DC, 'language')?.text.trim();
  return { format: 'rss', title: textOf(plain(channel, 'title')), ...(link ? { link } : {}), ...(language ? { language } : {}), items };
}

function rssItem(item: XmlElement, base: string): FeedItem | null {
  const title = textOf(plain(item, 'title'));
  const guid = plain(item, 'guid');
  const guidUrl = guid && guid.attrs.isPermaLink !== 'false' ? guid.text : undefined;
  const url = absolute(plain(item, 'link')?.text, base) ?? absolute(item.attrs.about, base) ?? absolute(guidUrl, base);
  if (!title || !url) return null;
  const summary = clip(textOf(plain(item, 'description')) || textOf(childOf(item, CONTENT, 'encoded')));
  const publishedAt = parseDate(plain(item, 'pubDate')?.text ?? childOf(item, DC, 'date')?.text);
  const categories = [...childrenOf(item, '', 'category'), ...childrenOf(item, DC, 'subject')].map((c) => textOf(c)).filter(Boolean);
  const source = plain(item, 'source');
  const outletName = source ? textOf(source) : '';
  const outletUrl = source ? absolute(source.attrs.url, base) : undefined;
  return {
    ...(feedImage(item, base) ? { image: feedImage(item, base)! } : {}),
    title,
    url,
    summary,
    publishedAt,
    categories,
    ...(outletName ? { outlet: { name: outletName, ...(outletUrl ? { url: outletUrl } : {}) } } : {}),
  };
}

function readRdf(doc: XmlElement, feedUrl: string): ParsedFeed {
  const channel = childOf(doc, RSS1, 'channel') ?? childOf(doc, '', 'channel');
  const link = absolute(plain(channel, 'link')?.text, feedUrl);
  const items = [...childrenOf(doc, RSS1, 'item'), ...childrenOf(doc, '', 'item')]
    .map((item) => rssItem(item, feedUrl))
    .filter((i): i is FeedItem => i !== null);
  const language = childOf(channel, DC, 'language')?.text.trim();
  return { format: 'rdf', title: textOf(plain(channel, 'title')), ...(link ? { link } : {}), ...(language ? { language } : {}), items };
}

/** The `alternate` link (or one with no rel), resolved. */
function atomLink(el: XmlElement, base: string): string | undefined {
  const links = childrenOf(el, ATOM, 'link');
  const alt = links.find((l) => (l.attrs.rel ?? 'alternate') === 'alternate' && (!l.attrs.type || /html/.test(l.attrs.type))) ??
    links.find((l) => (l.attrs.rel ?? 'alternate') === 'alternate');
  return absolute(alt?.attrs.href, absolute(alt?.attrs.base, base) ?? base);
}

function readAtom(doc: XmlElement, feedUrl: string): ParsedFeed {
  const base = absolute(doc.attrs.base, feedUrl) ?? feedUrl;
  const link = atomLink(doc, base);
  const items: FeedItem[] = [];
  for (const entry of childrenOf(doc, ATOM, 'entry')) {
    const entryBase = absolute(entry.attrs.base, base) ?? base;
    const title = textOf(childOf(entry, ATOM, 'title'));
    const url = atomLink(entry, entryBase) ?? absolute(childOf(entry, ATOM, 'id')?.text, entryBase);
    if (!title || !url) continue;
    const summary = clip(textOf(childOf(entry, ATOM, 'summary')) || textOf(childOf(entry, ATOM, 'content')));
    const publishedAt = parseDate(childOf(entry, ATOM, 'published')?.text ?? childOf(entry, ATOM, 'updated')?.text);
    const categories = childrenOf(entry, ATOM, 'category').map((c) => c.attrs.label ?? c.attrs.term ?? '').filter(Boolean);
    items.push({ title, url, summary, publishedAt, categories, ...(feedImage(entry, entryBase) ? { image: feedImage(entry, entryBase)! } : {}) });
  }
  const language = doc.attrs.lang;
  return { format: 'atom', title: textOf(childOf(doc, ATOM, 'title')), ...(link ? { link } : {}), ...(language ? { language } : {}), items };
}
