/**
 * Whether the news can do anything yet, and the two reads another plugin may
 * call (host API 1.18).
 *
 * `setup`: with no source, "Add a topic or turn on the starter sources";
 * with sources none of which has answered yet, "Reading your sources for the
 * first time"; ready once one has.
 *
 * `exports.headlines` and `exports.story`: the same reads as the tools of the
 * same names, for a plugin that requires this one. They read, and only read:
 * telling a story is recorded with `news.mark_told`.
 */
import type { PluginExport, PluginSetup } from '@buddi/core/plugin';
import { headlinesInput, readHeadlines, readStory, storyInput } from './tools.js';

export const SETUP_NOTE = 'Add a topic or turn on the starter sources.';
export const FIRST_READ_NOTE = 'Reading your sources for the first time.';

export const newsSetup: PluginSetup = {
  async produce(ctx) {
    const { rows } = await ctx.buddi!.db.query<{ sources: number; answered: number }>(
      `select count(*)::int as sources, count(*) filter (where last_ok_at is not null)::int as answered from news.sources where not muted`,
    );
    const r = rows[0] ?? { sources: 0, answered: 0 };
    if (r.sources === 0) return { ready: false, note: SETUP_NOTE };
    return r.answered > 0 ? { ready: true } : { ready: false, note: FIRST_READ_NOTE };
  },
};

export const headlinesExport: PluginExport = {
  description: 'The top news stories for one of the owner\'s topics (or all), in rank order, with title, lead, link, outlets, times and whether each was told; untold for what has not been.',
  params: headlinesInput,
  produce: (params, ctx) => readHeadlines(ctx.buddi!, params),
};

export const storyExport: PluginExport = {
  description: 'One news story with every article on it, its timeline, and when it was told.',
  params: storyInput,
  async produce(params: { id: string }, ctx) {
    return (await readStory(ctx.buddi!, params.id)) ?? null;
  },
};
