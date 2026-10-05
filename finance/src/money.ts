/**
 * The Money page (`#/p/finance/money`) and Settings → Money, as descriptors,
 * and the reads behind them.
 *
 * Every figure comes from the same tools an agent reads — `list_accounts`,
 * `credit_overview`, the recurring items through the projection's own
 * `occurrencesBetween` — so the page and the CFO never disagree. Every value
 * is formatted here in the owner's currency and words; the dashboard draws
 * text. The reads that carry amounts are `sensitive`: masked on the page until
 * the owner presses Show, as the Home block is.
 */
import { z } from 'zod';
import type { BuddiHost, PageDescriptor, PageQuery, ToolContext } from '@buddi/core/plugin';
import { ACCOUNT_KINDS, type AccountKind } from './accounts.js';
import { nextDayOfMonth } from './credit.js';
import { addDays, daysBetween, occurrencesBetween, type Cadence } from './projection.js';
import { ADVISOR_ROLES } from './sentinels/roles.js';
import { listAccounts } from './tools/accounts.js';
import { projectCashflow } from './tools/cashflow.js';
import { creditOverviewTool } from './tools/credit.js';
import { moneySettings } from './tools/money.js';
import { loadPreferences, num, today, toDateString } from './tools/shared.js';

/** How far ahead Coming up looks. */
export const COMING_UP_DAYS = 30;
/** Statements the page lists. */
export const STATEMENTS_SHOWN = 8;

/* ------------------------------------------------------------------ *
 * Words
 * ------------------------------------------------------------------ */

/** An amount in the owner's currency: whole for a total, cents when it has them. */
export function moneyWords(value: number, currency: string, opts: { whole?: boolean; signed?: boolean } = {}): string {
  const cents = !opts.whole && !Number.isInteger(Math.round(value * 100) / 100);
  try {
    const text = new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      minimumFractionDigits: cents ? 2 : 0,
      maximumFractionDigits: cents ? 2 : 0,
    }).format(Math.abs(value));
    return `${value < 0 ? '−' : opts.signed && value > 0 ? '+' : ''}${text}`;
  } catch {
    return `${value < 0 ? '−' : ''}${Math.abs(value).toFixed(cents ? 2 : 0)} ${currency}`;
  }
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `2026-10-08` → `8 Oct`. */
export function dayMonth(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  void y;
  return `${d} ${MONTHS[(m ?? 1) - 1] ?? ''}`;
}

/** A due date as the owner says it: today, tomorrow, Thu (this week), Thu 8 Oct (later). */
export function dueWords(iso: string, day: string): string {
  const away = daysBetween(day, iso);
  if (away === 0) return 'today';
  if (away === 1) return 'tomorrow';
  const weekday = DAYS[new Date(`${iso}T00:00:00Z`).getUTCDay()] ?? '';
  if (away > 1 && away < 7) return weekday;
  return `${weekday} ${dayMonth(iso)}`;
}

/** When a balance was read: "as of today", "as of 14 Sep". */
export function asOfWords(iso: string, day: string): string {
  const away = daysBetween(iso, day);
  if (away === 0) return 'as of today';
  if (away === 1) return 'as of yesterday';
  return `as of ${dayMonth(iso)}`;
}

export const KIND_WORDS: Record<AccountKind, string> = {
  cash: 'Current account',
  savings: 'Savings',
  retirement: 'Retirement',
  investment: 'Investments',
  hsa: 'Health savings',
  other: 'Other',
};

const CADENCE_WORDS: Record<Cadence, string> = { monthly: 'Monthly', weekly: 'Weekly', biweekly: 'Every two weeks', yearly: 'Yearly', once: 'Once' };

/* ------------------------------------------------------------------ *
 * The page's own read: who reads statements, whether anything is here yet
 * ------------------------------------------------------------------ */

export interface MoneyOverview {
  lede: string;
  /** The agent holding `overview` (the CFO, Ledger): Upload a statement opens its chat. */
  advisor: string | null;
  hasAccounts: boolean;
}

