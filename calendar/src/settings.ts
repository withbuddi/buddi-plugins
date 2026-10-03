/**
 * Settings → Calendar: one list grouped by account — Google, iCloud and the
 * other app-password accounts, then the private links — each calendar one row
 * with its colour, what agents last read, and one choice: Not linked · Read ·
 * Read and change (`calendar.set_access`). One Add a calendar menu: Sign in
 * with Google, Link with an app password, Paste a private link. The Google
 * sign-in is one card that finishes by itself once Google's answer reaches
 * buddi (the page asks how it stands every two seconds); the pasted-address
 * fallback appears only when the dashboard is opened from another computer.
 * A link or a password is an owner secret from the moment it is saved; rows
 * keep only the secret's name. Writes are `ownerOnly` tools. Host API 1.28's
 * page grammar (a row's choice, a group head's actions, a menu, a polled
 * card's finish, `where`).
 */
import { z } from 'zod';
import type { PageDescriptor, PageQuery, ToolDefinition } from '@buddi/core/plugin';
import { parseIcs } from './ics.js';
import { idOf } from './ids.js';
import { declareHost, dropCache, fetchIcs, listAccounts, listAllCalendars, listCalendars, normaliseLink, providerOf, remember } from './store.js';
import { pendingSignIn, signInState } from './google-accounts.js';

export { idOf };

export const CALENDAR_NOTICE =
  'Choose what your agents may do with each calendar. Before any change, they ask you on a card. ' +
  'Links, passwords and sign-ins stay in buddi’s vault.';

/** What buddi asks Google for, and what testing mode means until Google has reviewed buddi. */
export const GOOGLE_HELP = [
  'The events of your calendars — to read your day and add, change or cancel the events you approve — and the list ' +
    'of your calendars, to show them here. Nothing else: not your mail, contacts or files.',
  'The sign-in is kept in buddi’s vault and sent only to Google’s calendar service. Remove the account here, or remove buddi at ' +
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
  'A private link only reads. To let agents change events, sign in with Google, or link the account with an app password (iCloud, Fastmail, CalDAV).',
];

