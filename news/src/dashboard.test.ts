/**
 * The dashboard and edition parts that need no database: times in words, a
 * story as the page's card and sheet, the material's untold-first order, the
 * widget's order, the page descriptors through core's validation, robots.txt
 * and an article's text, and what Add a source takes for an address.
 */
import { describe, expect, it } from 'vitest';
import { parsePageContributions } from '@buddi/core/testing';
import { manifest } from './index.js';
import { ago, endOfDay, languageMark, startOfDay, stamp, whenWords } from './format.js';
import { storyCard, newsPages } from './dashboard.js';
import { articleText, chooseMaterial, robotsAllow } from './edition.js';
import { sideWords, untoldFirst } from './widget.js';
import { looksLikeAddress } from './settings.js';
import type { ArticleRow, RankedStory } from './reads.js';

const ZONE = 'Europe/Paris';
const NOW = new Date('2026-10-03T08:15:00Z'); // 10:15 in Paris, a Saturday

const article = (over: Partial<ArticleRow>): ArticleRow => ({
  story_id: 's1', id: 'a1', title: 'Title', lead: '', url: 'https://www.rfi.fr/x', language: 'fr', published_at: new Date('2026-10-03T04:10:00Z'),
  fetched_at: new Date('2026-10-03T04:12:00Z'), opinion: false, outlet_id: 'rfi.fr', outlet: 'RFI Afrique', outlet_kind: 'international', paywall: false,
  logo: 'rfi.fr', lean: null, source_id: 'rfi-afrique', source_kind: 'rss', ...over,
});

const ranked = (id: string, topicId: string, status: 'new' | 'update' | 'told', score: number, articles: ArticleRow[] = [article({ story_id: id })]): RankedStory => ({
  summary: {
    id, topic: topicId.toUpperCase(), topicId, title: `Story ${id}`, lead: 'Lead.', url: 'https://www.rfi.fr/x', outlet: articles[0]!.outlet,
    outlets: articles.map((a) => a.outlet), languages: [...new Set(articles.map((a) => a.language))], firstSeen: articles[0]!.fetched_at.toISOString(),
    updatedAt: articles[articles.length - 1]!.fetched_at.toISOString(), articles: articles.length, status,
    lastToldAt: status === 'new' ? null : '2026-10-03T05:30:00Z', opinion: false, score,
  },
  articles,
});

describe('times in words', () => {
  it('says ages, stamps and when, in the owner\'s zone', () => {
    expect(ago(new Date('2026-10-03T04:15:00Z'), NOW)).toBe('4 h ago');
    expect(ago(new Date('2026-10-03T07:30:00Z'), NOW)).toBe('45 min ago');
    expect(stamp(new Date('2026-10-03T04:10:00Z'), NOW, ZONE)).toBe('06:10');
    expect(stamp(new Date('2026-10-02T16:05:00Z'), NOW, ZONE)).toBe('yesterday 18:05');
    expect(stamp(new Date('2026-10-03T04:10:00Z'), NOW, ZONE, '12h')).toBe('6:10 AM');
    expect(whenWords(new Date('2026-10-03T05:30:00Z'), NOW, ZONE)).toBe('this morning');
    expect(whenWords(new Date('2026-10-02T17:00:00Z'), NOW, ZONE)).toBe('yesterday evening');
    expect(whenWords(new Date('2026-10-01T17:00:00Z'), NOW, ZONE)).toBe('Thursday evening');
  });

  it('finds the local day\'s edges across a DST change', () => {
    expect(startOfDay(NOW, ZONE).toISOString()).toBe('2026-10-02T22:00:00.000Z');
    expect(endOfDay(NOW, ZONE).toISOString()).toBe('2026-10-03T22:00:00.000Z');
    // The night the clocks go back in Paris: the day is 25 hours long.
    const fallBack = new Date('2026-10-25T10:00:00Z');
    expect(startOfDay(fallBack, ZONE).toISOString()).toBe('2026-10-24T22:00:00.000Z');
    expect(endOfDay(fallBack, ZONE).toISOString()).toBe('2026-10-25T23:00:00.000Z');
  });

  it('marks French, and both, but not English alone', () => {
    expect(languageMark(['fr'])).toBe('FR');
    expect(languageMark(['en', 'fr'])).toBe('EN · FR');
    expect(languageMark(['en'])).toBeUndefined();
  });
});