export async function moneyOverview(buddi: BuddiHost): Promise<MoneyOverview> {
  const advisor = buddi.owner.agentForRole(ADVISOR_ROLES[0]) ?? null;
  const { rows } = await buddi.db.query<{ n: number }>(`select count(*)::int as n from finance.accounts`);
  const hasAccounts = (rows[0]?.n ?? 0) > 0;
  return {
    advisor,
    hasAccounts,
    lede: advisor
      ? 'Your accounts, what is coming up and your cards, kept on this computer. Drop a statement in the chat and your CFO reads it for you.'
      : 'Your accounts, what is coming up and your cards, kept on this computer. Add the CFO from the catalogue to have statements read for you.',
  };
}

/* ------------------------------------------------------------------ *
 * Accounts and the figures over them
 * ------------------------------------------------------------------ */

export interface AccountLine {
  id: string;
  name: string;
  line: string;
  balance: string;
  stale: string | null;
}

export interface Totals {
  cash: string;
  netWorth: string;
  debt: string;
  low: string;
  lowNote: string;
  breaches: boolean;
  currency: string;
}

interface ListedAccounts {
  accounts: Array<{ id: string; name: string; balance: number; balanceAsOf: string; balanceAgeDays: number; stale?: true; kind: AccountKind; institution: string | null; includeInCashflow: boolean }>;
  cashTotal: number;
  netWorth: number;
  totalLiabilities: number;
  currency: string;
}

export async function accountLines(ctx: ToolContext): Promise<{ accounts: AccountLine[]; count: number }> {
  const listed = (await listAccounts.execute({}, ctx)) as ListedAccounts;
  const day = today(ctx);
  const accounts = listed.accounts.map((a) => ({
    id: a.id,
    name: a.name,
    line: [KIND_WORDS[a.kind] ?? a.kind, ...(a.institution ? [a.institution] : []), ...(a.includeInCashflow ? [] : ['not spendable']), asOfWords(a.balanceAsOf, day)].join(' · '),
    balance: moneyWords(a.balance, listed.currency),
    stale: a.stale ? `Not updated in ${a.balanceAgeDays} days` : null,
  }));
  return { accounts, count: accounts.length };
}

export async function moneyTotals(ctx: ToolContext): Promise<Totals> {
  const listed = (await listAccounts.execute({}, ctx)) as ListedAccounts;
  const c = listed.currency;
  let low = '—';
  let lowNote = 'next 30 days';
  let breaches = false;
  try {
    const p = (await projectCashflow.execute({ horizonDays: COMING_UP_DAYS, includeBaseline: false } as never, ctx)) as Record<string, unknown>;
    if (typeof p.minBalance === 'number') low = moneyWords(p.minBalance, c, { whole: true });
    if (typeof p.minBalanceDate === 'string') lowNote = `lowest, ${dueWords(p.minBalanceDate, today(ctx))}`;
    breaches = p.breachesFloor === true;
  } catch {
    // No account yet: the projection has nothing to start from.
  }
  return {
    cash: moneyWords(listed.cashTotal, c, { whole: true }),
    netWorth: moneyWords(listed.netWorth, c, { whole: true }),
    debt: moneyWords(listed.totalLiabilities, c, { whole: true }),
    low,
    lowNote,
    breaches,
    currency: c,
  };
}

/* ------------------------------------------------------------------ *
 * Coming up: the recurring charges due in the next 30 days
 * ------------------------------------------------------------------ */

export interface DueItem {
  /** `<item>:<date>`: one row per occurrence. */
  key: string;
  id: string;
  name: string;
  date: string;
  when: string;
  amount: number;
  amountWords: string;
  line: string;
  account: string | null;
  /** `<when> · <amount>`: the row's right. */
  side: string;
}

export interface RecurringRow {
  id: string;
  name: string;
  kind: 'income' | 'charge';
  amount: number;
  cadence: Cadence;
  anchorDate: string;
  paidThrough: string | null;
  account: string | null;
  billedTo: string | null;
}

