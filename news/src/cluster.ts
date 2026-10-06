/**
 * Articles into stories, on this machine, with no model. Pure: the database
 * side (`store.ts`) loads the open stories of a topic and writes back what
 * this decides.
 *
 * An article joins the open story it is most like, when that likeness clears
 * `MERGE_THRESHOLD`, and starts a story of its own otherwise. Two articles
 * are compared by the best of two measures: the weighted Jaccard of their
 * terms (names count three times) and the Jaccard of their three-term
 * shingles (the same wording, as a rewritten wire story has).
 *
 * What a topic is about says nothing about which story an article tells: in
 * "Togo and West Africa" every headline names Togo. So the topic's name and
 * the terms in at least `COMMON_SHARE` of its stories right now are
 * stopwords: they are not names, and weigh `STOP_WEIGHT` as words. Years are
 * words, not names.
 *
 * Title and lead are compared, and the titles alone too (two headlines can
 * say it plainer than their leads). Below `SAME_WORDING`, the names decide
 * whether a likeness counts at all: two articles that each name things, none
 * in common, are never one story ("Apple unveils a new phone" and "Google
 * unveils a new phone"), and one name in common is enough only with
 * `ONE_NAME_TERMS` other words in common (China gave Togo equipment; China
 * and Togo discussed tax: two stories).
 *
 * An article is compared with the story as a whole, not its nearest member:
 * its likeness to a story is the mean of its best likenesses to the story's
 * newest `COMPARE_MAX` articles (to half of them, at most `TOP_K`), and it
 * must share a name with the story's first article when both name things,
 * so a story cannot drift hop by hop from a football match to a tax meeting.
 * The same wording as any one article is enough on its own.
 *
 * Meaning first, since 0.2.5. Once the meaning model is ready (`meaning.ts`),
 * an article with a vector is compared with a story by the cosine of their
 * vectors, the topic's own direction taken out of both (`embed.ts`), averaged
 * the same way (its best to half the story's newest articles, at most
 * `TOP_K`): at `MEANING_MERGE` or more it joins; between `MEANING_BAND` and
 * there the word rules above decide; below, it does not join. The rules that
 * forbid stay in force on both roads: a deal never joins news, a story keeps
 * to what its first article named, and two articles that each name things,
 * none in common, count for nothing. An article or a story without vectors
 * (the model not downloaded, still loading, or not yet past this article) is
 * compared by its words alone, as before.
 *
 * A story is open for `WINDOW_MS` after its last article. The thresholds
 * were tuned on `cluster.test.ts`'s fixtures: two stories told by six outlets
 * in English and French, pairs of different stories told in the same words,
 * a "Togo and West Africa" day where every headline names Togo, and Malaysia's
 * budget beside France's.
 */
import { dot, without } from './embed.js';
import { crossConcept, ENTITY_WEIGHT, featuresOf, isTranslatable, jaccard, terms, weightedJaccard, type Features, type TermSet } from './text.js';

export const WINDOW_MS = 48 * 3600_000;
export const MERGE_THRESHOLD = 0.3;
/** Shingle likeness that overrides the name rules: the same sentence, near enough. */
export const SAME_WORDING = 0.5;
/** At most this many of a story's articles are compared, the newest. */
export const COMPARE_MAX = 24;
/** A story's likeness is the mean of an article's best likenesses to half its articles, at most this many. */
export const TOP_K = 3;
/** Other words two articles sharing a single name must also share. */
export const ONE_NAME_TERMS = 2;
/** What a stopword weighs as a word (a word weighs 1, a name `ENTITY_WEIGHT`). */
export const STOP_WEIGHT = 0.5;
/** Names two articles in different languages must share before their likeness counts. */
export const CROSS_NAMES = 3;
/** Or one name and this many other terms both languages share. */
export const CROSS_WORDS = 3;
/**
 * The cross-language likeness an article pair must reach: higher than
 * `MERGE_THRESHOLD`, because a vocabulary cut down to names and concepts is
 * small, and two stories about one famous person share a good part of it.
 */
