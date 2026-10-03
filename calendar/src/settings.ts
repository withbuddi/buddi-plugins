/**
 * Settings → Calendar: the calendars agents read, each with what agents may
 * do in it; a private link added or removed; an account linked with an app
 * password (`accounts.ts`), its calendars linked or unlinked and allowed
 * changes or kept read-only; and how to find a link or make an app password.
 * A link or a password is an owner secret from the moment it is saved; rows
 * keep only the secret's name. Writes are `ownerOnly` tools.
 */
import { z } from 'zod';
import type { PageDescriptor, PageQuery, ToolDefinition } from '@buddi/core/plugin';
import { parseIcs } from './ics.js';
import { idOf } from './ids.js';
import { declareHost, dropCache, fetchIcs, listAccounts, listAllCalendars, listCalendars, normaliseLink, providerOf, remember } from './store.js';
import { pendingSignIn } from './google-accounts.js';

export { idOf };

export const CALENDAR_NOTICE =
  'A private link reads a calendar; an account you sign in to — Google, or iCloud and Fastmail with an app password — ' +
  "can also be written to, once you allow it. buddi keeps every link, password and sign-in in its vault, never shown " +
  'again, used only by this plugin. Every change an agent makes is asked on a card first.';

/** What buddi asks Google for, and what testing mode means until Google has reviewed buddi. */
export const GOOGLE_HELP = [
  'The events of your calendars — to read your day and add, change or cancel the events you approve — and the list ' +
    'of your calendars, to show them here. Nothing else: not your mail, contacts or files.',
  'The sign-in is kept in buddi’s vault and sent only to Google’s calendar service. Sign out here, or remove buddi at ' +
    'myaccount.google.com/connections, and it stops.',
  'While Google is still reviewing buddi, Google shows a warning that the app is unverified, only accounts Google lets ' +
    'test it can sign in, and a sign-in lasts seven days: buddi tells you when to sign in again.',
];

/** How to make an app password, per service, and what agents cannot do. */
export const APP_PASSWORD_HELP = [
  'iCloud: sign in at account.apple.com → Sign-In and Security → App-Specific Passwords → Generate (two-factor ' +
    'authentication must be on) → name it "buddi" → copy the password. Sign in here with your Apple ID and that password.',
  'Fastmail: Settings → Privacy & Security → Manage app passwords and access → New app password → access ' +
    '"Calendars (CalDAV)" → copy it. Sign in here with your Fastmail address and that password.',
  'Another server (Nextcloud, Radicale, Baïkal…): its CalDAV address — Nextcloud\'s is https://your-server/remote.php/dav — ' +
    'and an app password if it offers them. buddi signs in over HTTPS, on the standard port, only.',
  'What agents can\'t do: invite people, or change one occurrence of a repeating event — they change or cancel the ' +
    'whole series, and cancelling a series is asked on its own.',
];

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
  'A private link only reads. To let agents add events, sign in with Google, or link the account with an app password (iCloud, Fastmail, CalDAV).',
];

/** The state pill of a calendar: how its last read went. */
function stateOf(r: { lastError: string | null; lastFetchedAt: Date | null }): Array<{ value: string; tone: string }> {
  if (r.lastError) return [{ value: 'cannot read', tone: 'danger' }];
  if (r.lastFetchedAt) return [{ value: 'reads', tone: 'good' }];
  return [{ value: 'not read yet', tone: 'neutral' }];
}

