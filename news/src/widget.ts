/**
 * Top stories (spec §7, the kit's Widgets.jsx and LockScreen.jsx): small is
 * three headlines with their outlet's logo, wrapping to two lines; medium is
 * five rows with the outlet and the age on the right; the lock screen draws
 * the medium one compact. Untold first. A placement set to some topics names
 * itself after them ("Top stories · AI, US politics"); none ticked is every
 * topic. Needs host API 1.27 for the logos, `max: 5` and `wrap`.
 */
import type { WidgetBody, WidgetDefinition } from '@buddi/core/plugin';
import { shortAgo } from './format.js';
import { rankedStories, type RankedStory } from './reads.js';

export const TOP_REFRESH_S = 600;

/** The first outlet's logo key and short name: "The Verge" → "Verge", as the kit's rows say it. */
function outletOf(r: RankedStory): { name: string; logo: string | null } {
  const lead = r.articles.find((a) => a.outlet === r.summary.outlet) ?? r.articles[0];
  return { name: (lead?.outlet ?? r.summary.outlet).replace(/^The /, ''), logo: lead?.logo ?? null };
}

/** The row's right: the outlet cut so the age always shows, within the 24 characters a row's side keeps. */
export function sideWords(outlet: string, age: string): string {
  const room = 24 - age.length - 3;
  const name = outlet.length > room ? `${outlet.slice(0, Math.max(1, room - 1)).trimEnd()}…` : outlet;
  return `${name} · ${age}`;
}

/** Untold first (new, then updates), then what was told, each in rank order. */
export function untoldFirst(stories: RankedStory[]): RankedStory[] {
  const weight = (r: RankedStory): number => (r.summary.status === 'new' ? 0 : r.summary.status === 'update' ? 1 : 2);
  return [...stories].sort((a, b) => weight(a) - weight(b) || b.summary.score - a.summary.score);
}

export const topStoriesWidget: WidgetDefinition = {
  id: 'news.top',
  title: 'Top stories',
  sizes: ['small', 'medium'],
  refreshSeconds: TOP_REFRESH_S,
  link: { page: 'stories' },
  settings: [
    {
      key: 'topics',
      kind: 'multiselect',
      label: 'Topics',
      hint: 'None ticked: every topic.',
      inTitle: true,
      options: async (ctx) => {
        const { rows } = await ctx.buddi!.db.query<{ id: string; name: string }>(`select id, name from news.topics order by position, name`);
        return rows.map((r) => ({ value: r.id, label: r.name }));
      },
    },
    {
      key: 'show',
      kind: 'select',
      label: 'Show',
      default: 'top',
      options: [{ value: 'top', label: 'Top stories' }, { value: 'untold', label: 'Not yet told' }],
    },
  ],
  // Sample data for withbuddi.com and Browse (read by `buddi plugins describe`, never by the running host).
  preview: {
    small: {
      kind: 'list',
      wrap: true,
      rows: [
        { title: 'Central banks hold rates as inflation cools' },
        { title: 'A comet bright enough to see is passing this week' },
        { title: 'Lyon opens its third tram line' },
      ],
    },
    medium: {
      kind: 'list',
      max: 5,
      rows: [
        { title: 'Central banks hold rates as inflation cools', side: 'Reuters · 1 h' },
        { title: 'A comet bright enough to see is passing this week', side: 'BBC · 2 h' },
        { title: 'Lyon opens its third tram line', side: 'Le Progrès · 3 h' },
        { title: 'The new phone that folds twice', side: 'The Verge · 4 h' },
        { title: 'A quiet start to the Champions League', side: 'L’Équipe · 5 h' },
      ],
    },
  },
  async produce(ctx, request): Promise<WidgetBody | null> {
    const buddi = ctx.buddi!;
    const db = buddi.db;
    const now = buddi.clock.now();
    const settings = request.settings ?? {};
    const { rows: topics } = await db.query<{ id: string }>(`select id from news.topics`);
    if (topics.length === 0) return { kind: 'text', icon: 'globe', text: 'Turn on the starter sources on Settings → News to see the news here.' };
    const known = new Set(topics.map((t) => t.id));
    const picked = Array.isArray(settings.topics) ? (settings.topics as string[]).filter((t) => known.has(t)) : [];
    const untoldOnly = settings.show === 'untold';
    const language = ((await buddi.owner.language().catch(() => undefined)) ?? 'en').slice(0, 2);
    const ranked = await rankedStories(db, now, { n: 60, since: new Date(now.getTime() - 24 * 3600_000), untold: untoldOnly, ownerLanguage: language });
    const shown = untoldFirst(picked.length > 0 ? ranked.filter((r) => picked.includes(r.summary.topicId)) : ranked);
    if (shown.length === 0) {
      return untoldOnly
        ? { kind: 'text', icon: 'check', text: 'Nothing new since your last edition.' }
        : { kind: 'text', icon: 'check', text: picked.length > 0 ? 'Nothing new in these topics.' : 'Nothing new in the last day.' };
    }
    const medium = request.size === 'medium';
    const rows = shown.slice(0, medium ? 5 : 3).map((r) => {
      const outlet = outletOf(r);
      return {
        title: r.summary.title,
        ...(medium ? { side: sideWords(outlet.name, shortAgo(new Date(r.summary.updatedAt), now)) } : {}),
        // With no kept logo, the outlet's letter holds the row's place (host API 1.27's `image.label`).
        image: { ...(outlet.logo ? { asset: outlet.logo } : {}), label: outlet.name },
      };
    });
    return medium ? { kind: 'list', max: 5, rows } : { kind: 'list', wrap: true, rows } as WidgetBody;
  },
};