export const CROSS_MERGE = 0.4;
/** A term in at least this share of a topic's stories right now is a stopword… */
export const COMMON_SHARE = 0.1;
/** …and in at least this many of them. */
export const COMMON_MIN = 5;
/**
 * The clustering rules' version. When it moves past the one the open stories
 * were grouped by (`news.settings.cluster_rules`), they are grouped again once.
 */
export const CLUSTER_RULES = 2;
/**
 * The cosine, on vectors without the topic's direction, at which an article
 * joins a story by meaning alone. Tuned on `cluster.test.ts`'s fixtures with
 * the vectors the model gives them (`fixtures/vectors.json`).
 */
export const MEANING_MERGE = 0.75;
/** From here up to `MEANING_MERGE` the word rules decide; below it, apart. */
export const MEANING_BAND = 0.55;

export interface ClusterArticle {
  id: string;
  publishedAt: Date;
  sequence: string[];
  /** `en` or `fr`; two articles in different languages are compared on what both languages share. */
  language?: string;
  /** A deal or buying guide: it only ever joins other deals, and news never joins it. */
  deal?: boolean;
  /** Its title and lead's meaning (`embed.ts`), when it has been embedded by the model in use. */
  vector?: Float32Array;
}

export interface OpenStory {
  id: string;
  updatedAt: Date;
  members: ClusterArticle[];
}

const NONE: ReadonlySet<string> = new Set();
const YEAR = /^(19|20)\d\d$/;

/**
 * A topic's own words as stored terms: its name's ("Togo and West Africa" →
 * `togo`, `west`, `africa`). Its query is not: a starter topic's query lists
 * everything it may be about (Lomé, the Fed), names that do tell stories
 * apart; a query word that runs through the topic is caught as common.
 */
export function topicTerms(name: string): Set<string> {
  return new Set(terms(name).map((t) => t.replace(/^!/, '')));
}

/** A term set with the stopwords taken out of its names and weighed down, and years read as words. */
function strip(t: TermSet, stop: ReadonlySet<string>): TermSet {
  if (stop.size === 0 && ![...t.entities].some((e) => YEAR.test(e))) return t;
  const weights = new Map<string, number>();
  for (const [k, w] of t.weights) weights.set(k, stop.has(k) ? STOP_WEIGHT : YEAR.test(k) ? Math.min(w, 1) : w);
  const entities = new Set([...t.entities].filter((e) => !stop.has(e) && !YEAR.test(e)));
  return { weights, entities, shingles: t.shingles };
}

/** An article's features as one topic reads them: its stopwords out. */
export function topicFeatures(f: Features, stop: ReadonlySet<string> = NONE): Features {
  return { ...strip(f, stop), hasLead: f.hasLead, title: strip(f.title, stop) };
}

/** How alike two stretches of terms are, 0 to 1, and whether it is the same wording. */
function alike(a: TermSet, b: TermSet): { score: number; same: boolean; refused?: boolean } {
  const shingle = jaccard(a.shingles, b.shingles);
  if (shingle >= SAME_WORDING) return { score: shingle, same: true };
  let shared = 0;
  for (const e of a.entities) if (b.entities.has(e)) shared += 1;
  if (a.entities.size > 0 && b.entities.size > 0 && shared === 0) return { score: 0, same: false, refused: true };
  if (shared === 1) {
    let words = 0;
    for (const [k, w] of a.weights) if (w >= 1 && !a.entities.has(k) && (b.weights.get(k) ?? 0) >= 1 && !b.entities.has(k)) words += 1;
    if (words < ONE_NAME_TERMS) return { score: 0, same: false, refused: true };
  }
  return { score: Math.max(weightedJaccard(a.weights, b.weights), shingle), same: false };
}