export const calendarQueries: PageQuery[] = [
  {
    name: 'settings',
    params: z.object({}),
    async produce(_params, ctx) {
      const buddi = ctx.buddi!;
      const db = buddi.db;
      const [all, accounts, pending] = await Promise.all([listAllCalendars(db), listAccounts(db), pendingSignIn(buddi)]);
      const accountName = new Map(accounts.map((a) => [a.id, `${a.label} · ${a.username}`]));
      const signedOut = accounts.filter((a) => a.needsSignIn);
      const renewing = pending?.accountId ? accounts.find((a) => a.id === pending.accountId) : undefined;
      return {
        hasAccounts: accounts.length > 0,
        defaultService: 'icloud',
        // Sign in with Google needs a buddi that runs sign-ins (host API 1.28).
        googleAvailable: typeof buddi.secrets?.signIn === 'function' && pending === undefined,
        hasGoogleSignIn: pending !== undefined,
        googleSignIn: pending
          ? { id: pending.id, url: pending.url, renewing: renewing?.username ?? '' }
          : { id: '', url: '', renewing: '' },
        hasSignedOut: signedOut.length > 0,
        signedOut:
          signedOut.length === 0
            ? ''
            : `Google stopped accepting buddi’s sign-in to ${signedOut.map((a) => a.username).join(' and ')} (it was revoked, or its ` +
              'seven days ran out), so agents can’t read or change those calendars. Sign in again under Accounts: your calendar links stay as they are.',
        calendars: all
          .filter((r) => r.linked)
          .map((r) => ({
            id: r.id,
            name: r.name,
            color: r.color ?? '',
            kind: r.accountId ? 'account' : 'link',
            provider: r.accountId ? (accountName.get(r.accountId) ?? r.provider) : r.provider === 'Calendar link' ? r.provider : `${r.provider} (private link)`,
            may: [r.writable ? { value: 'add and change events', tone: 'accent' } : { value: 'read', tone: 'neutral' }],
            events: r.eventCount ?? '',
            lastRead: r.lastFetchedAt?.toISOString() ?? '',
            state: stateOf(r),
            problem: r.lastError ?? '',
          })),
        found: all
          .filter((r) => r.accountId)
          .map((r) => ({
            id: r.id,
            name: r.name,
            color: r.color ?? '',
            account: accountName.get(r.accountId!) ?? r.provider,
            linked: r.linked,
            writable: r.writable,
            // Allow changes is offered on a linked calendar the server did not say is read-only.
            canAllow: r.linked && !r.writable && r.canWrite !== false,
            state: [
              r.linked ? { value: 'linked', tone: 'good' } : { value: 'not linked', tone: 'neutral' },
              ...(r.writable ? [{ value: 'may change', tone: 'accent' }] : []),
              ...(r.canWrite === false ? [{ value: 'read-only there', tone: 'neutral' }] : []),
            ],
          })),
        accounts: accounts.map((a) => {
          const mine = all.filter((c) => c.accountId === a.id);
          return {
            id: a.id,
            kind: a.kind,
            label: a.label,
            username: a.username,
            needsSignIn: a.needsSignIn,
            canFind: !a.needsSignIn,
            calendars: `${mine.length} ${mine.length === 1 ? 'calendar' : 'calendars'} · ${mine.filter((c) => c.linked).length} linked`,
            state: a.needsSignIn
              ? [{ value: 'sign in again', tone: 'danger' }]
              : a.lastError
                ? [{ value: 'cannot sign in', tone: 'danger' }]
                : [{ value: 'signed in', tone: 'good' }],
            problem: a.needsSignIn ? '' : (a.lastError ?? ''),
          };
        }),
      };
    },
  },
];

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
    const existing = await listAllCalendars(buddi.db);
    if (existing.some((c) => c.linked && c.name.toLowerCase() === name.toLowerCase())) {
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
  description: 'Remove a calendar linked by its private link, and forget the link. The owner\'s own.',
  tier: 'auto',
  ownerOnly: true,
  input: removeInput,
  async execute(input, ctx) {
    const buddi = ctx.buddi!;
    const row = (await listCalendars(buddi.db)).find((c) => c.id === input.id);
    if (!row) throw new Error('That calendar is not linked.');
    if (row.accountId) throw new Error(`${row.name} belongs to a signed-in account: unlink it, or sign out of the account.`);
    if (row.secretName) await buddi.secrets?.delete(row.secretName).catch(() => false);
    await buddi.db.query(`delete from calendar.calendar where id = $1`, [row.id]);
    dropCache(row.id);
    return { note: `Unlinked ${row.name}, and forgot its link.` };
  },
};

const settingsRef = { query: 'settings' };