/** Every occurrence of the charges in `[day, day + days)`, soonest first. Pure. */
export function dueOccurrences(items: readonly RecurringRow[], day: string, currency: string, days = COMING_UP_DAYS): DueItem[] {
  const end = addDays(day, days - 1);
  const out: DueItem[] = [];
  for (const item of items) {
    if (item.kind !== 'charge') continue;
    for (const date of occurrencesBetween(item, day, end)) {
      const when = dueWords(date, day);
      const amountWords = moneyWords(item.amount, currency);
      out.push({
        key: `${item.id}:${date}`,
        id: item.id,
        name: item.name,
        date,
        when,
        amount: item.amount,
        amountWords,
        line: [
          `Due ${when}`,
          item.billedTo ? `on ${item.billedTo}` : item.account ? `from ${item.account}` : null,
          CADENCE_WORDS[item.cadence],
        ].filter(Boolean).join(' · '),
        account: item.account,
        side: amountWords,
      });
    }
  }
  return out.sort((a, b) => (a.date === b.date ? a.name.localeCompare(b.name) : a.date < b.date ? -1 : 1));
}

export async function loadRecurring(db: BuddiHost['db']): Promise<RecurringRow[]> {
  const { rows } = await db.query(
    `select r.id, r.kind, r.name, r.amount, r.cadence, r.anchor_date, r.paid_through,
            a.name as account_name, l.name as liability_name
       from finance.recurring_items r
       left join finance.accounts a on a.id = r.account_id
       left join finance.liabilities l on l.id = r.liability_id
      where r.active
      order by r.name`,
  );
  return rows.map((r) => ({
    id: r.id as string,
    name: r.name as string,
    kind: r.kind as RecurringRow['kind'],
    amount: num(r.amount),
    cadence: r.cadence as Cadence,
    anchorDate: toDateString(r.anchor_date),
    paidThrough: r.paid_through ? toDateString(r.paid_through) : null,
    account: (r.account_name as string | null) ?? null,
    billedTo: (r.liability_name as string | null) ?? null,
  }));
}

export async function comingUp(ctx: ToolContext): Promise<{ due: DueItem[]; total: string; count: number }> {
  const db = ctx.buddi!.db;
  const prefs = await loadPreferences(db);
  const due = dueOccurrences(await loadRecurring(db), today(ctx), prefs.currency);
  return { due, total: moneyWords(due.reduce((s, d) => s + d.amount, 0), prefs.currency, { whole: true }), count: due.length };
}

/* ------------------------------------------------------------------ *
 * Cards & debts: the credit overview, and the loans beside it
 * ------------------------------------------------------------------ */

export interface DebtLine {
  id: string;
  name: string;
  line: string;
  owed: string;
  /** The overview's computed recommendation, when a card is over its target. */
  advice: string | null;
  /** "Over target" on a card closing over its utilization target; null otherwise. */
  over: string | null;
  /** The next due date of the minimum, and the minimum itself: I paid it. */
  dueOn: string;
  minimum: number;
  paid: boolean;
}

