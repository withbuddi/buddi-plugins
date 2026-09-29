/**
 * @withbuddi/plugin-calendar — the owner's calendars, read from their private
 * ICS links, so agents know the day.
 *
 * A private link is a credential: anyone with it reads the calendar. So it is
 * an owner secret from the moment it is typed, bound to core's `http.url`
 * destination for this plugin and the link's host, and fetched through
 * `ctx.buddi.http` with `auth: { secret, as: 'url' }` (host API 1.9): core
 * inserts it, this plugin never reads it, and no other plugin can fetch it.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PluginManifest } from '@buddi/core/plugin';
import { addCalendarTool, calendarPages, calendarQueries, removeCalendarTool } from './settings.js';
import { calendarTools } from './tools.js';
import { nextMeetingGlance } from './home.js';
import { calendarViews } from './views.js';
import { agendaPage, agendaQuery } from './agenda.js';
import { VERSION } from './version.js';

export const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

export const manifest: PluginManifest = {
  name: 'calendar',
  version: VERSION,
  schema: 'calendar',
  migrationsDir: MIGRATIONS_DIR,
  author: { name: 'withbuddi', url: 'https://withbuddi.com' },
  description:
    'Reads your Google, iCloud or Outlook calendars from their private links, kept like passwords, so your agents ' +
    'know today, the coming days and your free time. Read-only.',
  network: [
    { host: 'calendar.google.com', why: 'Google calendars: buddi reads the secret iCal address you linked. Nothing is sent.' },
    { host: '*.icloud.com', why: 'iCloud calendars: buddi reads the public calendar link you linked. Nothing is sent.' },
    { host: 'outlook.office365.com', why: 'Outlook calendars (work or school): buddi reads the published ICS link. Nothing is sent.' },
    { host: 'outlook.live.com', why: 'Outlook calendars (personal): buddi reads the published ICS link. Nothing is sent.' },
  ],
  uses: ['http', 'secrets'],
  tools: [...calendarTools, addCalendarTool, removeCalendarTool],
  pages: [...calendarPages, agendaPage],
  queries: [...calendarQueries, agendaQuery],
  views: calendarViews,
  home: [nextMeetingGlance],
};

export default manifest;

export * from './ics.js';
export * from './time.js';
export * from './store.js';
export * from './tools.js';
export * from './settings.js';
export * from './views.js';
export * from './home.js';
export * from './agenda.js';