export const calendarPages: PageDescriptor[] = [
  {
    id: 'settings',
    title: 'Calendar',
    place: 'settings',
    icon: 'calendar',
    data: settingsRef,
    body: [
      { kind: 'notice', text: CALENDAR_NOTICE },
      { kind: 'notice', text: { path: 'signedOut' }, tone: 'warning', when: { path: 'hasSignedOut', equals: true } },
      {
        kind: 'section',
        title: 'Signing in to Google',
        when: { path: 'hasGoogleSignIn', equals: true },
        body: [
          { kind: 'notice', text: 'Allow buddi on Google’s page, then come back here and finish. buddi asks for the events of your calendars and their list, nothing else.' },
          {
            kind: 'button',
            action: { tool: 'calendar.google_cancel', label: 'Cancel', done: { path: 'note' }, then: 'refresh', args: { id: { path: 'googleSignIn.id' } } },
          },
          { kind: 'link', label: 'Continue to Google', to: { href: { path: 'googleSignIn.url' } } },
          {
            kind: 'form',
            drawer: { title: 'Google’s last page would not load?', button: 'Paste the address instead' },
            fields: [
              {
                name: 'pasted',
                label: 'That page’s address',
                type: 'text',
                required: true,
                hint: 'When buddi runs on another computer, Google’s last page cannot load here. Copy its whole address — it starts with http://127.0.0.1 — and paste it.',
              },
            ],
            submit: {
              tool: 'calendar.google_finish',
              label: 'Finish with this address',
              tone: 'accent',
              busy: 'Signing in…',
              done: { path: 'note' },
              then: 'close',
              args: { id: { path: 'googleSignIn.id' }, pasted: { field: 'pasted' } },
            },
          },
          {
            kind: 'button',
            action: {
              tool: 'calendar.google_finish',
              label: 'Finish signing in',
              tone: 'accent',
              busy: 'Reading your calendars…',
              done: { path: 'note' },
              then: 'refresh',
              args: { id: { path: 'googleSignIn.id' } },
            },
          },
        ],
      },
      {
        kind: 'section',
        title: 'Calendars',
        note: 'What your agents read, at most every ten minutes, when one asks.',
        body: [
          {
            kind: 'table',
            query: settingsRef,
            rows: 'calendars',
            columns: [
              { key: 'name', label: 'Name', swatch: 'color' },
              { key: 'provider', label: 'From' },
              { key: 'may', label: 'Agents may', pill: {} },
              { key: 'events', label: 'Events' },
              { key: 'lastRead', label: 'Last read', type: 'date' },
              { key: 'state', label: 'State', pill: {} },
              { key: 'problem', label: 'Problem', fit: 'wrap' },
            ],
            actions: [
              {
                tool: 'calendar.link_calendar',
                label: 'Unlink',
                when: { path: 'kind', equals: 'account' },
                confirm: 'Unlink {name}? Agents stop reading it. It stays in your account.',
                done: { path: 'note' },
                args: { id: { row: 'id' }, linked: { const: false } },
              },
              {
                tool: 'calendar.remove',
                label: 'Remove',
                tone: 'danger',
                when: { path: 'kind', equals: 'link' },
                confirm: 'Remove {name}? buddi forgets its link. The calendar itself is untouched.',
                done: { path: 'note' },
                args: { id: { row: 'id' } },
              },
            ],
            empty: 'No calendar yet. Sign in with Google, link an iCloud or Fastmail account with an app password, or add any calendar by its private link.',
          },
          {
            kind: 'form',
            drawer: { title: 'Add a calendar link', button: 'Add a calendar link' },
            fields: [
              { name: 'name', label: 'Name', type: 'text', required: true, hint: 'What you call it: Work, Family.' },
              {
                name: 'link',
                label: 'Private link',
                type: 'secret',
                required: true,
                hint: "The calendar's private ICS address, https:// or webcal://. Read only: agents can't change a linked calendar.",
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
          {
            kind: 'form',
            drawer: { title: 'Link with an app password', button: 'Link with an app password' },
            // The service starts on iCloud, the one most people have.
            initial: settingsRef,
            fields: [
              {
                name: 'service',
                label: 'Service',
                type: 'select',
                required: true,
                from: 'defaultService',
                options: [
                  { value: 'icloud', label: 'iCloud' },
                  { value: 'fastmail', label: 'Fastmail' },
                  { value: 'other', label: 'Another CalDAV server' },
                ],
              },
              {
                name: 'server',
                label: 'Server address',
                type: 'text',
                when: { path: 'service', equals: 'other' },
                hint: 'The CalDAV address your provider gives, https:// — Nextcloud: https://cloud.example.com/remote.php/dav.',
              },
              { name: 'username', label: 'Sign-in name', type: 'text', required: true, hint: 'Your Apple ID for iCloud; your Fastmail address for Fastmail.' },
              {
                name: 'password',
                label: 'App password',
                type: 'secret',
                required: true,
                hint: "An app-specific password, not your account password. Kept in buddi's vault and used only to sign in to this server.",
              },
            ],
            submit: {
              tool: 'calendar.link_account',
              label: 'Sign in and find calendars',
              tone: 'accent',
              busy: 'Signing in…',
              done: { path: 'note' },
              then: 'close',
              args: { service: { field: 'service' }, server: { field: 'server' }, username: { field: 'username' }, password: { field: 'password' } },
            },
          },
          {
            kind: 'button',
            when: { path: 'googleAvailable', equals: true },
            action: {
              tool: 'calendar.google_sign_in',
              label: 'Sign in with Google',
              tone: 'accent',
              busy: 'Starting…',
              done: { path: 'note' },
              then: 'refresh',
              args: {},
            },
          },
        ],
      },
      {
        kind: 'section',
        title: 'From your accounts',
        note: 'Every calendar your sign-ins found. Link the ones agents should read; allow changes on the ones they may add events to.',
        when: { path: 'hasAccounts', equals: true },
        body: [
          {
            kind: 'table',
            query: settingsRef,
            rows: 'found',
            columns: [
              { key: 'name', label: 'Calendar', swatch: 'color' },
              { key: 'account', label: 'Account' },
              { key: 'state', label: 'State', pill: {} },
            ],
            actions: [
              {
                tool: 'calendar.allow_changes',
                label: 'Allow changes',
                when: { path: 'canAllow', equals: true },
                done: { path: 'note' },
                args: { id: { row: 'id' }, writable: { const: true } },
              },
              {
                tool: 'calendar.allow_changes',
                label: 'Read only',
                when: { path: 'writable', equals: true },
                done: { path: 'note' },
                args: { id: { row: 'id' }, writable: { const: false } },
              },
              {
                tool: 'calendar.link_calendar',
                label: 'Unlink',
                when: { path: 'linked', equals: true },
                done: { path: 'note' },
                args: { id: { row: 'id' }, linked: { const: false } },
              },
              {
                tool: 'calendar.link_calendar',
                label: 'Link',
                tone: 'accent',
                when: { path: 'linked', equals: false },
                done: { path: 'note' },
                args: { id: { row: 'id' }, linked: { const: true } },
              },
            ],
            empty: 'This account holds no calendar with events.',
          },
          {
            kind: 'table',
            title: 'Accounts',
            query: settingsRef,
            rows: 'accounts',
            columns: [
              { key: 'label', label: 'Account' },
              { key: 'username', label: 'Signed in as' },
              { key: 'calendars', label: 'Calendars' },
              { key: 'state', label: 'State', pill: {} },
              { key: 'problem', label: 'Problem', fit: 'wrap' },
            ],
            actions: [
              {
                tool: 'calendar.google_sign_in',
                label: 'Sign in again',
                tone: 'accent',
                when: { path: 'needsSignIn', equals: true },
                busy: 'Starting…',
                done: { path: 'note' },
                then: 'refresh',
                args: { account: { row: 'id' } },
              },
              { tool: 'calendar.find_again', label: 'Find calendars again', busy: 'Looking…', when: { path: 'canFind', equals: true }, done: { path: 'note' }, args: { id: { row: 'id' } } },
              {
                tool: 'calendar.sign_out',
                label: 'Sign out',
                tone: 'danger',
                confirm: 'Sign out of {label} ({username})? buddi forgets its sign-in and its calendars here. Your calendars there are untouched.',
                done: { path: 'note' },
                args: { id: { row: 'id' } },
              },
            ],
          },
        ],
      },
      {
        kind: 'expand',
        query: settingsRef,
        label: 'What buddi asks Google for',
        body: GOOGLE_HELP.map((text) => ({ kind: 'notice' as const, text })),
      },
      {
        kind: 'expand',
        query: settingsRef,
        label: 'How to make an app password',
        body: APP_PASSWORD_HELP.map((text) => ({ kind: 'notice' as const, text })),
      },
      {
        kind: 'expand',
        query: settingsRef,
        label: 'How to find a private link',
        body: PROVIDER_HELP.map((text) => ({ kind: 'notice' as const, text })),
      },
    ],
  },
];