describe('a story on the page', () => {
  const ctx = { now: NOW, zone: ZONE, format: null, anchor: 'anchor' };

  it('draws the card: logos with ids for muting, the age, languages, and Told you', () => {
    const r = ranked('s1', 'togo', 'told', 3, [
      article({ id: 'a1' }),
      article({ id: 'a2', outlet_id: 'reuters.com', outlet: 'Reuters', language: 'en', logo: null, url: 'https://www.reuters.com/y', published_at: new Date('2026-10-03T06:20:00Z'), fetched_at: new Date('2026-10-03T05:00:00Z') }),
      article({ id: 'a3', outlet_id: null, outlet: 'Google News · Togo', source_id: 'gn', source_kind: 'gnews', logo: null, fetched_at: new Date('2026-10-03T05:10:00Z') }),
    ]);
    const card = storyCard(r, [{ kind: 'morning', at: new Date('2026-10-03T05:30:00Z') }], ctx);
    expect(card.outlets).toEqual([{ id: 'rfi.fr', name: 'RFI Afrique', logo: 'rfi.fr' }, { id: 'reuters.com', name: 'Reuters' }, { name: 'Google News · Togo' }]);
    expect(card.mutable).toEqual([{ id: 'rfi.fr', name: 'RFI Afrique' }, { id: 'reuters.com', name: 'Reuters' }]);
    expect(card.languages).toBe('EN · FR');
    expect(card.mark).toEqual({ kind: 'told', text: 'Told you · this morning' });
    expect(card.quiet).toBe(true);
    expect(card.meta).toBe('First seen 06:10 · 3 sources · told you this morning');
    expect(card.sources[0]).toMatchObject({ title: 'Title', url: 'https://www.rfi.fr/x', outlet: 'RFI Afrique', logo: 'rfi.fr', meta: 'RFI Afrique · French · 06:10' });
    expect(card.timeline[0]).toEqual({ at: '06:10', text: 'First reported by RFI Afrique.' });
    expect(card.timeline.some((t) => t.told && t.text === 'Told you in the morning edition.')).toBe(true);
    expect(card.quietHint).toBe('Back on its own next Saturday');
    expect(card.anchor).toBe('anchor');
  });

  it('leads an update with what is new since it was told', () => {
    const r = ranked('s2', 'togo', 'update', 3, [
      article({ id: 'a1' }),
      article({ id: 'a2', outlet_id: 'jeuneafrique.com', outlet: 'Jeune Afrique', lead: 'Ghana proposes a common customs window by 2028.', fetched_at: new Date('2026-10-03T07:40:00Z') }),
    ]);
    const card = storyCard(r, [], ctx);
    expect(card.mark).toEqual({ kind: 'new', text: 'New since this morning' });
    expect(card.lead).toBe('Ghana proposes a common customs window by 2028.');
    expect(card.update).toBe(card.lead);
    expect(card.summary).toBe('Lead.');
    expect(card.quiet).toBeUndefined();
  });
});

describe('the edition material', () => {
  it('takes the best untold story of every topic first, then the rest by rank, grouped in the owner\'s order; told apart', () => {
    const stories = [
      ranked('ai1', 'ai', 'new', 9), ranked('ai2', 'ai', 'update', 8), ranked('ai3', 'ai', 'new', 7),
      ranked('us1', 'us', 'told', 6), ranked('togo1', 'togo', 'new', 2), ranked('ai4', 'ai', 'new', 1.5), ranked('us2', 'us', 'new', 1),
    ];
    const { picked, told } = chooseMaterial(stories, ['togo', 'ai', 'us'], 4);
    expect(picked.map((r) => r.summary.id)).toEqual(['togo1', 'ai1', 'ai2', 'us2']);
    expect(told.map((r) => r.summary.id)).toEqual(['us1']);
  });

  it('keeps the age on a widget row\'s right, cutting the outlet', () => {
    expect(sideWords('RFI Afrique', '4 h')).toBe('RFI Afrique · 4 h');
    expect(sideWords('The Washington Examiner', '12 h')).toBe('The Washington E… · 12 h');
    expect(sideWords('The Washington Examiner', '12 h').length).toBeLessThanOrEqual(24);
  });

  it('puts untold first in the widget', () => {
    const order = untoldFirst([ranked('a', 't', 'told', 9), ranked('b', 't', 'update', 1), ranked('c', 't', 'new', 2), ranked('d', 't', 'new', 5)]);
    expect(order.map((r) => r.summary.id)).toEqual(['d', 'c', 'b', 'a']);
  });
});

describe('the pages', () => {
  it('pass core\'s page validation with the plugin\'s queries and tools', () => {
    const parsed = parsePageContributions({
      plugin: 'news', pages: newsPages, queries: manifest.queries ?? [], tools: manifest.tools.map((t) => t.name),
    });
    expect(parsed.pages.map((p) => p.id)).toEqual(['stories', 'sources']);
  });
});

describe('reading an article', () => {
  it('obeys robots.txt: its own group first, the longest rule, Allow on a tie', () => {
    const robots = 'User-agent: *\nDisallow: /private/\nAllow: /private/open\n\nUser-agent: GPTBot\nDisallow: /';
    expect(robotsAllow(robots, '/news/story')).toBe(true);
    expect(robotsAllow(robots, '/private/x')).toBe(false);
    expect(robotsAllow(robots, '/private/open/y')).toBe(true);
    expect(robotsAllow('User-agent: buddi-news\nDisallow: /\n\nUser-agent: *\nDisallow:', '/a')).toBe(false);
    expect(robotsAllow('User-agent: *\nDisallow: /*.pdf$', '/a.pdf')).toBe(false);
  });

  it('keeps the article\'s paragraphs and leaves menus, scripts and asides', () => {
    const para = 'Leaders from the fifteen member states open a two-day summit in Lomé today, with trade on the agenda.';
    const html = `<html><nav><p>${'Menu item that is long enough to count as a paragraph here.'}</p></nav><script>var x = 1;</script>
      <article><h1>Title</h1><p>${para}</p><aside><p>Read also: something else that is long enough to be a paragraph.</p></aside><p>Short.</p><p>${para} &amp; more.</p></article></html>`;
    expect(articleText(html)).toBe(`${para}\n\n${para} & more.`);
  });
});

describe('Add a source', () => {
  it('takes an address as an address and words as a search', () => {
    expect(looksLikeAddress('lemonde.fr')).toBe(true);
    expect(looksLikeAddress('https://www.leprogres.fr/lyon/rss')).toBe(true);
    expect(looksLikeAddress('leprogres.fr/lyon/rss')).toBe(true);
    expect(looksLikeAddress('Lyon')).toBe(false);
    expect(looksLikeAddress('Lyon tram T10')).toBe(false);
  });
});
