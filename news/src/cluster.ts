/**
 * Articles into stories, on this machine, with no model. Pure: the database
 * side (`store.ts`) loads the open stories of a topic and writes back what
 * this decides.
 *
 * An article joins the open story it is most like, when that likeness clears
 * `MERGE_THRESHOLD`, and starts a story of its own otherwise. Likeness is the
 * best of two measures against each article already in the story: the
 * weighted Jaccard of their terms (entities count three times) and the
 * Jaccard of their three-term shingles (the same wording, as a rewritten wire
 * story has). Two articles that each name things, none in common, are never
 * one story unless their wording is nearly the same: "Apple unveils a new
 * phone" and "Google unveils a new phone" share every word but the one that
 * matters. A story is open for `WINDOW_MS` after its last article.
 *
 * The thresholds were tuned on `cluster.test.ts`'s fixtures: one story told
 * by six outlets in English and French, and pairs of different stories told
 * in the same words.
 */
import { crossConcept, ENTITY_WEIGHT, featuresOf, isTranslatable, jaccard, weightedJaccard, type Features, type TermSet } from './text.js';

export const WINDOW_MS = 48 * 3600_000;
export const MERGE_THRESHOLD = 0.3;
/** Shingle likeness that overrides the entity rule: the same sentence, near enough. */
export const SAME_WORDING = 0.5;
/** At most this many of a story's articles are compared, the newest. */
export const COMPARE_MAX = 24;
/** Names two articles in different languages must share before their likeness counts. */
export const CROSS_NAMES = 3;
/**
 * The cross-language likeness an article pair must reach: higher than
 * `MERGE_THRESHOLD`, because a vocabulary cut down to names and concepts is
 * small, and two stories about one famous person share a good part of it.
 */
export const CROSS_MERGE = 0.4;
export const COMMON_SHARE = 0.1;
export const COMMON_MIN = 6;

export interface ClusterArticle {
  id: string;
  publishedAt: Date;
  sequence: string[];
  /** `en` or `fr`; two articles in different languages are compared on what both languages share. */
  language?: string;
  /** A deal or buying guide: it only ever joins other deals, and news never joins it. */
  deal?: boolean;
}

export interface OpenStory {
  id: string;
  updatedAt: Date;
  members: ClusterArticle[];
}

/** How alike two stretches of terms are, 0 to 1. */
function alike(a: TermSet, b: TermSet): number {
  const shingle = jaccard(a.shingles, b.shingles);
  if (shingle >= SAME_WORDING) return shingle;
  if (a.entities.size > 0 && b.entities.size > 0) {
    let shared = false;
    for (const e of a.entities) if (b.entities.has(e)) { shared = true; break; }
    if (!shared) return 0;
  }
  return Math.max(weightedJaccard(a.weights, b.weights), shingle);
}

/**
 * A term set as both languages read it: each term through the cross-language
 * lexicon ("enfant" and "children" are `child`, "Omani" and "omanais" the name
 * `oman`), then cut down to what can be shared — names, numbers and concepts.
 */
function translatable(t: TermSet): { weights: Map<string, number>; entities: Set<string> } {
  const weights = new Map<string, number>();
  const entities = new Set<string>();
  for (const [k] of t.weights) {
    const concept = crossConcept(k);
    const key = concept ? concept.replace(/^!/, '') : k;
    const entity = t.entities.has(k) || !!concept?.startsWith('!');
    if (!entity && !concept && !isTranslatable(key)) continue;
    if (entity) entities.add(key);
    weights.set(key, Math.max(weights.get(key) ?? 0, entity ? ENTITY_WEIGHT : 1));
  }
  return { weights, entities };
}

/**
 * How alike two stretches in different languages are. Their shingles and
 * their untranslated words can never match, so they are compared on the
 * vocabulary both languages share, and only when they name at least
 * `CROSS_NAMES` things in common (one shared country is a topic, not a
 * story), not counting the names `common` to much of the topic right now
 * (Trump, in US politics), and only past `CROSS_MERGE`.
 */
