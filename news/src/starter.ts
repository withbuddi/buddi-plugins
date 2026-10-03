/**
 * The starter topics, their sources and the outlets behind them: the lists of
 * buddi-planning/specs/news-and-anchor.md §5, each address fetched on
 * 2026-10-03. `verified: false` marks a source that did not answer a feed
 * with recent items, kept here with why so the next look starts from it, and
 * left out of what "turn on the starter sources" adds. Where an address
 * redirects, the final one is listed, since the http area follows no
 * redirect by itself.
 *
 * A source may feed several topics (Hacker News feeds Technology, and AI
 * through the AI keywords); `filter: 'keywords'` keeps only the articles that
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
}

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
  { id: 'technology', name: 'Technology', languages: ['en', 'fr'],
    keywords: ['tech', 'technology', 'technologie', 'smartphone', 'logiciel', 'software', 'Apple', 'Google', 'Microsoft', 'Meta', 'Samsung'] },
  { id: 'ai', name: 'AI', languages: ['en', 'fr'],
    keywords: ['AI', 'IA', 'artificial intelligence', 'intelligence artificielle', 'LLM', 'OpenAI', 'Anthropic', 'Gemini', 'ChatGPT', 'Claude', 'machine learning'] },
  { id: 'togo-west-africa', name: 'Togo and West Africa', languages: ['fr', 'en'],
    keywords: ['Togo', 'Lomé', 'Gnassingbé', 'CEDEAO', 'ECOWAS', 'Bénin', 'Benin', 'Ghana', 'Sahel', 'UEMOA', 'Burkina', 'Niger', 'Mali', 'Nigeria', "Côte d'Ivoire", 'Sénégal', 'Senegal'] },
  { id: 'us-politics', name: 'US politics', languages: ['en', 'fr'],
    keywords: ['États-Unis', 'Etats-Unis', 'Washington', 'Trump', 'Congrès', 'Congress', 'Maison Blanche', 'White House', 'Sénat', 'Senate', 'Cour suprême', 'Supreme Court', 'démocrates', 'républicains'] },
  { id: 'international', name: 'International', languages: ['en', 'fr'],
    keywords: ['world', 'international', 'monde', 'diplomacy', 'diplomatie', 'summit', 'sommet', 'ceasefire', 'cessez-le-feu', 'UN', 'ONU'] },
  { id: 'economy', name: 'Economy', languages: ['en', 'fr'],
    keywords: ['economy', 'économie', 'inflation', 'central bank', 'banque centrale', 'Fed', 'ECB', 'BCE', 'jobs', 'emploi', 'markets', 'marchés', 'tariffs', 'GDP', 'PIB'] },
];

export const STARTER_OUTLETS: StarterOutlet[] = [
  { domain: 'theverge.com', name: 'The Verge', kind: 'specialist', language: 'en' },
  { domain: 'arstechnica.com', name: 'Ars Technica', kind: 'specialist', language: 'en' },
  { domain: 'techcrunch.com', name: 'TechCrunch', kind: 'specialist', language: 'en' },
  { domain: 'wired.com', name: 'Wired', kind: 'specialist', language: 'en' },
  { domain: 'nytimes.com', name: 'The New York Times', kind: 'national', language: 'en', paywall: true },
  { domain: 'lemonde.fr', name: 'Le Monde', kind: 'national', language: 'fr' },
  { domain: 'numerama.com', name: 'Numerama', kind: 'specialist', language: 'fr' },
  { domain: '01net.com', name: '01net', kind: 'specialist', language: 'fr' },
  { domain: 'frandroid.com', name: 'Frandroid', kind: 'specialist', language: 'fr' },
  { domain: 'journaldunet.com', name: 'Journal du Net', kind: 'specialist', language: 'fr' },
  { domain: 'technologyreview.com', name: 'MIT Technology Review', kind: 'specialist', language: 'en' },
  { domain: 'theguardian.com', name: 'The Guardian', kind: 'national', language: 'en' },
  { domain: 'importai.substack.com', name: 'Import AI', kind: 'blog', language: 'en' },
  { domain: 'simonwillison.net', name: 'Simon Willison', kind: 'blog', language: 'en' },
  { domain: 'openai.com', name: 'OpenAI', kind: 'company', language: 'en' },
  { domain: 'blog.google', name: 'Google', kind: 'company', language: 'en' },
  { domain: 'actuia.com', name: 'ActuIA', kind: 'specialist', language: 'fr' },
  { domain: 'togofirst.com', name: 'Togo First', kind: 'regional' },
  { domain: 'republicoftogo.com', name: 'République togolaise', kind: 'state', language: 'fr' },
  { domain: 'jeuneafrique.com', name: 'Jeune Afrique', kind: 'regional', language: 'fr', paywall: true },
  { domain: 'agenceecofin.com', name: 'Agence Ecofin', kind: 'regional', language: 'fr' },
  { domain: 'icilome.com', name: 'icilome', kind: 'regional', language: 'fr' },
  { domain: 'rfi.fr', name: 'RFI', kind: 'international' },
  { domain: 'africanews.com', name: 'Africanews', kind: 'regional' },
  { domain: 'bbc.com', name: 'BBC News', kind: 'international', language: 'en' },
  { domain: 'apnews.com', name: 'AP', kind: 'wire', language: 'en' },
  { domain: 'reuters.com', name: 'Reuters', kind: 'wire', language: 'en' },
  { domain: 'npr.org', name: 'NPR', kind: 'national', language: 'en' },
  { domain: 'politico.com', name: 'Politico', kind: 'national', language: 'en' },
  { domain: 'axios.com', name: 'Axios', kind: 'national', language: 'en' },
  { domain: 'semafor.com', name: 'Semafor', kind: 'national', language: 'en' },
  { domain: 'thehill.com', name: 'The Hill', kind: 'national', language: 'en' },
  { domain: 'foxnews.com', name: 'Fox News', kind: 'national', language: 'en' },
  { domain: 'washingtonexaminer.com', name: 'Washington Examiner', kind: 'national', language: 'en' },
  { domain: 'nationalreview.com', name: 'National Review', kind: 'national', language: 'en' },
  { domain: 'economist.com', name: 'The Economist', kind: 'international', language: 'en', paywall: true },
  { domain: 'aljazeera.com', name: 'Al Jazeera', kind: 'international', language: 'en' },
  { domain: 'dw.com', name: 'DW', kind: 'international', language: 'en' },
  { domain: 'france24.com', name: 'France 24', kind: 'international' },
  { domain: 'ft.com', name: 'Financial Times', kind: 'international', language: 'en', paywall: true },
  { domain: 'wsj.com', name: 'The Wall Street Journal', kind: 'national', language: 'en', paywall: true },
  { domain: 'liberation.fr', name: 'Libération', kind: 'national', language: 'fr' },
  { domain: 'lefigaro.fr', name: 'Le Figaro', kind: 'national', language: 'fr' },
  { domain: 'bloomberg.com', name: 'Bloomberg', kind: 'international', language: 'en', paywall: true },
  { domain: 'cnbc.com', name: 'CNBC', kind: 'national', language: 'en' },
  { domain: 'lesechos.fr', name: 'Les Echos', kind: 'national', language: 'fr', paywall: true },
  { domain: 'voaafrique.com', name: "VOA Afrique", kind: 'international', language: 'fr' },
];

const T = (topic: string, filter?: 'keywords') => ({ topic, ...(filter ? { filter } : {}) });
const feed = (
  id: string, name: string, url: string, language: Language, outlet: string, topics: Array<{ topic: string; filter?: 'keywords' }>,
  extra: Partial<StarterSource> = {},
): StarterSource => ({ id, name, kind: url.includes('atom') ? 'atom' : 'rss', url, language, outlet, topics, verified: true, ...extra });
const gnews = (id: string, name: string, query: string, language: Language, topic: string): StarterSource =>
  ({ id, name, kind: 'gnews', url: gnewsUrl(query, language), language, topics: [T(topic)], verified: true });

export const STARTER_SOURCES: StarterSource[] = [
  // Technology
  feed('the-verge', 'The Verge', 'https://www.theverge.com/rss/index.xml', 'en', 'theverge.com', [T('technology')], { kind: 'atom' }),
  feed('ars-technica', 'Ars Technica', 'https://feeds.arstechnica.com/arstechnica/index', 'en', 'arstechnica.com', [T('technology')]),
  feed('techcrunch', 'TechCrunch', 'https://techcrunch.com/feed/', 'en', 'techcrunch.com', [T('technology')]),
  feed('wired', 'Wired', 'https://www.wired.com/feed/rss', 'en', 'wired.com', [T('technology')]),
  feed('nyt-technology', 'The New York Times · Technology', 'https://rss.nytimes.com/services/xml/rss/nyt/Technology.xml', 'en', 'nytimes.com', [T('technology')]),
  { id: 'hacker-news', name: 'Hacker News', kind: 'hn', url: HN_FRONT_PAGE, language: 'en', verified: true, topics: [T('technology'), T('ai', 'keywords')] },
  { id: 'google-news-technology', name: 'Google News · Technology', kind: 'gnews', language: 'en', verified: true, topics: [T('technology')],
    url: 'https://news.google.com/rss/topics/CAAqKggKIiRDQkFTRlFvSUwyMHZNRGRqTVhZU0JXVnVMVlZUR2dKVlV5Z0FQAQ?hl=en-US&gl=US&ceid=US:en' },
  feed('le-monde-pixels', 'Le Monde · Pixels', 'https://www.lemonde.fr/pixels/rss_full.xml', 'fr', 'lemonde.fr', [T('technology')]),
  feed('numerama', 'Numerama', 'https://www.numerama.com/feed/', 'fr', 'numerama.com', [T('technology')]),
  feed('01net', '01net', 'https://www.01net.com/actualites/feed/', 'fr', '01net.com', [T('technology')]),
  feed('frandroid', 'Frandroid', 'https://www.frandroid.com/feed', 'fr', 'frandroid.com', [T('technology')]),
  feed('journal-du-net', 'Journal du Net', 'https://www.journaldunet.com/rss/', 'fr', 'journaldunet.com', [T('technology')]),
  feed('le-monde-informatique', 'Le Monde Informatique', 'https://www.lemondeinformatique.fr/flux-rss/thematique/toutes-les-actualites/rss.xml', 'fr', 'lemondeinformatique.fr', [T('technology')],
    { verified: false, note: 'answered, no items parsed (spec §5)' }),

  // AI
  feed('mit-technology-review-ai', 'MIT Technology Review · AI', 'https://www.technologyreview.com/topic/artificial-intelligence/feed', 'en', 'technologyreview.com', [T('ai')]),
  feed('the-verge-ai', 'The Verge · AI', 'https://www.theverge.com/rss/ai-artificial-intelligence/index.xml', 'en', 'theverge.com', [T('ai')], { kind: 'atom' }),
  feed('guardian-ai', 'The Guardian · AI', 'https://www.theguardian.com/technology/artificialintelligenceai/rss', 'en', 'theguardian.com', [T('ai')]),
  feed('import-ai', 'Import AI', 'https://importai.substack.com/feed', 'en', 'importai.substack.com', [T('ai')], { opinion: true }),
  feed('simon-willison', 'Simon Willison', 'https://simonwillison.net/atom/everything/', 'en', 'simonwillison.net', [T('ai')], { kind: 'atom' }),
  feed('openai-news', 'OpenAI News', 'https://openai.com/news/rss.xml', 'en', 'openai.com', [T('ai')]),
  feed('google-ai-blog', 'Google AI blog', 'https://blog.google/innovation-and-ai/technology/ai/rss/', 'en', 'blog.google', [T('ai')]),
  feed('le-monde-ia', 'Le Monde · IA', 'https://www.lemonde.fr/intelligence-artificielle/rss_full.xml', 'fr', 'lemonde.fr', [T('ai')]),
  feed('actuia', 'ActuIA', 'https://www.actuia.com/feed/', 'fr', 'actuia.com', [T('ai')]),
  feed('venturebeat-ai', 'VentureBeat · AI', 'https://venturebeat.com/category/ai/feed/', 'en', 'venturebeat.com', [T('ai')],
    { verified: false, note: 'answered 429 Too Many Requests' }),

  // Togo and West Africa
  feed('togo-first-fr', 'Togo First · Actualités', 'https://www.togofirst.com/fr/actualites?format=feed&type=rss', 'fr', 'togofirst.com', [T('togo-west-africa')]),
  feed('togo-first-economy', 'Togo First · Economy', 'https://www.togofirst.com/en/economy?format=feed&type=rss', 'en', 'togofirst.com', [T('togo-west-africa')]),
  feed('togo-first-politics', 'Togo First · Politics', 'https://www.togofirst.com/en/politics?format=feed&type=rss', 'en', 'togofirst.com', [T('togo-west-africa')]),
  gnews('republic-of-togo', 'République togolaise (Google News)', 'site:republicoftogo.com', 'fr', 'togo-west-africa'),
  gnews('jeune-afrique', 'Jeune Afrique (Google News)', 'site:jeuneafrique.com when:2d', 'fr', 'togo-west-africa'),
  gnews('agence-ecofin', 'Agence Ecofin (Google News)', 'site:agenceecofin.com when:2d', 'fr', 'togo-west-africa'),
  feed('icilome', 'icilome', 'https://icilome.com/feed/', 'fr', 'icilome.com', [T('togo-west-africa')]),
  feed('rfi-afrique', 'RFI · Afrique', 'https://www.rfi.fr/fr/afrique/rss', 'fr', 'rfi.fr', [T('togo-west-africa')]),
  feed('rfi-africa', 'RFI · Africa', 'https://www.rfi.fr/en/africa/rss', 'en', 'rfi.fr', [T('togo-west-africa')]),
  feed('le-monde-afrique', 'Le Monde Afrique', 'https://www.lemonde.fr/afrique/rss_full.xml', 'fr', 'lemonde.fr', [T('togo-west-africa')]),
  feed('africanews-en', 'Africanews', 'https://www.africanews.com/feed/rss', 'en', 'africanews.com', [T('togo-west-africa')]),
  feed('africanews-fr', 'Africanews (fr)', 'https://fr.africanews.com/feed/rss', 'fr', 'africanews.com', [T('togo-west-africa')]),
  feed('bbc-africa', 'BBC News · Africa', 'https://feeds.bbci.co.uk/news/world/africa/rss.xml', 'en', 'bbc.com', [T('togo-west-africa', 'keywords')]),
  gnews('google-news-togo-fr', 'Google News · Togo OR Lomé', 'Togo OR Lomé', 'fr', 'togo-west-africa'),
  gnews('google-news-togo-en', 'Google News · Togo', 'Togo when:2d', 'en', 'togo-west-africa'),
  feed('voa-afrique', 'VOA Afrique', 'https://www.voaafrique.com/api/epiqq', 'fr', 'voaafrique.com', [T('togo-west-africa', 'keywords')],
    { verified: false, note: 'answers a feed, but its newest item is from March 2025' }),
  feed('togo-breaking-news', 'Togo Breaking News', 'https://www.togobreakingnews.info/feed/', 'fr', 'togobreakingnews.info', [T('togo-west-africa')],
    { verified: false, note: 'redirects to the home page' }),
  feed('the-africa-report', 'The Africa Report', 'https://www.theafricareport.com/feed/', 'en', 'theafricareport.com', [T('togo-west-africa')],
    { verified: false, note: 'answered 403' }),
  { id: 'gdelt-togo', name: 'GDELT · Togo OR Lomé', kind: 'gdelt', language: 'en', topics: [T('togo-west-africa')], verified: false,
    note: 'answered 429 (one request per five seconds) every time it was checked',
    url: 'https://api.gdeltproject.org/api/v2/doc/doc?query=(Togo%20OR%20Lom%C3%A9)%20(sourcelang:eng%20OR%20sourcelang:fra)&mode=artlist&format=json&maxrecords=75&timespan=1d&sort=datedesc' },

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

  // Economy
  gnews('reuters-business', 'Reuters (Google News)', 'site:reuters.com business when:1d', 'en', 'economy'),
  feed('nyt-economy', 'The New York Times · Economy', 'https://rss.nytimes.com/services/xml/rss/nyt/Economy.xml', 'en', 'nytimes.com', [T('economy')]),
  feed('guardian-economics', 'The Guardian · Economics', 'https://www.theguardian.com/business/economics/rss', 'en', 'theguardian.com', [T('economy')]),
  feed('financial-times', 'Financial Times', 'https://www.ft.com/rss/home/international', 'en', 'ft.com', [T('economy')]),
  feed('bloomberg-markets', 'Bloomberg · Markets', 'https://www.bloomberg.com/feeds/markets/news.rss', 'en', 'bloomberg.com', [T('economy')]),
  feed('economist-finance', 'The Economist · Finance and economics', 'https://www.economist.com/finance-and-economics/rss.xml', 'en', 'economist.com', [T('economy')]),
  feed('cnbc-top-news', 'CNBC · Top News', 'https://www.cnbc.com/id/100003114/device/rss/rss.html', 'en', 'cnbc.com', [T('economy')]),
  feed('le-monde-economie', 'Le Monde · Économie', 'https://www.lemonde.fr/economie/rss_full.xml', 'fr', 'lemonde.fr', [T('economy')]),
  feed('le-monde-economie-mondiale', 'Le Monde · Économie mondiale', 'https://www.lemonde.fr/economie-mondiale/rss_full.xml', 'fr', 'lemonde.fr', [T('economy')]),
  feed('le-figaro-economie', 'Le Figaro · Économie', 'https://www.lefigaro.fr/rss/figaro_economie.xml', 'fr', 'lefigaro.fr', [T('economy')]),
  feed('liberation-economie', 'Libération · Économie', 'https://www.liberation.fr/arc/outboundfeeds/rss-all/category/economie/?outputType=xml', 'fr', 'liberation.fr', [T('economy')]),
  gnews('les-echos', 'Les Echos (Google News)', 'site:lesechos.fr when:1d', 'fr', 'economy'),
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
    if (!starterSources().some((s) => s.outlet === o.domain) && !['apnews.com', 'reuters.com', 'jeuneafrique.com', 'agenceecofin.com', 'republicoftogo.com', 'lesechos.fr'].includes(o.domain)) continue;
    hosts.add(o.domain);
    hosts.add(`*.${o.domain}`);
  }
  // A feed host under an outlet's `*.domain` is already covered.
  for (const h of [...hosts]) {
    if (!h.startsWith('*.') && [...hosts].some((w) => w.startsWith('*.') && h.endsWith(w.slice(1)))) hosts.delete(h);
  }
  return [...hosts].sort((a, b) => a.replace(/^\*\./, '').localeCompare(b.replace(/^\*\./, '')) || a.localeCompare(b));
}
