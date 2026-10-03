/**
 * Google accounts: "Sign in with Google" on Settings → Calendar.
 *
 * The owner presses Sign in with Google; core starts an OAuth sign-in for
 * this plugin (`secrets.signIn`, host API 1.28): PKCE, a state, and core
 * listening on a loopback port for Google's answer. The page shows Continue
 * to Google ↗ (the consent page, where buddi asks for the events of your
 * calendars and their list, nothing else). When the browser comes back to
 * this computer core takes the answer by itself; when it is on another
 * computer — a buddi on a home server, the dashboard over the tailnet — that
 * last page does not load, and the owner pastes its address here instead.
 * Then Finish: buddi reads the calendar list, names the account by its
 * address, and links the calendars the account may write to for reading.
 *
 * The tokens are core's: kept as the owner secret "Calendar sign-in: Google
 * <address>", bound to `http.bearer` for this plugin and www.googleapis.com,
 * refreshed and sent by core. This plugin keeps the secret's name. A sign-in
 * starts under a temporary name and takes the account's name once Google has
 * said whose it is, so signing in again — after the seven days of testing
 * mode, or a revocation — replaces the tokens and keeps every calendar link.
 */
import { z } from 'zod';
import type { ToolDefinition } from '@buddi/core/plugin';
import { freeId, keepFound, plural, secretNameForAccount } from './accounts.js';
import { GoogleSignedOut, listGoogleCalendars, type GoogleCalendar } from './google.js';
import { GOOGLE_API, GOOGLE_API_HOST, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_SCOPES } from './google-client.js';
import { accountOf, dropCache, googleFor, listAccounts, listAllCalendars, markSignedOut, type AccountRow } from './store.js';

type Host = NonNullable<Parameters<ToolDefinition['execute']>[1]['buddi']>;

/** The name a sign-in is kept under until Google says whose account it is. */
export const SIGNING_IN_SECRET = 'Calendar sign-in: Google (signing in)';

/** A Google account's draft row, for reading before it is kept. */
function draftAccount(id: string, username: string, secretName: string): AccountRow {
  return {
    id, kind: 'google', service: 'google', label: 'Google', server: GOOGLE_API, hostPattern: GOOGLE_API_HOST,
    username, secretName, homeUrl: null, lastFoundAt: null, lastError: null, needsSignIn: false, signedOutNotifiedAt: null,
  };
}

/** The calendar list as discovery's rows: every calendar holds events; the owner's and writers' are linked at first. */
const asFound = (cals: GoogleCalendar[]) => cals.map((c) => ({ url: c.id, name: c.name, color: c.color, events: true, writable: c.writable }));

/** The sign-in waiting for the owner, if there is one and it is not over. */
export async function pendingSignIn(buddi: Pick<Host, 'db' | 'clock'>): Promise<{ id: string; accountId: string | null; url: string; expiresAt: Date } | undefined> {
  const { rows } = await buddi.db.query(
    `select id, account_id, authorize_url, expires_at from calendar.google_sign_in where expires_at > $1 order by created_at desc limit 1`,
    [buddi.clock.now()],
  );
  const r = rows[0] as { id: string; account_id: string | null; authorize_url: string; expires_at: Date } | undefined;
  return r ? { id: r.id, accountId: r.account_id, url: r.authorize_url, expiresAt: r.expires_at } : undefined;
}

const signInInput = z.object({ account: z.string().min(1).max(80).optional() }).strict();