export async function cardsAndDebts(ctx: ToolContext): Promise<{ debts: DebtLine[]; utilization: string | null }> {
  const db = ctx.buddi!.db;
  const day = today(ctx);
  const overview = (await creditOverviewTool.execute({} as never, ctx)) as {
    cards: Array<{ name: string; utilization: number | null; reportedUtilizationEstimate: number | null; utilizationTarget: number; statementClosesOn: string | null; overTarget: boolean; sentence: string | null }>;
    overallReportedUtilization: number | null;
    currency: string;
  };
  const byName = new Map(overview.cards.map((c) => [c.name, c]));
  const { rows } = await db.query(
    `select l.id, l.name, l.kind, l.balance, l.minimum_payment, l.due_day, l.apr,
            coalesce(array_agg(to_char(p.due_on, 'YYYY-MM-DD')) filter (where p.id is not null), '{}') as paid_due_dates
       from finance.liabilities l
       left join finance.payment_events p on p.liability_id = l.id and p.status in ('paid_on_time', 'paid_late')
      where l.active
      group by l.id
      order by l.kind, l.name`,
  );
  const c = overview.currency;
  const debts = rows.map((r) => {
    const name = r.name as string;
    const card = byName.get(name);
    const minimum = num(r.minimum_payment);
    const dueOn = nextDayOfMonth(day, Number(r.due_day));
    const paid = ((r.paid_due_dates as string[]) ?? []).includes(dueOn);
    const used = card?.reportedUtilizationEstimate ?? card?.utilization ?? null;
    const parts = [
      r.kind === 'credit_card' ? 'Card' : r.kind === 'loan' ? 'Loan' : 'Debt',
      ...(used !== null ? [`${Number(used.toFixed(1))}% used`] : []),
      ...(card?.statementClosesOn ? [`closes ${dueWords(card.statementClosesOn, day)}`] : []),
      ...(minimum > 0 ? [paid ? `minimum paid for ${dayMonth(dueOn)}` : `${moneyWords(minimum, c)} due ${dueWords(dueOn, day)}`] : []),
      ...(r.apr !== null && r.apr !== undefined && r.kind !== 'credit_card' ? [`${num(r.apr)}% APR`] : []),
    ];
    return {
      id: r.id as string,
      name,
      line: parts.join(' · '),
      owed: moneyWords(num(r.balance), c),
      advice: card?.overTarget ? card.sentence : null,
      over: card?.overTarget ? 'Over target' : null,
      dueOn,
      minimum,
      paid,
    };
  });
  const util = overview.overallReportedUtilization;
  return { debts, utilization: util === null ? null : `${Math.round(util)}% of your limits, on course to report` };
}

/* ------------------------------------------------------------------ *
 * Statements read
 * ------------------------------------------------------------------ */

export interface StatementLine {
  id: string;
  artifactId: string | null;
  title: string;
  line: string;
  /** Both, as one line: "Checking · read 3 Oct — 12 new lines · …". */
  summary: string;
}

interface StagingSummary {
  newRows?: number;
  duplicates?: number;
  totalIn?: number;
  totalOut?: number;
  dateRange?: { from: string; to: string } | null;
}

/** "12 new lines · −€1,240 out · +€2,100 in · 1 Sep – 30 Sep". Pure. */
export function changedWords(s: StagingSummary, currency: string): string {
  const fresh = s.newRows ?? 0;
  const parts = [fresh === 0 ? 'nothing new' : fresh === 1 ? '1 new line' : `${fresh} new lines`];
  if ((s.totalOut ?? 0) !== 0) parts.push(`${moneyWords(-Math.abs(s.totalOut ?? 0), currency, { whole: true })} out`);
  if ((s.totalIn ?? 0) !== 0) parts.push(`${moneyWords(Math.abs(s.totalIn ?? 0), currency, { whole: true, signed: true })} in`);
  if (s.dateRange) parts.push(`${dayMonth(s.dateRange.from)} – ${dayMonth(s.dateRange.to)}`);
  return parts.join(' · ');
}

export async function statementsRead(ctx: ToolContext): Promise<{ statements: StatementLine[] }> {
  const db = ctx.buddi!.db;
  const prefs = await loadPreferences(db);
  const zone = ctx.buddi!.owner.timezone;
  const { rows } = await db.query(
    `select s.id, s.artifact_id, s.summary, s.committed_at, coalesce(a.name, l.name) as ledger
       from finance.import_stagings s
       left join finance.accounts a on a.id = s.account_id
       left join finance.liabilities l on l.id = s.liability_id
      where s.committed_at is not null and s.source = 'statement'
      order by s.committed_at desc
      limit $1`,
    [STATEMENTS_SHOWN],
  );
  return {
    statements: rows.map((r) => {
      const read = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(r.committed_at as Date);
      const title = `${(r.ledger as string | null) ?? 'A removed account'} · read ${dayMonth(read)}`;
      const line = changedWords(r.summary as StagingSummary, prefs.currency);
      return { id: r.id as string, artifactId: (r.artifact_id as string | null) ?? null, title, line, summary: `${title} — ${line}` };
    }),
  };
}