function alikeAcross(a: TermSet, b: TermSet, common: ReadonlySet<string>): number {
  const x = translatable(a);
  const y = translatable(b);
  let shared = 0;
  for (const e of x.entities) if (y.entities.has(e) && !common.has(e)) shared += 1;
  if (shared < CROSS_NAMES) return 0;
  const score = weightedJaccard(x.weights, y.weights);
  return score >= CROSS_MERGE ? score : 0;
}

/**
 * How alike two articles are, 0 to 1: title and lead against title and lead,
 * or title against title when either has no lead (a Google News item is a
 * title alone, and a lead would only dilute what it shares). Across languages
 * the same-language measure still counts (a name-heavy title can clear it on
 * its own), and the cross-language one is added beside it.
 */
export function likeness(a: Features, b: Features, across = false, common: ReadonlySet<string> = NONE): number {
  const [x, y] = a.hasLead && b.hasLead ? [a, b] as const : [a.title, b.title] as const;
  const same = alike(x, y);
  return across ? Math.max(same, alikeAcross(x, y, common)) : same;
}

const NONE: ReadonlySet<string> = new Set();

/**
 * The names too common in a topic right now to say two articles tell one
 * story: in at least `COMMON_SHARE` of the open stories and new articles, and
 * at least `COMMON_MIN` of them.
 */
export function commonNames(stories: OpenStory[], incoming: ClusterArticle[]): Set<string> {
  const units: Array<Set<string>> = [
    ...stories.map((s) => new Set(s.members.flatMap((m) => [...featuresOf(m.sequence).entities]))),
    ...incoming.map((a) => featuresOf(a.sequence).entities),
  ];
  const count = new Map<string, number>();
  for (const unit of units) for (const e of unit) count.set(e, (count.get(e) ?? 0) + 1);
  const floor = Math.max(COMMON_MIN, units.length * COMMON_SHARE);
  return new Set([...count].filter(([, n]) => n >= floor).map(([e]) => e));
}

/** The best open story for an article, or null when it starts one. */
export function bestStory(article: ClusterArticle, stories: OpenStory[], common: ReadonlySet<string> = NONE): { id: string; score: number } | null {
  const mine = featuresOf(article.sequence);
  let best: { id: string; score: number } | null = null;
  for (const story of stories) {
    if (Math.abs(article.publishedAt.getTime() - story.updatedAt.getTime()) > WINDOW_MS) continue;
    const members = [...story.members].sort((x, y) => y.publishedAt.getTime() - x.publishedAt.getTime()).slice(0, COMPARE_MAX);
    for (const member of members) {
      if (!!member.deal !== !!article.deal) continue;
      const across = !!article.language && !!member.language && article.language !== member.language;
      const score = likeness(mine, featuresOf(member.sequence), across, common);
      if (score >= MERGE_THRESHOLD && (!best || score > best.score)) best = { id: story.id, score };
    }
  }
  return best;
}

/**
 * Assign each new article, oldest first, to an open story or a new one.
 * New stories are opened as they are made, so two new articles of the same
 * story in one fetch land together. `newId` names a new story.
 */
export function assignStories(
  incoming: ClusterArticle[],
  open: OpenStory[],
  newId: () => string,
): { assignments: Map<string, string>; created: string[] } {
  const stories = open.map((s) => ({ ...s, members: [...s.members] }));
  const assignments = new Map<string, string>();
  const created: string[] = [];
  const common = commonNames(stories, incoming);
  for (const article of [...incoming].sort((a, b) => a.publishedAt.getTime() - b.publishedAt.getTime())) {
    const best = bestStory(article, stories, common);
    if (best) {
      const story = stories.find((s) => s.id === best.id)!;
      story.members.push(article);
      if (article.publishedAt > story.updatedAt) story.updatedAt = article.publishedAt;
      assignments.set(article.id, story.id);
    } else {
      const id = newId();
      stories.push({ id, updatedAt: article.publishedAt, members: [article] });
      created.push(id);
      assignments.set(article.id, id);
    }
  }
  return { assignments, created };
}
