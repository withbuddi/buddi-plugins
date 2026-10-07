/**
 * The starter topics, their sources and the outlets behind them: the lists of
 * buddi-planning/specs/news-and-anchor.md §5, each address fetched on
 * 2026-10-03. `verified: false` marks a source that did not answer a feed
 * with recent items, kept here with why so the next look starts from it, and
 * left out of what "turn on the starter sources" adds. Where an address
 * redirects, the final one is listed, since the http area follows no
 * redirect by itself.
 *
 * The default kit covers US and International news. A source may feed
 * several topics; `filter: 'keywords'` keeps only the articles that
 * match the topic's keywords.
 */

export type SourceKind = 'rss' | 'atom' | 'gnews' | 'hn' | 'gdelt';
export type Language = 'en' | 'fr';
export type OutletKind = 'wire' | 'national' | 'international' | 'regional' | 'specialist' | 'state' | 'company' | 'blog';

export interface StarterOutlet {
  domain: string;
  name: string;
  kind: OutletKind;
  language?: Language;
  paywall?: boolean;
  /**
   * Where AllSides' published media bias ratings place it (spec §13.1): the US
   * politics outlets only. Used for the diversity bonus in ranking and given to
   * Anchor; never shown on a card.
   */
  lean?: Lean;
}

export type Lean = 'left' | 'lean-left' | 'center' | 'lean-right' | 'right';

export interface StarterSource {
  id: string;
  name: string;
  kind: SourceKind;
  url: string;
  language: Language;
  /** The outlet's domain, for a publisher's own feed; absent for an aggregator. */
  outlet?: string;
  opinion?: boolean;
  verified: boolean;
  note?: string;
  topics: Array<{ topic: string; filter?: 'keywords' }>;
}

export interface StarterTopic {
  id: string;
  name: string;
  keywords: string[];
  languages: Language[];
}

/** How often each kind is fetched, in seconds (spec §4.1). */
export const EVERY_SECONDS: Record<SourceKind, number> = { rss: 900, atom: 900, gnews: 1200, hn: 900, gdelt: 1800 };

/** The Google News RSS search for a query, in an edition. */
export function gnewsUrl(query: string, language: Language): string {
  const edition = language === 'fr' ? 'hl=fr&gl=FR&ceid=FR:fr' : 'hl=en-US&gl=US&ceid=US:en';
  return `https://news.google.com/rss/search?q=${encodeURIComponent(query).replace(/%20/g, '+')}&${edition}`;
}

export const HN_FRONT_PAGE = 'https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=50';

export const STARTER_TOPICS: StarterTopic[] = [
  { id: 'us-politics', name: 'US', languages: ['en', 'fr'],
    keywords: ['États-Unis', 'Etats-Unis', 'Washington', 'Trump', 'Congrès', 'Congress', 'Maison Blanche', 'White House', 'Sénat', 'Senate', 'Cour suprême', 'Supreme Court', 'démocrates', 'républicains'] },
  { id: 'international', name: 'International', languages: ['en', 'fr'],
    keywords: ['world', 'international', 'monde', 'diplomacy', 'diplomatie', 'summit', 'sommet', 'ceasefire', 'cessez-le-feu', 'UN', 'ONU'] },
];