/* ------------------------------------------------------------------ *
 * Queries
 * ------------------------------------------------------------------ */

const none = z.object({}).strict();

export const moneyQueries: PageQuery[] = [
  { name: 'money', params: none, produce: async (_p, ctx) => moneyOverview(ctx.buddi!) },
  { name: 'money_totals', params: none, sensitive: true, produce: async (_p, ctx) => moneyTotals(ctx) },
  { name: 'accounts', params: none, sensitive: true, produce: async (_p, ctx) => accountLines(ctx) },
  { name: 'coming_up', params: none, sensitive: true, produce: async (_p, ctx) => comingUp(ctx) },
  { name: 'debts', params: none, sensitive: true, produce: async (_p, ctx) => cardsAndDebts(ctx) },
  { name: 'statements', params: none, sensitive: true, produce: async (_p, ctx) => statementsRead(ctx) },
  { name: 'money_settings', params: none, produce: async (_p, ctx) => moneySettings(ctx) },
  {
    name: 'account_names',
    params: none,
    produce: async (_p, ctx) => ({
      accounts: (await ctx.buddi!.db.query<{ name: string }>(`select name from finance.accounts order by name`)).rows,
    }),
  },
];

/* ------------------------------------------------------------------ *
 * The pages
 * ------------------------------------------------------------------ */

const KIND_OPTIONS = ACCOUNT_KINDS.map((kind) => ({ value: kind, label: KIND_WORDS[kind] }));
/** Names only, so the Add a bill sheet asks nothing masked. */
const ACCOUNT_OPTIONS = { query: { query: 'account_names' }, rows: 'accounts', value: 'name', label: 'name' };

/** "Which bank or account?": the first-run sheet, `#/p/finance/money?open=setup`. */
const SETUP_FORM = {
  kind: 'form' as const,
  drawer: { title: 'Which bank or account?', id: 'setup' },
  fields: [
    { name: 'name', label: 'Account', type: 'text' as const, required: true, hint: 'As you call it: Checking, Revolut, Joint account.' },
    { name: 'kind', label: 'Kind', type: 'select' as const, options: KIND_OPTIONS },
    { name: 'balance', label: 'What it holds now', type: 'number' as const, required: true, step: 0.01, hint: 'Rather drop a statement? Open your CFO’s chat and drop it there: it reads it and asks before anything is written.' },
  ],
  submit: {
    tool: 'finance.setup', label: 'Add it', busy: 'Adding…', done: { path: 'message' }, then: 'close' as const,
    args: { name: { field: 'name' }, kind: { field: 'kind' }, balance: { field: 'balance' } },
  },
};

