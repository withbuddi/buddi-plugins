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
import { featuresOf, jaccard, weightedJaccard, type Features, type TermSet } from './text.js';

export const WINDOW_MS = 48 * 3600_000;
export const MERGE_THRESHOLD = 0.3;
/** Shingle likeness that overrides the entity rule: the same sentence, near enough. */
export const SAME_WORDING = 0.5;
/** At most this many of a story's articles are compared, the newest. */
export const COMPARE_MAX = 24;

export interface ClusterArticle {
  id: string;
  publishedAt: Date;
  sequence: string[];
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
 * How alike two articles are, 0 to 1: title and lead against title and lead,
 * or title against title when either has no lead (a Google News item is a
 * title alone, and a lead would only dilute what it shares).
 */
export function likeness(a: Features, b: Features): number {
  return a.hasLead && b.hasLead ? alike(a, b) : alike(a.title, b.title);
}

/** The best open story for an article, or null when it starts one. */
export function bestStory(article: ClusterArticle, stories: OpenStory[]): { id: string; score: number } | null {
  const mine = featuresOf(article.sequence);
  let best: { id: string; score: number } | null = null;
  for (const story of stories) {
    if (Math.abs(article.publishedAt.getTime() - story.updatedAt.getTime()) > WINDOW_MS) continue;
    const members = [...story.members].sort((x, y) => y.publishedAt.getTime() - x.publishedAt.getTime()).slice(0, COMPARE_MAX);
    for (const member of members) {
      const score = likeness(mine, featuresOf(member.sequence));
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
  for (const article of [...incoming].sort((a, b) => a.publishedAt.getTime() - b.publishedAt.getTime())) {
    const best = bestStory(article, stories);
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
