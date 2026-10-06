/**
 * @withbuddi/plugin-news — the news on the topics the owner follows, from
 * feeds they can see, grouped into stories on this machine.
 *
 * The data layer: the `news` schema (topics, sources and their health,
 * outlets and their logos, articles, stories, editions and what each told,
 * settings), one timer (`news.fetch`, every minute, fetching what is due), six tools a model
 * sees (`tools.ts`), owner-only tools and page queries for the settings page
 * to come (`settings.ts`), readiness, and two exports. Pages and widgets
 * read the same functions (`reads.ts`) when they come.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PluginManifest } from '@buddi/core/plugin';
import { fetchSourceDefinition } from './poller.js';
import { newsQueries, ownerTools } from './settings.js';
import { dashboardQueries, newsPages } from './dashboard.js';
import { editionMaterialExport, editionTools } from './edition.js';
import { topStoriesWidget } from './widget.js';
import { headlinesExport, newsSetup, storyExport } from './setup.js';
import { starterHosts } from './starter.js';
import { modelTools } from './tools.js';
import { VERSION } from './version.js';

export const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

/** Why each declared host is reached, for the install card. */
export function whyHost(host: string): string {
  if (host === 'news.google.com') return 'Google News searches for your topics: the topic\'s keywords go, headlines come back; each headline\'s Google page is asked once for the outlet\'s own link.';
  if (host === 'hn.algolia.com') return 'Hacker News\'s front page, through Algolia: nothing goes, the list comes back.';
  if (host === 'api.gdeltproject.org') return 'GDELT\'s article index: a topic\'s query goes, headlines come back.';
  if (host === 'huggingface.co') return 'Download on Settings → News: the meaning model\'s files (135 MB), pinned and checked; nothing is sent.';
  if (host === '*.hf.co') return 'Hugging Face\'s download servers (us.aws.cdn.hf.co and its like), where huggingface.co sends those files.';
  if (host.startsWith('*.')) return 'An outlet\'s site: asked for its icon, once a month at most.';
  return 'A news feed or an outlet\'s site: asked for its latest items, or its icon.';
}

/** Where Download on Settings → News fetches the meaning model from (`meaning.ts`). */
export const MODEL_HOSTS = ['huggingface.co', '*.hf.co'];

export const manifest: PluginManifest = {
  name: 'news',
  version: VERSION,
  schema: 'news',
  migrationsDir: MIGRATIONS_DIR,
  author: { name: 'withbuddi', url: 'https://withbuddi.com' },
  description:
    'The news on the topics you follow, from English and French feeds you can see and change, grouped into stories on ' +
    'your own machine, with what was already told kept so nothing is told twice.',
  network: [...starterHosts(), ...MODEL_HOSTS].map((host) => ({ host, why: whyHost(host) })),
  uses: ['http', 'assets'],
  optional: { speech: '^0.1.3' },
  setup: newsSetup,
  exports: { headlines: headlinesExport, story: storyExport, edition_material: editionMaterialExport },
  tools: [...modelTools, ...editionTools, ...ownerTools],
  sources: [fetchSourceDefinition],
  queries: [...newsQueries, ...dashboardQueries],
  pages: newsPages,
  widgets: [topStoriesWidget],
};

export default manifest;

export * from './canonical.js';
export * from './cluster.js';
export * from './feed.js';
export * from './reads.js';
export * from './starter.js';
export * from './tools.js';
export * from './setup.js';
export * from './dashboard.js';
export * from './edition.js';
export * from './edition-view.js';
export * from './widget.js';
export * from './format.js';
export { MEANING_MODEL, isDownloaded as meaningDownloaded } from './meaning.js';