export const moneyPage: PageDescriptor = {
  id: 'money',
  title: 'Money',
  place: 'rail',
  icon: 'money',
  order: 30,
  data: { query: 'money' },
  actions: [
    { kind: 'link', label: 'Upload a statement', to: { chat: { path: 'advisor' } }, when: { path: 'advisor', not: true, equals: null } },
    {
      kind: 'menu', label: 'Add', tone: 'accent',
      items: [
        { label: 'An account', hint: 'Name, kind and what it holds', open: 'account' },
        { label: 'A bill or an income', hint: 'Rent, a subscription, a salary', open: 'recurring' },
      ],
    },
  ],
  body: [
    { kind: 'notice', text: { path: 'lede' } },
    // No account yet: the first-run sheet, in place, with its own button.
    {
      ...SETUP_FORM,
      title: 'Start with one account',
      note: 'Its name and what it holds: buddi counts from there.',
      drawer: { title: 'Which bank or account?', button: 'Which bank or account?' },
      when: { path: 'hasAccounts', equals: false },
    },
    // Everything with an amount, behind one Show: masked as the Home block is, revealed together.
    {
      kind: 'section',
      body: [
        {
          kind: 'stats',
          query: { query: 'money_totals' },
          items: [
            { label: 'Cash', value: { path: 'cash' } },
            { label: 'Net worth', value: { path: 'netWorth' } },
            { label: 'Debt', value: { path: 'debt' } },
            { label: 'Low point, 30 days', value: { path: 'low' } },
          ],
          when: { path: 'hasAccounts', equals: true },
        },
        {
          kind: 'section',
          title: 'Accounts',
          body: [
            {
              kind: 'list',
              query: { query: 'accounts' },
              rows: 'accounts',
              key: 'id',
              empty: 'No accounts yet',
              item: {
                title: { path: 'name' },
                sub: { path: 'line' },
                meta: [{ path: 'balance' }],
                pill: { value: { path: 'stale' }, tone: 'warning' },
              },
              actions: [
                {
                  tool: 'finance.set_balance', label: 'Update', args: { account: { row: 'name' }, balance: { field: 'balance' } },
                  form: { title: 'What {name} holds now', fields: [{ name: 'balance', label: 'Balance', type: 'number', required: true, step: 0.01, hint: 'Recorded as of today.' }], submit: 'Save' },
                  done: 'Saved, as of today.',
                },
              ],
            },
          ],
        },
        {
          kind: 'section',
          title: 'Coming up',
          note: 'Bills and charges due in the next 30 days.',
          body: [
            {
              kind: 'list',
              query: { query: 'coming_up' },
              rows: 'due',
              key: 'key',
              empty: 'Nothing due in the next 30 days. Add your rent, subscriptions and loan payments to see them here.',
              item: { title: { path: 'name' }, sub: { path: 'line' }, meta: [{ path: 'side' }] },
              actions: [
                {
                  tool: 'finance.mark_paid', label: 'Mark paid', busy: 'Marking…', done: { path: 'message' },
                  args: { id: { row: 'id' }, through: { row: 'date' }, balance: { field: 'balance' } },
                  form: {
                    title: 'Mark {name} paid',
                    fields: [{ name: 'balance', label: 'What the account holds now (optional)', type: 'number', step: 0.01, hint: 'Leave it empty if the money has not left yet: the forecast keeps your last balance until you update it.' }],
                    submit: 'Mark paid',
                  },
                },
              ],
            },
          ],
        },
        {
          kind: 'section',
          title: 'Cards & debts',
          body: [
            {
              kind: 'list',
              query: { query: 'debts' },
              rows: 'debts',
              key: 'id',
              empty: 'No cards or loans recorded. Tell your CFO about one, or drop its statement in the chat.',
              item: {
                title: { path: 'name' },
                sub: { path: 'line' },
                meta: [{ path: 'owed' }],
                pill: { value: { path: 'over' }, tone: 'warning' },
                status: { text: { path: 'advice' }, tone: 'warning' },
              },
              actions: [
                {
                  tool: 'finance.record_payment', label: 'I paid it', when: { path: 'paid', equals: false },
                  args: { liability: { row: 'name' }, dueOn: { row: 'dueOn' }, status: { const: 'paid_on_time' }, amount: { field: 'amount' } },
                  form: { title: 'Payment on {name}', fields: [{ name: 'amount', label: 'Amount paid', type: 'number', required: true, step: 0.01 }], submit: 'Record it' },
                  done: 'Recorded.',
                },
              ],
            },
          ],
        },
        {
          kind: 'section',
          title: 'Statements read',
          note: 'The last statements your CFO read into an account, and what they added.',
          body: [
            {
              kind: 'repeat',
              query: { query: 'statements' },
              rows: 'statements',
              key: 'id',
              empty: 'No statement read yet. Drop one in your CFO’s chat: it reads it and asks before anything is written.',
              body: [
                { kind: 'notice', look: 'quiet', text: { path: 'summary' } },
                { kind: 'artifact', path: 'artifactId', label: 'Open the statement' },
              ],
            },
          ],
        },
      ],
    },
    {
      kind: 'form',
      drawer: { title: 'Add an account', id: 'account' },
      fields: [
        { name: 'account', label: 'Name', type: 'text', required: true, hint: 'Checking, Savings, Revolut…' },
        { name: 'kind', label: 'Kind', type: 'select', required: true, options: KIND_OPTIONS, hint: 'Retirement, investments and health savings count in net worth, never as cash to spend.' },
        { name: 'balance', label: 'Opening balance', type: 'number', required: true, step: 0.01, hint: 'What it holds today.' },
      ],
      submit: {
        tool: 'finance.set_balance', label: 'Add the account', busy: 'Adding…', done: 'Added. It counts from today.', then: 'close',
        args: { account: { field: 'account' }, kind: { field: 'kind' }, balance: { field: 'balance' } },
      },
    },
    {
      kind: 'form',
      drawer: { title: 'Add a bill or an income', id: 'recurring' },
      fields: [
        { name: 'kind', label: 'It is', type: 'select', required: true, options: [{ value: 'charge', label: 'A bill or a charge' }, { value: 'income', label: 'An income' }] },
        { name: 'name', label: 'Name', type: 'text', required: true, hint: 'Rent, Netflix, Salary…' },
        { name: 'amount', label: 'Amount', type: 'number', required: true, min: 0.01, step: 0.01 },
        {
          name: 'cadence', label: 'How often', type: 'select', required: true,
          options: [{ value: 'monthly', label: 'Monthly' }, { value: 'weekly', label: 'Weekly' }, { value: 'biweekly', label: 'Every two weeks' }, { value: 'yearly', label: 'Yearly' }, { value: 'once', label: 'Once' }],
        },
        { name: 'anchorDate', label: 'Next date', type: 'date', required: true, hint: 'A monthly one repeats on this day of the month.' },
        { name: 'account', label: 'Account', type: 'select', required: true, optionsFrom: ACCOUNT_OPTIONS },
      ],
      submit: {
        tool: 'finance.add_recurring', label: 'Add it', busy: 'Adding…', done: 'Added. It counts in Coming up and the forecast.', then: 'close',
        args: { kind: { field: 'kind' }, name: { field: 'name' }, amount: { field: 'amount' }, cadence: { field: 'cadence' }, anchorDate: { field: 'anchorDate' }, account: { field: 'account' } },
      },
    },
    SETUP_FORM,
  ],
} as PageDescriptor;