/**
 * A term set as both languages read it: each term through the cross-language
 * lexicon ("enfant" and "children" are `child`, "Omani" and "omanais" the name
 * `oman`), then cut down to what can be shared — names, numbers, concepts,
 * and the words the other side spells the same way ("opposition",
 * "election"). Stopwords weigh `STOP_WEIGHT`.
 */
function translatable(t: TermSet, other: TermSet, stop: ReadonlySet<string>): { weights: Map<string, number>; entities: Set<string> } {
  const weights = new Map<string, number>();
  const entities = new Set<string>();
  for (const [k] of t.weights) {
    const concept = crossConcept(k);
    const key = concept ? concept.replace(/^!/, '') : k;
    const entity = (t.entities.has(k) || !!concept?.startsWith('!')) && !stop.has(key) && !YEAR.test(key);
    if (!entity && !concept && !isTranslatable(key) && !other.weights.has(k)) continue;
    if (entity) entities.add(key);
    weights.set(key, Math.max(weights.get(key) ?? 0, stop.has(key) || stop.has(k) ? STOP_WEIGHT : entity ? ENTITY_WEIGHT : 1));
  }
  return { weights, entities };
}

/**
 * How alike two stretches in different languages are. Their shingles and
 * their untranslated words can never match, so they are compared on the
 * vocabulary both languages share, and only when they name at least
 * `CROSS_NAMES` things in common (one shared country is a topic, not a
 * story), or one with `CROSS_WORDS` other terms in common, not counting the
 * topic's stopwords, and only past `CROSS_MERGE`.
 */
function alikeAcross(a: TermSet, b: TermSet, stop: ReadonlySet<string>): number {
  const x = translatable(a, b, stop);
  const y = translatable(b, a, stop);
  let names = 0;
  for (const e of x.entities) if (y.entities.has(e)) names += 1;
  let words = 0;
  for (const [k, w] of x.weights) if (w >= 1 && !x.entities.has(k) && (y.weights.get(k) ?? 0) >= 1 && !y.entities.has(k)) words += 1;
  if (names < CROSS_NAMES && !(names >= 1 && words >= CROSS_WORDS)) return 0;
  const score = weightedJaccard(x.weights, y.weights);
  return score >= CROSS_MERGE ? score : 0;
}

/** Both measures for a pair already read by the topic (`topicFeatures`). */
function pair(a: Features, b: Features, across: boolean, stop: ReadonlySet<string>): { score: number; same: boolean } {
  const both = a.hasLead && b.hasLead;
  const [x, y] = both ? [a, b] as const : [a.title, b.title] as const;
  const full = alike(x, y);
  if (full.same) return full;
  // Two headlines can say it plainer than their leads: the titles alone count too, unless the names already refused.
  const titles = both && !full.refused ? alike(a.title, b.title) : undefined;
  if (titles?.same) return titles;
  const score = Math.max(full.score, titles?.score ?? 0);
  return { score: across ? Math.max(score, alikeAcross(x, y, stop)) : score, same: false };
}

/**
 * How alike two articles are, 0 to 1: title and lead against title and lead,
 * or title against title when either has no lead (a Google News item is a
 * title alone, and a lead would only dilute what it shares). Across languages
 * the same-language measure still counts (a name-heavy title can clear it on
 * its own), and the cross-language one is added beside it. `stop` is the
 * topic's stopwords.
 */
export function likeness(a: Features, b: Features, across = false, stop: ReadonlySet<string> = NONE): number {
  return pair(topicFeatures(a, stop), topicFeatures(b, stop), across, stop).score;
}

/** The names of a feature set in either language's spelling (`guinee` and `guinea`). */
function namesOf(f: Features): Set<string> {
  const out = new Set(f.entities);
  for (const e of f.entities) {
    const concept = crossConcept(e);
    if (concept) out.add(concept.replace(/^!/, ''));
  }
  return out;
}

/**
 * The terms too common in a topic right now to say two articles tell one
 * story: in at least `COMMON_SHARE` of these stories, and at least
 * `COMMON_MIN` of them. A story counts once however many articles it has.
 */
