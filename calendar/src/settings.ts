/**
 * Settings → Calendar: add a calendar by its private link, see how each one
 * reads, remove one. The link is an owner secret from the moment it is saved
 * (`secrets.put`, bound to core's `http.url` for this plugin and the link's
 * host); the row keeps only the secret's name. Writes are `ownerOnly` tools.
 */
import { z } from 'zod';
import type { PageDescriptor, PageQuery, ToolDefinition } from '@buddi/core/plugin';
import { parseIcs } from './ics.js';
import { declareHost, dropCache, fetchIcs, listCalendars, normaliseLink, providerOf, remember } from './store.js';

export const CALENDAR_NOTICE =
  "Anyone with a private calendar link can read that calendar, so buddi keeps it like a password: in buddi's " +
  'vault, never shown again, and fetched only by this plugin. Reading is all it does; nothing is ever ' +
  'written to your calendar.';

/**
 * Where each provider keeps the private link: the exact clicks, one block
 * each. The page grammar links only inside buddi, so Google's help page is
 * named as text rather than as a link.
 */
export const PROVIDER_HELP = [
  'Google: open Google Calendar on the web → Settings (the gear) → under "Settings for my calendars" pick the ' +
    'calendar → Integrate calendar → "Secret address in iCal format" → the copy button beside it.',
  'Google, careful: not the Public address, which only works for a calendar you made public. If the secret link ' +
    'ever leaks, Reset beside it makes the old ' +
    'one stop working. A work or school account may have it turned off by its administrator. Google\'s help: ' +
    'support.google.com/calendar/answer/37648.',
  'iCloud: in the Calendar app (or at icloud.com/calendar), share the calendar → tick Public Calendar → copy the ' +
    'link. Unlike Google\'s, this link is public: anyone who has it can read the calendar, though nobody can find ' +
    'it without it.',
  'Outlook: on outlook.com or Outlook on the web, Settings (the gear) → Calendar → Shared calendars → Publish a ' +
    'calendar → pick the calendar and "Can view all details" → Publish → copy the ICS link.',
];

export const calendarQueries: PageQuery[] = [
  {
    name: 'settings',
    params: z.object({}),
    async produce(_params, ctx) {
      const rows = await listCalendars(ctx.buddi!.db);
      return {
        calendars: rows.map((r) => ({
          id: r.id,
          name: r.name,
          provider: r.provider,
          host: r.host,
          events: r.eventCount ?? '',
          lastRead: r.lastFetchedAt?.toISOString() ?? '',
          state: r.lastError
            ? [{ value: 'cannot read', tone: 'danger' }]
            : r.lastFetchedAt
              ? [{ value: 'reads', tone: 'good' }]
              : [{ value: 'not read yet', tone: 'neutral' }],
          problem: r.lastError ?? '',
        })),
      };
    },
  },
];

/** `Work` → `work`. */
export function idOf(name: string): string {
  return name.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'calendar';
}

export const secretNameFor = (name: string): string => `Calendar link: ${name}`;

const addInput = z
  .object({
    name: z.string().trim().min(1).max(60),
    link: z.string().trim().min(10).max(2000),
  })
  .strict();