export const moneySettingsPage: PageDescriptor = {
  id: 'settings',
  title: 'Money',
  place: 'settings',
  icon: 'money',
  body: [
    {
      kind: 'section',
      title: 'Money',
      note: 'Everything here stays on this computer.',
      body: [
        {
          kind: 'form',
          initial: { query: 'money_settings' },
          fields: [
            { name: 'currency', label: 'Currency', type: 'text', from: 'currency', hint: 'A three-letter code: EUR, USD, GBP.' },
            { name: 'safetyFloor', label: 'Safety floor', type: 'number', from: 'safetyFloor', step: 1, hint: 'The balance you never want to go under. Your CFO warns you before the forecast crosses it.' },
            { name: 'amountsOnLockScreen', label: 'Show amounts on the lock screen', type: 'checkbox', from: 'amountsOnLockScreen', hint: 'Coming up on the lock screen names what is due and when; tick this to show how much too.' },
          ],
          submit: {
            tool: 'finance.set_money_settings', label: 'Save', done: 'Saved.',
            args: { currency: { field: 'currency' }, safetyFloor: { field: 'safetyFloor' }, amountsOnLockScreen: { field: 'amountsOnLockScreen' } },
          },
        },
      ],
    },
  ],
} as PageDescriptor;

export const moneyPages: PageDescriptor[] = [moneyPage, moneySettingsPage];