export function commonTerms(stories: OpenStory[]): Set<string> {
  const count = new Map<string, number>();
  for (const story of stories) {
    const seen = new Set<string>();
    for (const m of story.members) for (const k of featuresOf(m.sequence).weights.keys()) seen.add(k);
    for (const k of seen) count.set(k, (count.get(k) ?? 0) + 1);
  }
  const floor = Math.max(COMMON_MIN, stories.length * COMMON_SHARE);
  return new Set([...count].filter(([, n]) => n >= floor).map(([k]) => k));
}

/** One clustering pass's reading of its articles, by the topic's stopwords and, with vectors, its direction. */
class Reader {
  private cache = new Map<ClusterArticle, Features>();
  private vectors = new Map<ClusterArticle, Float32Array | undefined>();
  constructor(readonly stop: ReadonlySet<string>, readonly topicVector?: Float32Array) {}
  read(a: ClusterArticle): Features {
    let f = this.cache.get(a);
    if (!f) this.cache.set(a, (f = topicFeatures(featuresOf(a.sequence), this.stop)));
    return f;
  }
  /** The article's meaning without the topic's, or nothing when there is no topic vector or no article vector. */
  vector(a: ClusterArticle): Float32Array | undefined {
    if (!this.topicVector || !a.vector || a.vector.length !== this.topicVector.length) return undefined;
    if (!this.vectors.has(a)) this.vectors.set(a, without(a.vector, this.topicVector));
    return this.vectors.get(a);
  }
}

/** Both name things and share none of it, in either language's spelling: never one story, whatever else they share. */
function namesApart(a: Features, b: Features): boolean {
  const x = namesOf(a);
  if (x.size === 0) return false;
  const y = namesOf(b);
  return y.size > 0 && ![...x].some((n) => y.has(n));
}

const topMean = (scores: number[]): number => {
  const top = [...scores].sort((x, y) => y - x).slice(0, Math.min(TOP_K, Math.ceil(scores.length / 2)));
  return top.length === 0 ? 0 : top.reduce((s, x) => s + x, 0) / top.length;
};

/** How an article stands against a story: its likeness, whether it joins, and which road decided. */
export interface StoryMatch {
  score: number;
  joins: boolean;
  by: 'wording' | 'meaning' | 'band' | 'words' | 'refused';
}

function storyScore(article: ClusterArticle, story: OpenStory, reader: Reader): StoryMatch {
  const refused: StoryMatch = { score: 0, joins: false, by: 'refused' };
  if (story.members.length === 0) return refused;
  const byTime = [...story.members].sort((x, y) => x.publishedAt.getTime() - y.publishedAt.getTime() || x.id.localeCompare(y.id));
  const seed = byTime[0]!;
  if (!!seed.deal !== !!article.deal) return refused;
  const mine = reader.read(article);
  const myVector = reader.vector(article);
  const scores: number[] = [];
  const cosines: number[] = [];
  let same = 0;
  for (const member of byTime.slice(-COMPARE_MAX)) {
    if (!!member.deal !== !!article.deal) continue;
    const theirs = reader.read(member);
    const across = !!article.language && !!member.language && article.language !== member.language;
    const p = pair(mine, theirs, across, reader.stop);
    if (p.same) same = Math.max(same, p.score);
    scores.push(p.score);
    const v = myVector && reader.vector(member);
    if (myVector && v) cosines.push(namesApart(mine, theirs) ? 0 : dot(myVector, v));
  }
  if (same > 0) return { score: same, joins: true, by: 'wording' };
  // The story's first article names what it is about.
  const seedNames = namesOf(reader.read(seed));
  const myNames = namesOf(mine);
  if (seedNames.size > 0 && myNames.size > 0 && ![...myNames].some((n) => seedNames.has(n))) return refused;
  const words = topMean(scores);
  if (cosines.length === 0) return { score: words, joins: words >= MERGE_THRESHOLD, by: 'words' };
  const meaning = topMean(cosines);
  if (meaning >= MEANING_MERGE) return { score: meaning, joins: true, by: 'meaning' };
  if (meaning >= MEANING_BAND) return { score: meaning, joins: words >= MERGE_THRESHOLD, by: 'band' };
  return { score: meaning, joins: false, by: 'meaning' };
}

