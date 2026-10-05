/**
 * Two widgets, both opening the Money page.
 *
 * - **Money** (`finance.money`): the cash across accounts and the next three
 *   bills. Amounts, so `sensitive`: hidden on Home until Show, never on a lock
 *   screen — the host's own rule for a balance.
 * - **Coming up** (`finance.due`): the next bills, made for the lock screen.
 *   It names what is due and when, and shows how much only when the owner
 *   ticked "Show amounts on the lock screen" in Settings → Money. The host
 *   does not tell a widget where it is drawn, so the rule holds wherever it is
 *   placed.
 */
import type { WidgetBody, WidgetDefinition } from '@buddi/core/plugin';
import { comingUp, moneyWords, type DueItem } from './money.js';
import { listAccounts } from './tools/accounts.js';
import { lockScreenAmounts } from './tools/money.js';

export const MONEY_REFRESH_S = 900;

const NOTHING_YET: WidgetBody = { kind: 'text', icon: 'check', text: 'Add an account on the Money page to see your cash here.' };

/** A due row: what, and when — with how much only when `amounts`. */
export function dueRow(d: DueItem, amounts: boolean): { title: string; side: string } {
  return { title: d.name, side: amounts ? `${d.amountWords} · ${d.when}` : d.when };
}

export const moneyWidget: WidgetDefinition = {
  id: 'finance.money',
  title: 'Money',
  sizes: ['medium', 'small'],
  refreshSeconds: MONEY_REFRESH_S,
  link: { page: 'money' },
  sensitive: true,
  preview: {
    medium: {
      kind: 'list',
      max: 5,
      rows: [
        { title: 'Cash across 3 accounts', side: '€4,820' },
        { title: 'Rent', side: '€1,250 · Thu' },
        { title: 'Phone', side: '€19.99 · 12 Oct' },
        { title: 'Gym', side: '€35 · 15 Oct' },
      ],
    },
    small: { kind: 'stat', value: '€4,820', caption: 'cash across 3 accounts', foot: 'Rent due Thu' },
  },
  async produce(ctx, request): Promise<WidgetBody | null> {
    const listed = (await listAccounts.execute({}, ctx)) as { accounts: unknown[]; cashTotal: number; currency: string };
    if (listed.accounts.length === 0) return NOTHING_YET;
    const n = listed.accounts.length;
    const cash = moneyWords(listed.cashTotal, listed.currency, { whole: true });
    const { due } = await comingUp(ctx);
    const next = due.slice(0, 3);
    if (request.size === 'small') {
      return {
        kind: 'stat',
        value: cash,
        caption: `cash across ${n} ${n === 1 ? 'account' : 'accounts'}`,
        foot: next[0] ? `${next[0].name} due ${next[0].when}` : 'Nothing due this month',
      };
    }
    return {
      kind: 'list',
      max: 5,
      rows: [{ title: `Cash across ${n} ${n === 1 ? 'account' : 'accounts'}`, side: cash }, ...next.map((d) => dueRow(d, true))],
      ...(next.length === 0 ? { more: 'Nothing due in the next 30 days' } : {}),
    };
  },
};

export const dueWidget: WidgetDefinition = {
  id: 'finance.due',
  title: 'Coming up',
  sizes: ['small', 'medium'],
  refreshSeconds: MONEY_REFRESH_S,
  link: { page: 'money' },
  preview: {
    small: { kind: 'list', rows: [{ title: 'Rent', side: 'Thu' }, { title: 'Phone', side: '12 Oct' }, { title: 'Gym', side: '15 Oct' }] },
    medium: {
      kind: 'list',
      rows: [{ title: 'Rent', side: 'Thu' }, { title: 'Phone', side: 'Mon 12 Oct' }, { title: 'Gym', side: 'Thu 15 Oct' }],
      more: '2 more in the next 30 days',
    },
  },
  async produce(ctx): Promise<WidgetBody | null> {
    const db = ctx.buddi!.db;
    const { rows } = await db.query<{ n: number }>(`select count(*)::int as n from finance.recurring_items where active and kind = 'charge'`);
    if ((rows[0]?.n ?? 0) === 0) return { kind: 'text', icon: 'check', text: 'Add your bills on the Money page to see what is due here.' };
    const { due } = await comingUp(ctx);
    if (due.length === 0) return { kind: 'text', icon: 'check', text: 'Nothing due in the next 30 days.' };
    const amounts = await lockScreenAmounts(db);
    const more = due.length - 3;
    return {
      kind: 'list',
      rows: due.slice(0, 3).map((d) => dueRow(d, amounts)),
      ...(more > 0 ? { more: `${more} more in the next 30 days` } : {}),
    };
  },
};

export const financeWidgets = [moneyWidget, dueWidget];
