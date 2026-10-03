/**
 * @withbuddi/plugin-calendar — the owner's calendars, so agents know the day,
 * and — in the calendars the owner allows — add, change and cancel events,
 * each one approved on a card.
 *
 * A calendar is read from its private ICS link, from a CalDAV account
 * (iCloud, Fastmail, any CalDAV server) signed in with an app password, or
 * from a Google account signed in with OAuth. Each is a credential, kept as an
 * owner secret: the link bound to core's `http.url` (host API 1.9), the
 * password to `http.basic` (1.26), the Google sign-in — which core runs and
 * keeps itself — to `http.bearer` (1.28), each for this plugin and its host.
 * Core inserts them into the requests; this plugin never reads them, and no
 * other plugin can use them.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PluginManifest } from '@buddi/core/plugin';
import { addCalendarTool, calendarPages, calendarQueries, removeCalendarTool } from './settings.js';
import { calendarTools } from './tools.js';
import { writeTools } from './write.js';
import { accountTools } from './accounts.js';
import { googleTools } from './google-accounts.js';
import { nextMeetingGlance, todayWidget } from './home.js';
import { calendarViews } from './views.js';
import { agendaPage, agendaQuery } from './agenda.js';
import { VERSION } from './version.js';
import { listAccounts, listCalendars } from './store.js';

export const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

export const manifest: PluginManifest = {
  name: 'calendar',
  version: VERSION,
  schema: 'calendar',
  migrationsDir: MIGRATIONS_DIR,
  author: { name: 'withbuddi', url: 'https://withbuddi.com' },
  description:
    'Reads your calendars — Google signed in with your account, iCloud, Fastmail or any CalDAV account linked with an ' +
    'app password, or Google and Outlook by their private links — so your agents know today, the coming days and your ' +
    'free time; in the calendars you allow, they add, change and cancel events, each one approved by you first.',
  network: [
    { host: 'www.googleapis.com', why: 'Google calendars you signed in to: buddi reads their events and the list of them, and writes the events you approve.' },
    { host: 'calendar.google.com', why: 'Google calendars: buddi reads the secret iCal address you linked. Nothing is sent.' },
    { host: '*.icloud.com', why: 'iCloud calendars: buddi reads the calendars you linked, and writes the events you approve.' },
    { host: 'caldav.fastmail.com', why: 'Fastmail calendars: buddi reads the calendars you linked, and writes the events you approve.' },
    { host: 'outlook.office365.com', why: 'Outlook calendars (work or school): buddi reads the published ICS link. Nothing is sent.' },
    { host: 'outlook.live.com', why: 'Outlook calendars (personal): buddi reads the published ICS link. Nothing is sent.' },
  ],
  uses: ['http', 'secrets', 'owner:notify'],
  tools: [...calendarTools, ...writeTools, addCalendarTool, removeCalendarTool, ...accountTools, ...googleTools],
  pages: [...calendarPages, agendaPage],
  queries: [...calendarQueries, agendaQuery],
  views: calendarViews,
  home: [nextMeetingGlance],
  widgets: [todayWidget],
  // Nothing to read until a calendar is linked (host API 1.18): the Plugins row says so and opens Settings → Calendar.
  // A Google sign-in Google stopped accepting is said here too, while it leaves nothing else to read.
  setup: {
    async produce(ctx) {
      const db = ctx.buddi!.db;
      const [linked, accounts] = await Promise.all([listCalendars(db), listAccounts(db)]);
      if (linked.length === 0) return { ready: false, note: 'Link a calendar to start.', page: 'settings' };
      const signedOut = accounts.filter((a) => a.needsSignIn);
      const readable = linked.filter((c) => !c.accountId || !signedOut.some((a) => a.id === c.accountId));
      if (signedOut.length > 0 && readable.length === 0) {
        return { ready: false, note: `Sign in to Google again (${signedOut.map((a) => a.username).join(', ')}).`, page: 'settings' };
      }
      return { ready: true };
    },
  },
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
export * from './write.js';
export * from './accounts.js';
export * from './google.js';
export * from './google-accounts.js';
export * from './google-client.js';
export * from './caldav.js';
export * from './icalwrite.js';
export * from './xml.js';
export * from './ids.js';