export const STARTER_OUTLETS: StarterOutlet[] = [
  { domain: 'nytimes.com', name: 'The New York Times', kind: 'national', language: 'en', paywall: true, lean: 'lean-left' },
  { domain: 'lemonde.fr', name: 'Le Monde', kind: 'national', language: 'fr' },
  { domain: 'theguardian.com', name: 'The Guardian', kind: 'national', language: 'en', lean: 'left' },
  { domain: 'rfi.fr', name: 'RFI', kind: 'international' },
  { domain: 'bbc.com', name: 'BBC News', kind: 'international', language: 'en', lean: 'center' },
  { domain: 'apnews.com', name: 'AP', kind: 'wire', language: 'en', lean: 'lean-left' },
  { domain: 'reuters.com', name: 'Reuters', kind: 'wire', language: 'en', lean: 'center' },
  { domain: 'npr.org', name: 'NPR', kind: 'national', language: 'en', lean: 'lean-left' },
  { domain: 'politico.com', name: 'Politico', kind: 'national', language: 'en', lean: 'lean-left' },
  { domain: 'axios.com', name: 'Axios', kind: 'national', language: 'en', lean: 'lean-left' },
  { domain: 'semafor.com', name: 'Semafor', kind: 'national', language: 'en', lean: 'center' },
  { domain: 'thehill.com', name: 'The Hill', kind: 'national', language: 'en', lean: 'center' },
  { domain: 'foxnews.com', name: 'Fox News', kind: 'national', language: 'en', lean: 'right' },
  { domain: 'washingtonexaminer.com', name: 'Washington Examiner', kind: 'national', language: 'en', lean: 'lean-right' },
  { domain: 'nationalreview.com', name: 'National Review', kind: 'national', language: 'en', lean: 'right' },
  { domain: 'economist.com', name: 'The Economist', kind: 'international', language: 'en', paywall: true, lean: 'lean-left' },
  { domain: 'aljazeera.com', name: 'Al Jazeera', kind: 'international', language: 'en' },
  { domain: 'dw.com', name: 'DW', kind: 'international', language: 'en' },
  { domain: 'france24.com', name: 'France 24', kind: 'international' },
  { domain: 'ft.com', name: 'Financial Times', kind: 'international', language: 'en', paywall: true },
  { domain: 'wsj.com', name: 'The Wall Street Journal', kind: 'national', language: 'en', paywall: true, lean: 'center' },
  { domain: 'liberation.fr', name: 'Libération', kind: 'national', language: 'fr' },
  { domain: 'lefigaro.fr', name: 'Le Figaro', kind: 'national', language: 'fr' },
];

const T = (topic: string, filter?: 'keywords') => ({ topic, ...(filter ? { filter } : {}) });
const feed = (
  id: string, name: string, url: string, language: Language, outlet: string, topics: Array<{ topic: string; filter?: 'keywords' }>,
  extra: Partial<StarterSource> = {},
): StarterSource => ({ id, name, kind: url.includes('atom') ? 'atom' : 'rss', url, language, outlet, topics, verified: true, ...extra });
const gnews = (id: string, name: string, query: string, language: Language, topic: string): StarterSource =>
  ({ id, name, kind: 'gnews', url: gnewsUrl(query, language), language, topics: [T(topic)], verified: true });