export const googleSignInTool: ToolDefinition<z.infer<typeof signInInput>, { note: string }> = {
  name: 'calendar.google_sign_in',
  description: 'Start signing in to a Google account (or again to one already linked) to read and write its calendars. The owner’s own.',
  tier: 'auto',
  ownerOnly: true,
  input: signInInput,
  async execute(input, ctx) {
    const buddi = ctx.buddi!;
    const secrets = buddi.secrets;
    if (secrets?.signIn === undefined) throw new Error('This buddi cannot sign in to Google yet. Update buddi, then try again.');
    const renewing = input.account ? await accountOf(buddi.db, input.account) : undefined;
    if (input.account && !renewing) throw new Error('That account is not linked any more.');
    // A sign-in left half-way is dropped, with whatever it kept.
    const { rows: old } = await buddi.db.query(`select id from calendar.google_sign_in`);
    for (const r of old as Array<{ id: string }>) await secrets.signInCancel?.(r.id).catch(() => undefined);
    await buddi.db.query(`delete from calendar.google_sign_in`);
    await secrets.delete(SIGNING_IN_SECRET).catch(() => false);
    const started = await secrets.signIn({
      provider: 'google',
      clientId: GOOGLE_CLIENT_ID,
      ...(GOOGLE_CLIENT_SECRET ? { clientSecret: GOOGLE_CLIENT_SECRET } : {}),
      scopes: GOOGLE_SCOPES,
      secret: SIGNING_IN_SECRET,
      host: GOOGLE_API_HOST,
    });
    await buddi.db.query(
      `insert into calendar.google_sign_in (id, account_id, secret_name, authorize_url, expires_at) values ($1, $2, $3, $4, $5)`,
      [started.id, renewing?.id ?? null, SIGNING_IN_SECRET, started.authorizeUrl, new Date(started.expiresAt)],
    );
    return { note: 'Continue on Google’s page, then come back here and press Finish signing in.' };
  },
};

/**
 * Keep a finished sign-in: whose account it is (its primary calendar's id is
 * its address), the tokens under that account's name, the account row — new,
 * or the one it renews, with its links — and its calendars.
 */
async function keepSignIn(buddi: Host): Promise<{ note: string }> {
  const draft = draftAccount('signing-in', '', SIGNING_IN_SECRET);
  let calendars: GoogleCalendar[];
  try {
    calendars = await listGoogleCalendars(googleFor(buddi, draft));
  } catch (err) {
    throw new Error(`buddi signed in, but could not read your Google calendars: ${err instanceof Error ? err.message : String(err)}`);
  }
  const primary = calendars.find((c) => c.primary) ?? calendars[0];
  const address = primary?.id ?? '';
  if (!address.includes('@')) throw new Error('Google did not say which account this is. Start again.');
  const secretName = secretNameForAccount('Google', address);
  const accounts = await listAccounts(buddi.db);
  const existing = accounts.find((a) => a.kind === 'google' && a.username.toLowerCase() === address.toLowerCase());
  // The tokens take the account's name: the old ones go first.
  if (existing && existing.secretName !== secretName) await buddi.secrets!.delete(existing.secretName).catch(() => false);
  await buddi.secrets!.delete(secretName).catch(() => false);
  if (!(await buddi.secrets!.rename(SIGNING_IN_SECRET, secretName))) throw new Error('buddi lost the sign-in it just made. Start again.');
  let account: AccountRow;
  if (existing) {
    await buddi.db.query(
      `update calendar.account set secret_name = $2, needs_sign_in = false, signed_out_notified_at = null, last_error = null where id = $1`,
      [existing.id, secretName],
    );
    account = { ...existing, secretName, needsSignIn: false, signedOutNotifiedAt: null, lastError: null };
  } else {
    const id = freeId(`google-${address}`, new Set(accounts.map((a) => a.id)));
    account = draftAccount(id, address, secretName);
    await buddi.db.query(
      `insert into calendar.account (id, kind, service, label, server, host_pattern, username, secret_name)
       values ($1, 'google', 'google', 'Google', $2, $3, $4, $5)`,
      [id, GOOGLE_API, GOOGLE_API_HOST, address, secretName],
    );
  }
  const kept = await keepFound(buddi, account, asFound(calendars), (cal) => cal.writable === true);
  for (const c of (await listAllCalendars(buddi.db)).filter((c) => c.accountId === account.id)) dropCache(c.id);
  await buddi.db.query(`delete from calendar.google_sign_in`);
  if (existing) {
    const extra = kept.added > 0 ? `, and found ${plural(kept.added, 'new calendar')}` : '';
    return { note: `Signed in to Google again as ${address}: your calendar links are as they were${extra}.` };
  }
  const shown = calendars.length;
  return {
    note:
      `Signed in to Google as ${address}: ${plural(shown, 'calendar')} found, ${kept.linked} linked for reading. ` +
      'Link others and allow changes under From your accounts.',
  };
}