export const addCalendarTool: ToolDefinition<z.infer<typeof addInput>, { note: string }> = {
  name: 'calendar.add',
  description: 'Link a calendar by its private ICS address. The owner\'s own.',
  tier: 'auto',
  ownerOnly: true,
  input: addInput,
  async execute(input, ctx) {
    const buddi = ctx.buddi!;
    if (buddi.secrets === undefined) throw new Error('This buddi cannot keep secrets, so a calendar link cannot be stored.');
    const name = input.name.replace(/\s+/g, ' ');
    const existing = await listCalendars(buddi.db);
    if (existing.some((c) => c.name.toLowerCase() === name.toLowerCase())) {
      throw new Error(`You already have a calendar called ${name}. Remove it first, or pick another name.`);
    }
    const { link, host } = normaliseLink(input.link);
    let id = idOf(name);
    for (let n = 2; existing.some((c) => c.id === id); n++) id = `${idOf(name)}-${n}`;
    const secretName = secretNameFor(name);
    declareHost(buddi, host);
    await buddi.secrets.put(secretName, link, [
      { kind: 'http.url', target: { plugin: 'calendar', host }, rule: 'pre-approved' },
    ]);
    // Read it once before keeping it: a link that does not answer with a
    // calendar is said now, not at tomorrow's brief.
    let events: ReturnType<typeof parseIcs>;
    try {
      events = parseIcs(await fetchIcs(buddi, host, secretName));
    } catch (err) {
      await buddi.secrets.delete(secretName).catch(() => false);
      throw new Error(`buddi could not read that calendar: ${err instanceof Error ? err.message : String(err)}`);
    }
    await buddi.db.query(
      `insert into calendar.calendar (id, name, provider, host, secret_name, last_fetched_at, event_count)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [id, name, providerOf(host), host, secretName, buddi.clock.now(), events.length],
    );
    remember(id, events, buddi.clock.now());
    const count = events.length;
    return { note: `Linked ${name} (${providerOf(host)}): ${count} ${count === 1 ? 'event' : 'events'} read. The link is kept as a secret.` };
  },
};

const removeInput = z.object({ id: z.string().min(1).max(60) }).strict();

export const removeCalendarTool: ToolDefinition<z.infer<typeof removeInput>, { note: string }> = {
  name: 'calendar.remove',
  description: 'Unlink a calendar and forget its link. The owner\'s own.',
  tier: 'auto',
  ownerOnly: true,
  input: removeInput,
  async execute(input, ctx) {
    const buddi = ctx.buddi!;
    const row = (await listCalendars(buddi.db)).find((c) => c.id === input.id);
    if (!row) throw new Error('That calendar is not linked.');
    await buddi.secrets?.delete(row.secretName).catch(() => false);
    await buddi.db.query(`delete from calendar.calendar where id = $1`, [row.id]);
    dropCache(row.id);
    return { note: `Unlinked ${row.name}, and forgot its link.` };
  },
};

export const calendarPages: PageDescriptor[] = [
  {
    id: 'settings',
    title: 'Calendar',
    place: 'settings',
    icon: 'calendar',
    body: [
      { kind: 'notice', text: CALENDAR_NOTICE },
      {
        kind: 'section',
        title: 'Calendars',
        note: 'Each is read at most every ten minutes, when an agent asks.',
        body: [
          {
            kind: 'table',
            query: { query: 'settings' },
            rows: 'calendars',
            columns: [
              { key: 'name', label: 'Name' },
              { key: 'provider', label: 'From' },
              { key: 'events', label: 'Events' },
              { key: 'lastRead', label: 'Last read', type: 'date' },
              { key: 'state', label: 'State', pill: {} },
              { key: 'problem', label: 'Problem', fit: 'wrap' },
            ],
            actions: [
              {
                tool: 'calendar.remove',
                label: 'Remove',
                tone: 'danger',
                confirm: 'Remove {name}? buddi forgets its link. The calendar itself is untouched.',
                done: { path: 'note' },
                args: { id: { row: 'id' } },
              },
            ],
            empty: 'No calendar yet. Add one with its private link.',
          },
          {
            kind: 'form',
            drawer: { title: 'Add a calendar', button: 'Add a calendar' },
            fields: [
              { name: 'name', label: 'Name', type: 'text', required: true, hint: 'What you call it: Work, Family.' },
              {
                name: 'link',
                label: 'Private link',
                type: 'secret',
                required: true,
                hint: "The calendar's private ICS address, https:// or webcal://. Where each service keeps it is under How to find the link.",
              },
            ],
            submit: {
              tool: 'calendar.add',
              label: 'Add the calendar',
              tone: 'accent',
              busy: 'Reading it…',
              done: { path: 'note' },
              then: 'close',
              args: { name: { field: 'name' }, link: { field: 'link' } },
            },
          },
        ],
      },
      {
        kind: 'expand',
        query: { query: 'settings' },
        label: 'How to find the link',
        body: PROVIDER_HELP.map((text) => ({ kind: 'notice' as const, text })),
      },
    ],
  },
];