function best(article: ClusterArticle, stories: OpenStory[], reader: Reader): { id: string; score: number } | null {
  let found: { id: string; score: number } | null = null;
  for (const story of stories) {
    if (Math.abs(article.publishedAt.getTime() - story.updatedAt.getTime()) > WINDOW_MS) continue;
    const match = storyScore(article, story, reader);
    if (match.joins && (!found || match.score > found.score)) found = { id: story.id, score: match.score };
  }
  return found;
}

/**
 * The best open story for an article, or null when it starts one. `stop` is
 * the topic's stopwords; `topicVector` the topic name's meaning, without
 * which vectors are not used.
 */
export function bestStory(
  article: ClusterArticle,
  stories: OpenStory[],
  stop: ReadonlySet<string> = NONE,
  topicVector?: Float32Array,
): { id: string; score: number } | null {
  return best(article, stories, new Reader(stop, topicVector));
}

/** How an article stands against one story, for tests and diagnostics. */
export function matchStory(article: ClusterArticle, story: OpenStory, stop: ReadonlySet<string> = NONE, topicVector?: Float32Array): StoryMatch {
  return storyScore(article, story, new Reader(stop, topicVector));
}

function pass(incoming: ClusterArticle[], open: OpenStory[], newId: () => string, stop: ReadonlySet<string>, topicVector?: Float32Array) {
  const reader = new Reader(stop, topicVector);
  const stories = open.map((s) => ({ ...s, members: [...s.members] }));
  const assignments = new Map<string, string>();
  const created: string[] = [];
  for (const article of [...incoming].sort((a, b) => a.publishedAt.getTime() - b.publishedAt.getTime() || a.id.localeCompare(b.id))) {
    const found = best(article, stories, reader);
    if (found) {
      const story = stories.find((s) => s.id === found.id)!;
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
  return { assignments, created, stories };
}

/**
 * Assign each new article, oldest first, to an open story or a new one.
 * New stories are opened as they are made, so two new articles of the same
 * story in one fetch land together. `newId` names a new story; `topic` holds
 * the topic's own words (`topicTerms`).
 *
 * Twice when need be: a first pass by the topic's own words, then, when some
 * terms turn out to run through `COMMON_SHARE` of the stories it made, a
 * second with those as stopwords too. Counting stories, not articles, keeps a
 * story told by twenty outlets from making its own words common.
 *
 * `topicVector`, the topic name's meaning from the same model as the
 * articles' vectors, turns meaning on; without it, words alone decide.
 */
export function assignStories(
  incoming: ClusterArticle[],
  open: OpenStory[],
  newId: () => string,
  topic: ReadonlySet<string> = NONE,
  topicVector?: Float32Array,
): { assignments: Map<string, string>; created: string[] } {
  let drafts = 0;
  const draft = pass(incoming, open, () => `draft:${drafts++}`, topic, topicVector);
  const common = commonTerms(draft.stories);
  const extra = [...common].filter((t) => !topic.has(t));
  const stop = extra.length === 0 ? topic : new Set([...topic, ...extra]);
  if (extra.length === 0) {
    // Name the draft's new stories for real, in the order they were made.
    const names = new Map(draft.created.map((d) => [d, newId()]));
    const assignments = new Map([...draft.assignments].map(([a, s]) => [a, names.get(s) ?? s]));
    return { assignments, created: [...names.values()] };
  }
  const { assignments, created } = pass(incoming, open, newId, stop, topicVector);
  return { assignments, created };
}
