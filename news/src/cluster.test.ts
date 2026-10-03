/**
 * The merge threshold, tuned on these fixtures: one story told by six
 * outlets in English and French must be one story, and two stories told in
 * nearly the same words must stay two.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { assignStories, likeness, MERGE_THRESHOLD, WINDOW_MS, type ClusterArticle } from './cluster.js';
import { articleSequence, featuresOf, isNews, isOpinion, stripOutletSuffix, terms } from './text.js';

interface Fixture { outlet: string; lang: string; at: string; title: string; lead: string }
const fx = JSON.parse(readFileSync(new URL('./fixtures/stories.json', import.meta.url), 'utf8')) as {
  fedCut: Fixture[]; togoVote: Fixture[]; similarButDifferent: Array<[Fixture, Fixture]>;
};

const article = (f: Fixture, i: number, prefix: string): ClusterArticle => ({
  id: `${prefix}${i}`, publishedAt: new Date(f.at), sequence: articleSequence(f.title, f.lead),
});

let counter = 0;
const newId = (): string => `story${++counter}`;

describe('clustering', () => {
  it.each(['fedCut', 'togoVote'] as const)('puts one story told by six outlets in two languages together (%s)', (key) => {
    const articles = fx[key].map((f, i) => article(f, i, key));
    expect(new Set(fx[key].map((f) => f.lang))).toEqual(new Set(['en', 'fr']));
    const { assignments, created } = assignStories(articles, [], newId);
    expect(created).toHaveLength(1);
    expect(new Set(assignments.values()).size).toBe(1);
  });

  it('keeps the two stories apart when both arrive in one fetch, shuffled', () => {
    const mixed = [...fx.fedCut.map((f, i) => article(f, i, 'fed')), ...fx.togoVote.map((f, i) => article(f, i, 'togo'))];
    mixed.sort((a, b) => a.id.localeCompare(b.id));
    const { assignments, created } = assignStories(mixed, [], newId);
    expect(created).toHaveLength(2);
    const fed = new Set(fx.fedCut.map((_, i) => assignments.get(`fed${i}`)));
    const togo = new Set(fx.togoVote.map((_, i) => assignments.get(`togo${i}`)));
    expect(fed.size).toBe(1);
    expect(togo.size).toBe(1);
    expect([...fed][0]).not.toBe([...togo][0]);
  });

  it.each(fx.similarButDifferent.map((pair) => [pair[0].title, pair[1].title, pair] as const))('keeps "%s" and "%s" apart', (_a, _b, pair) => {
    const [a, b] = pair.map((f, i) => article(f, i, 'pair'));
    expect(likeness(featuresOf(a!.sequence), featuresOf(b!.sequence))).toBeLessThan(MERGE_THRESHOLD);
    expect(assignStories([a!, b!], [], newId).created).toHaveLength(2);
  });

  it('joins an open story incrementally, and not one closed more than 48 hours before', () => {
    const [first, ...rest] = fx.fedCut.map((f, i) => article(f, i, 'inc'));
    const open = [{ id: 'fed-story', updatedAt: first!.publishedAt, members: [first!] }];
    const { assignments, created } = assignStories(rest, open, newId);
    expect(created).toEqual([]);
    expect(new Set(assignments.values())).toEqual(new Set(['fed-story']));

    const late = { ...rest[0]!, id: 'late', publishedAt: new Date(first!.publishedAt.getTime() + WINDOW_MS + 3600_000) };
    expect(assignStories([late], open, newId).created).toHaveLength(1);
  });
});

describe('text features', () => {
  it('maps French and English news words onto one concept and marks names', () => {
    expect(terms('La Fed abaisse ses taux directeurs')).toEqual(['!fed', 'cut', 'rate']);
    expect(terms('The Federal Reserve cuts interest rates')).toEqual(['!fed', 'cut', 'rate']);
    expect(articleSequence('Apple unveils iPhone', 'Apple said on Tuesday')).toContain('!apple');
    expect(articleSequence('Apple unveils iPhone', 'Apple said on Tuesday')).toContain('!iphone');
    expect(articleSequence('Apple unveils iPhone', 'Apple said on Tuesday')).toContain('tuesday');
  });

  it('strips the outlet Google News appends to a title', () => {
    expect(stripOutletSuffix('Togo : les municipales sous tension - RFI', 'RFI')).toBe('Togo : les municipales sous tension');
    expect(stripOutletSuffix('A - B - Le Monde.fr', 'Le Monde.fr')).toBe('A - B');
    expect(stripOutletSuffix('No suffix here', 'RFI')).toBe('No suffix here');
    expect(stripOutletSuffix('- Les Echos', 'Les Echos')).toBe('');
  });

  it('leaves out what is not news: shopping codes, legal notices, a section\'s own page', () => {
    expect(isNews('Hoka Coupon Codes: 30% Off in October 2026')).toBe(false);
    expect(isNews('Modification du capital social - Paris', 'Les Echos - Annonces légales')).toBe(false);
    expect(isNews('Ukraine')).toBe(false);
    expect(isNews('Tariffs and global trade')).toBe(true);
  });

  it('reads opinion from the address, the title label or the category', () => {
    expect(isOpinion('https://www.theguardian.com/commentisfree/2026/oct/02/x', 'A view')).toBe(true);
    expect(isOpinion('https://www.lemonde.fr/idees/article/2026/10/02/x', 'Un regard')).toBe(true);
    expect(isOpinion('https://example.com/a', 'Opinion: Why the summit will fail')).toBe(true);
    expect(isOpinion('https://example.com/a', 'Tribune – Pour une Europe forte')).toBe(true);
    expect(isOpinion('https://example.com/a', 'A headline', ['Chronique'])).toBe(true);
    expect(isOpinion('https://example.com/world/a', 'Leaders meet in Geneva')).toBe(false);
  });
});

describe('title-only items', () => {
  it('joins a Google News title, which has no lead, to the story its title tells', () => {
    const full = fx.fedCut.map((f, i) => article(f, i, 'full'));
    const titleOnly = fx.fedCut.map((f, i) => ({ id: `t${i}`, publishedAt: new Date(f.at), sequence: articleSequence(f.title, '') }));
    // Every title alone, against the told-in-full articles: one story.
    const { created } = assignStories([...full.slice(0, 3), titleOnly[3]!, titleOnly[1]!, full[5]!], [], newId);
    expect(created).toHaveLength(1);
  });

  it('keeps title-only items of different stories apart', () => {
    for (const [a, b] of fx.similarButDifferent) {
      const fa = featuresOf(articleSequence(a.title, ''));
      const fb = featuresOf(articleSequence(b.title, ''));
      expect(likeness(fa, fb)).toBeLessThan(MERGE_THRESHOLD);
    }
  });
});