const finishInput = z.object({ id: z.string().min(1).max(200), pasted: z.string().trim().max(8192).optional() }).strict();

export const googleFinishTool: ToolDefinition<z.infer<typeof finishInput>, { note: string }> = {
  name: 'calendar.google_finish',
  description: 'Finish a Google sign-in: once Google sent buddi back, or with the address the browser ended on pasted. The owner’s own.',
  tier: 'auto',
  ownerOnly: true,
  input: finishInput,
  async execute(input, ctx) {
    const buddi = ctx.buddi!;
    const secrets = buddi.secrets;
    if (secrets?.signInStatus === undefined || secrets.signInFinish === undefined) throw new Error('This buddi cannot sign in to Google yet. Update buddi.');
    const status = input.pasted ? await secrets.signInFinish(input.id, input.pasted) : await secrets.signInStatus(input.id);
    if (status.state === 'waiting') {
      throw new Error(
        'Google has not sent buddi back yet. Allow buddi on Google’s page first. If that tab ended on a page that would not load, copy its whole address and paste it here.',
      );
    }
    if (status.state !== 'signed-in') {
      await buddi.db.query(`delete from calendar.google_sign_in where id = $1`, [input.id]);
      await secrets.delete(SIGNING_IN_SECRET).catch(() => false);
      throw new Error(status.problem ?? 'The sign-in did not finish. Start again.');
    }
    return keepSignIn(buddi);
  },
};

const cancelInput = z.object({ id: z.string().min(1).max(200) }).strict();

export const googleCancelTool: ToolDefinition<z.infer<typeof cancelInput>, { note: string }> = {
  name: 'calendar.google_cancel',
  description: 'Drop a Google sign-in that is waiting. The owner’s own.',
  tier: 'auto',
  ownerOnly: true,
  input: cancelInput,
  async execute(input, ctx) {
    const buddi = ctx.buddi!;
    await buddi.secrets?.signInCancel?.(input.id).catch(() => undefined);
    await buddi.db.query(`delete from calendar.google_sign_in where id = $1`, [input.id]);
    await buddi.secrets?.delete(SIGNING_IN_SECRET).catch(() => false);
    return { note: 'Stopped signing in to Google.' };
  },
};

/** Find calendars again on a Google account: new ones (linked when writable), names, colours, rights; gone ones dropped. */
export async function findGoogleAgain(buddi: Host, account: AccountRow): Promise<{ note: string }> {
  let calendars: GoogleCalendar[];
  try {
    calendars = await listGoogleCalendars(googleFor(buddi, account));
  } catch (err) {
    if (err instanceof GoogleSignedOut) {
      await markSignedOut(buddi, account);
      throw new Error(`Google no longer accepts buddi’s sign-in to ${account.username}. Use Sign in again on it.`);
    }
    const message = err instanceof Error ? err.message : String(err);
    await buddi.db.query(`update calendar.account set last_error = $2 where id = $1`, [account.id, message.slice(0, 300)]);
    throw new Error(`buddi could not read Google: ${message}`);
  }
  const kept = await keepFound(buddi, account, asFound(calendars), (cal) => cal.writable === true);
  const parts = [kept.added > 0 ? `found ${plural(kept.added, 'new calendar')}` : '', kept.gone > 0 ? `dropped ${plural(kept.gone, 'calendar')} it no longer has` : ''].filter(Boolean);
  return { note: parts.length > 0 ? `Google (${account.username}): ${parts.join(', ')}.` : `Google (${account.username}): nothing new.` };
}

export const googleTools = [googleSignInTool, googleFinishTool, googleCancelTool];