/** "2 min ago", "3 h ago", "3 days ago": when agents last read a calendar. */
export function ago(then: Date, now: Date): string {
  const minutes = Math.max(0, Math.round((now.getTime() - then.getTime()) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return `${days} ${days === 1 ? 'day' : 'days'} ago`;
}

/** What agents may do with a calendar, as its choice reads it. */
export type Access = 'off' | 'read' | 'change';

/** A calendar's line under its name: what agents last read, and what a change costs. */
function lineOf(r: { lastFetchedAt: Date | null; eventCount: number | null }, access: Access, now: Date): string {
  if (access === 'off') return 'Agents don’t see it';
  const parts = [
    r.eventCount !== null ? `${r.eventCount} ${r.eventCount === 1 ? 'event' : 'events'}` : '',
    r.lastFetchedAt ? `read ${ago(r.lastFetchedAt, now)}` : 'not read yet',
    access === 'change' ? 'changes ask you first' : '',
  ];
  return parts.filter(Boolean).join(' · ');
}

/** The group a private link sits in: after every account. */
const LINKS_GROUP = 'links';

export const calendarQueries: PageQuery[] = [
  {
    name: 'settings',
    params: z.object({}),
    async produce(_params, ctx) {
      const buddi = ctx.buddi!;
      const db = buddi.db;
      const now = buddi.clock.now();
      const [all, accounts, pending, signIn] = await Promise.all([listAllCalendars(db), listAccounts(db), pendingSignIn(buddi), signInState(buddi)]);
      const signedOut = accounts.filter((a) => a.needsSignIn);
      const links = all.filter((r) => !r.accountId);
      const rows = [
        // Each account's calendars under its head, in the order they came; then the private links.
        ...accounts.flatMap((a) => {
          const mine = all.filter((c) => c.accountId === a.id);
          const linked = mine.filter((c) => c.linked).length;
          const aside = a.needsSignIn
            ? 'Sign-in ran out · agents can’t read these'
            : a.lastError
              ? `Can’t sign in: ${a.lastError.length > 80 ? `${a.lastError.slice(0, 79)}…` : a.lastError}`
              : `${mine.length} ${mine.length === 1 ? 'calendar' : 'calendars'} · ${linked} linked`;
          return mine.map((r) => {
            const access: Access = !r.linked ? 'off' : r.writable ? 'change' : 'read';
            return {
              id: r.id,
              name: r.name,
              color: r.color ?? '',
              group: a.id,
              groupLabel: `${a.label} · ${a.username}`,
              groupAside: aside,
              groupTone: a.needsSignIn ? 'warning' : a.lastError ? 'critical' : '',
              account: a.id,
              accountWords: `${a.label} (${a.username})`,
              expired: a.needsSignIn && a.kind === 'google',
              canFind: !a.needsSignIn,
              kind: 'account',
              access,
              // The server said this account may not write it.
              readOnly: r.canWrite === false,
              why: `Read-only in ${a.label}`,
              line: lineOf(r, access, now),
              problem: r.linked && r.lastError ? `Can’t read it: ${r.lastError}` : '',
            };
          });
        }),
        ...links.map((r) => ({
          id: r.id,
          name: r.name,
          color: r.color ?? '',
          group: LINKS_GROUP,
          groupLabel: 'Private links',
          groupAside: `${links.length} ${links.length === 1 ? 'link' : 'links'} · read only`,
          groupTone: '',
          account: '',
          accountWords: '',
          expired: false,
          canFind: false,
          kind: 'link',
          access: 'read' as Access,
          readOnly: true,
          why: 'A private link only reads',
          line: lineOf(r, 'read', now),
          problem: r.lastError ? `Can’t read it: ${r.lastError}` : '',
        })),
      ];
      return {
        hasCalendars: rows.length > 0,
        defaultService: 'icloud',
        // Sign in with Google needs a buddi that runs sign-ins (host API 1.28), and one at a time.
        googleAvailable: typeof buddi.secrets?.signIn === 'function' && pending === undefined,
        hasGoogleSignIn: signIn !== undefined,
        googleSignIn: signIn ?? { id: '', url: '', renewing: '', state: '', note: '', problem: '' },
        hasSignedOut: signedOut.length > 0,
        signedOut:
          signedOut.length === 0
            ? ''
            : `Google stopped accepting buddi’s sign-in to ${signedOut.map((a) => a.username).join(' and ')}, so agents can’t ` +
              'read those calendars. Sign in again: your choices stay as they are.',
        calendars: rows,
        accounts: accounts.map((a) => ({ id: a.id, kind: a.kind, label: a.label, username: a.username, needsSignIn: a.needsSignIn })),
      };
    },
  },
  {
    /** The sign-in card's own read, asked every two seconds while it waits. */
    name: 'sign_in',
    params: z.object({}),
    async produce(_params, ctx) {
      const signIn = await signInState(ctx.buddi!);
      if (!signIn) return { waiting: false, rows: [] };
      const line = signIn.renewing
        ? `Waiting for Google… Sign in as ${signIn.renewing}; this finishes by itself when Google sends you back.`
        : 'Waiting for Google… This finishes by itself when Google sends you back.';
      return { waiting: signIn.state === 'waiting', rows: [{ ...signIn, line }] };
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
const signInRef = { query: 'sign_in' };

/** The three-way choice on every calendar's row. */
const ACCESS_CHOICE = {
  tool: 'calendar.set_access',
  label: 'What agents may do with {name}',
  value: 'access',
  options: [
    { value: 'off', label: 'Not linked', when: { path: 'kind', equals: 'account' } },
    { value: 'read', label: 'Read' },
    { value: 'change', label: 'Read and change', disabledWhen: { path: 'readOnly', equals: true }, hint: '{why}' },
  ],
  done: { path: 'note' },
  args: { id: { row: 'id' }, access: { choice: true as const } },
};

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
        // One card: Continue to Google, and it finishes by itself when Google answers.
        kind: 'section',
        title: 'Sign in with Google',
        when: { path: 'hasGoogleSignIn', equals: true },
        actions: [
          {
            kind: 'button',
            when: { path: 'googleSignIn.state', in: ['waiting', 'failed'] },
            action: { tool: 'calendar.google_cancel', label: 'Cancel', then: 'refresh', args: { id: { path: 'googleSignIn.id' } } },
          },
          { kind: 'link', label: 'Continue to Google', tone: 'accent', when: { path: 'googleSignIn.state', equals: 'waiting' }, to: { href: { path: 'googleSignIn.url' } } },
        ],
        body: [
          {
            kind: 'repeat',
            query: signInRef,
            rows: 'rows',
            key: 'id',
            poll: {
              seconds: 2,
              while: { path: 'waiting', equals: true },
              finish: {
                when: { path: 'state', equals: 'received' },
                action: { tool: 'calendar.google_finish', label: 'Finish signing in', busy: 'Signed in. Reading your calendars…', then: 'refresh', args: { id: { row: 'id' } } },
              },
            },
            body: [
              { kind: 'notice', look: 'quiet', icon: 'clock', text: { path: 'line' }, when: { path: 'state', equals: 'waiting' } },
              {
                // Only from another computer: Google's last page cannot reach buddi there.
                kind: 'form',
                where: 'remote',
                when: { path: 'state', equals: 'waiting' },
                fields: [
                  {
                    name: 'pasted',
                    label: 'Google’s last page',
                    type: 'text',
                    required: true,
                    hint: 'You’re using buddi from another computer, so that page won’t load. Copy its whole address (it starts with http://127.0.0.1) and paste it here.',
                  },
                ],
                submit: {
                  tool: 'calendar.google_finish',
                  label: 'Finish signing in',
                  busy: 'Signing in…',
                  then: 'refresh',
                  args: { id: { path: 'id' }, pasted: { field: 'pasted' } },
                },
              },
              {
                kind: 'notice',
                tone: 'good',
                text: { path: 'note' },
                when: { path: 'state', equals: 'done' },
                action: { tool: 'calendar.google_dismiss', label: 'Done', then: 'refresh', args: { id: { path: 'id' } } },
              },
              {
                kind: 'notice',
                tone: 'critical',
                text: { path: 'problem' },
                when: { path: 'state', equals: 'failed' },
                action: { tool: 'calendar.google_sign_in', label: 'Try again', tone: 'accent', busy: 'Starting…', then: 'refresh', args: {} },
              },
            ],
          },
        ],
      },
      {
        kind: 'section',
        title: 'Calendars',
        actions: [
          {
            kind: 'menu',
            label: 'Add a calendar',
            tone: 'accent',
            items: [
              {
                label: 'Sign in with Google',
                hint: 'Read and change your Google calendars',
                when: { path: 'googleAvailable', equals: true },
                action: { tool: 'calendar.google_sign_in', label: 'Sign in with Google', busy: 'Starting…', then: 'refresh', args: {} },
              },
              { label: 'Link with an app password', hint: 'iCloud, Fastmail or another CalDAV server', open: 'app-password' },
              { label: 'Paste a private link', hint: 'Any calendar, read only', open: 'private-link' },
            ],
          },
        ],
        body: [
          {
            kind: 'list',
            query: settingsRef,
            rows: 'calendars',
            key: 'id',
            groupBy: {
              key: 'group',
              label: 'groupLabel',
              aside: 'groupAside',
              asideTone: 'groupTone',
              actions: [
                {
                  tool: 'calendar.google_sign_in',
                  label: 'Sign in again',
                  tone: 'accent',
                  when: { path: 'expired', equals: true },
                  busy: 'Starting…',
                  then: 'refresh',
                  args: { account: { row: 'account' } },
                },
                {
                  tool: 'calendar.find_again',
                  label: 'Find calendars again',
                  menu: true,
                  when: { path: 'canFind', equals: true },
                  done: { path: 'note' },
                  args: { id: { row: 'account' } },
                },
                {
                  tool: 'calendar.sign_out',
                  label: 'Remove account…',
                  tone: 'danger',
                  menu: true,
                  when: { path: 'kind', equals: 'account' },
                  confirm: 'Remove {accountWords}? Its calendars go from buddi, and buddi forgets its sign-in. Nothing changes in the account itself.',
                  done: { path: 'note' },
                  args: { id: { row: 'account' } },
                },
              ],
            },
            item: {
              title: { path: 'name' },
              sub: { path: 'line' },
              swatch: 'color',
              status: { text: { path: 'problem' }, tone: 'critical' },
              choice: ACCESS_CHOICE,
            },
            actions: [
              {
                tool: 'calendar.remove',
                label: 'Remove…',
                tone: 'danger',
                menu: true,
                when: { path: 'kind', equals: 'link' },
                confirm: 'Remove {name}? buddi forgets its link. The calendar itself is untouched.',
                done: { path: 'note' },
                args: { id: { row: 'id' } },
              },
            ],
            empty: 'No calendar yet. Add one: sign in with Google, link iCloud or Fastmail with an app password, or paste any calendar’s private link.',
          },
          {
            kind: 'form',
            drawer: { title: 'Link with an app password', id: 'app-password' },
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
            kind: 'form',
            drawer: { title: 'Paste a private link', id: 'private-link' },
            fields: [
              { name: 'name', label: 'Name', type: 'text', required: true, hint: 'What you call it: Work, Family.' },
              {
                name: 'link',
                label: 'Private link',
                type: 'secret',
                required: true,
                hint: 'The calendar’s private address, https:// or webcal://. Agents can read it, never change it.',
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