export const STARTER_SOURCES: StarterSource[] = [
  // US politics
  gnews('ap-politics', 'AP (Google News)', 'site:apnews.com when:1d', 'en', 'us-politics'),
  feed('nyt-politics', 'The New York Times · Politics', 'https://rss.nytimes.com/services/xml/rss/nyt/Politics.xml', 'en', 'nytimes.com', [T('us-politics')]),
  feed('npr-politics', 'NPR · Politics', 'https://feeds.npr.org/1014/rss.xml', 'en', 'npr.org', [T('us-politics')]),
  feed('guardian-us-politics', 'The Guardian · US politics', 'https://www.theguardian.com/us-news/us-politics/rss', 'en', 'theguardian.com', [T('us-politics')]),
  feed('politico', 'Politico', 'https://rss.politico.com/politics-news.xml', 'en', 'politico.com', [T('us-politics')]),
  feed('axios', 'Axios', 'https://api.axios.com/feed/', 'en', 'axios.com', [T('us-politics')]),
  feed('semafor', 'Semafor', 'https://www.semafor.com/rss.xml', 'en', 'semafor.com', [T('us-politics')]),
  feed('the-hill', 'The Hill', 'https://thehill.com/homenews/feed/', 'en', 'thehill.com', [T('us-politics')]),
  feed('fox-news-politics', 'Fox News · Politics', 'https://moxie.foxnews.com/google-publisher/politics.xml', 'en', 'foxnews.com', [T('us-politics')]),
  feed('washington-examiner', 'Washington Examiner', 'https://www.washingtonexaminer.com/feed/', 'en', 'washingtonexaminer.com', [T('us-politics')]),
  feed('national-review', 'National Review', 'https://www.nationalreview.com/feed/', 'en', 'nationalreview.com', [T('us-politics')], { opinion: true }),
  feed('economist-united-states', 'The Economist · United States', 'https://www.economist.com/united-states/rss.xml', 'en', 'economist.com', [T('us-politics')]),
  feed('le-monde-ameriques', 'Le Monde · Amériques', 'https://www.lemonde.fr/ameriques/rss_full.xml', 'fr', 'lemonde.fr', [T('us-politics', 'keywords')]),
  feed('rfi-ameriques', 'RFI · Amériques', 'https://www.rfi.fr/fr/am%C3%A9riques/rss', 'fr', 'rfi.fr', [T('us-politics', 'keywords')]),

  // International
  gnews('reuters-world', 'Reuters (Google News)', 'site:reuters.com world when:1d', 'en', 'international'),
  gnews('ap-world', 'AP (Google News)', 'site:apnews.com world when:1d', 'en', 'international'),
  feed('bbc-world', 'BBC News · World', 'https://feeds.bbci.co.uk/news/world/rss.xml', 'en', 'bbc.com', [T('international')]),
  feed('al-jazeera', 'Al Jazeera', 'https://www.aljazeera.com/xml/rss/all.xml', 'en', 'aljazeera.com', [T('international')]),
  feed('guardian-world', 'The Guardian · World', 'https://www.theguardian.com/world/rss', 'en', 'theguardian.com', [T('international')]),
  feed('dw-world', 'DW · World', 'https://rss.dw.com/xml/rss-en-world', 'en', 'dw.com', [T('international')]),
  feed('france24-en', 'France 24', 'https://www.france24.com/en/rss', 'en', 'france24.com', [T('international')]),
  feed('nyt-world', 'The New York Times · World', 'https://rss.nytimes.com/services/xml/rss/nyt/World.xml', 'en', 'nytimes.com', [T('international')]),
  feed('ft-world', 'Financial Times · World', 'https://www.ft.com/world?format=rss', 'en', 'ft.com', [T('international')]),
  feed('france24-fr', 'France 24 (fr)', 'https://www.france24.com/fr/rss', 'fr', 'france24.com', [T('international')]),
  feed('rfi-monde', 'RFI · Monde', 'https://www.rfi.fr/fr/monde/rss', 'fr', 'rfi.fr', [T('international')]),
  feed('le-monde-international', 'Le Monde · International', 'https://www.lemonde.fr/international/rss_full.xml', 'fr', 'lemonde.fr', [T('international')]),
  feed('liberation-international', 'Libération · International', 'https://www.liberation.fr/arc/outboundfeeds/rss-all/category/international/?outputType=xml', 'fr', 'liberation.fr', [T('international')]),
  feed('le-figaro-international', 'Le Figaro · International', 'https://www.lefigaro.fr/rss/figaro_international.xml', 'fr', 'lefigaro.fr', [T('international')]),
  feed('wsj-world', 'The Wall Street Journal · World', 'https://feeds.a.dj.com/rss/RSSWorldNews.xml', 'en', 'wsj.com', [T('international')],
    { verified: false, note: 'answers a feed, but its newest item is from January 2025' }),


];

/** The sources "turn on the starter sources" adds: the verified ones. */
export function starterSources(topicIds?: string[]): StarterSource[] {
  return STARTER_SOURCES.filter((s) => s.verified && (!topicIds || s.topics.some((t) => topicIds.includes(t.topic))));
}

/**
 * The hosts the starter sources reach: each feed's host, and each outlet's
 * domain and its subdomains (its logo is fetched from its site, which may
 * redirect to `www.`).
 */
export function starterHosts(): string[] {
  const hosts = new Set<string>();
  for (const s of starterSources()) hosts.add(new URL(s.url).hostname);
  for (const o of STARTER_OUTLETS) {
    if (!starterSources().some((s) => s.outlet === o.domain) && !['apnews.com', 'reuters.com'].includes(o.domain)) continue;
    hosts.add(o.domain);
    hosts.add(`*.${o.domain}`);
  }
  // A feed host under an outlet's `*.domain` is already covered.
  for (const h of [...hosts]) {
    if (!h.startsWith('*.') && [...hosts].some((w) => w.startsWith('*.') && h.endsWith(w.slice(1)))) hosts.delete(h);
  }
  return [...hosts].sort((a, b) => a.replace(/^\*\./, '').localeCompare(b.replace(/^\*\./, '')) || a.localeCompare(b));
}
