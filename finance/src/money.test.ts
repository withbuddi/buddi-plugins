/**
 * The Money page and widgets without a database: the descriptors through
 * core's own validation (the news pattern), the widgets' samples, the words a
 * row says, Coming up's occurrences with Mark paid behind them, and the
 * manifest's new claims agreeing with package.json and buddi.md.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parsePageContributions } from '@buddi/core/testing';
import { parseWidgets } from '@buddi/core/plugin';
import { manifest } from './index.js';
import { changedWords, dueOccurrences, dueWords, moneyPages, moneyWords, type RecurringRow } from './money.js';
import { occurrencesBetween, project } from './projection.js';
import { dueRow } from './widget.js';
import { statementPrompt } from './tools/money.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string; buddi: { uses: string[]; hostApi: string };
};
const md = readFileSync(new URL('../buddi.md', import.meta.url), 'utf8');

const TODAY = '2026-10-05'; // a Monday

const rent: RecurringRow = {
  id: '00000000-0000-4000-8000-000000000001', name: 'Rent', kind: 'charge', amount: 1250, cadence: 'monthly',
  anchorDate: '2026-01-08', paidThrough: null, account: 'Checking', billedTo: null,
};

describe('the pages', () => {
  it('pass core\'s validation: every query, tool and drawer they name exists', () => {
    const parsed = parsePageContributions({
      plugin: 'finance', pages: moneyPages, queries: manifest.queries ?? [], tools: manifest.tools.map((t) => t.name),
    });
    expect(parsed.pages.map((p) => [p.id, p.place])).toEqual([['money', 'rail'], ['settings', 'settings']]);
  });

  it('draw Accounts, Coming up, Cards & debts and Statements read, with the empty line the owner reads', () => {
    // One wrapping section holds everything with an amount, so one Show reveals it all.
    const wrapper = moneyPages[0]!.body.find((c) => c.kind === 'section') as unknown as { title?: string; body: Array<{ kind: string; title: string; body: Array<{ empty?: string }> }> };
    expect(wrapper.title).toBeUndefined();
    const sections = wrapper.body.filter((c) => c.kind === 'section');
    expect(sections.map((s) => s.title)).toEqual(['Accounts', 'Coming up', 'Cards & debts', 'Statements read']);
    expect(sections[0]!.body[0]!.empty).toBe('No accounts yet');
  });

  it('opens the first-run sheet by `?open=setup`, with finance.setup behind it', () => {
    const drawers = moneyPages[0]!.body.filter((c) => c.kind === 'form') as Array<{ drawer?: { id?: string }; submit: { tool: string } }>;
    expect(drawers.map((d) => [d.drawer?.id, d.submit.tool])).toEqual([
      [undefined, 'finance.setup'], // the empty state's own button
      ['account', 'finance.set_balance'],
      ['recurring', 'finance.add_recurring'],
      ['setup', 'finance.setup'],
    ]);
  });

  it('masks every read that carries an amount', () => {
    const sensitive = (manifest.queries ?? []).filter((q) => q.sensitive).map((q) => q.name).sort();
    expect(sensitive).toEqual(['accounts', 'coming_up', 'debts', 'money_totals', 'statements']);
  });
});

describe('the widgets', () => {
  const widgets = parseWidgets('finance', manifest.widgets, { pages: moneyPages.map((p) => p.id), taken: () => false });

  it('are Money (sensitive, never on a lock screen) and Coming up (for the lock screen), both opening the page', () => {
    expect(widgets.map((w) => [w.id, w.sizes, w.sensitive === true, w.link?.page])).toEqual([
      ['finance.money', ['medium', 'small'], true, 'money'],
      ['finance.due', ['small', 'medium'], false, 'money'],
    ]);
  });

  it('give the market a sample per size that core draws', () => {
    expect(widgets[0]!.preview?.medium).toMatchObject({ kind: 'list', max: 5 });
    expect(widgets[0]!.preview?.small).toMatchObject({ kind: 'stat' });
    expect(widgets[1]!.preview?.small).toMatchObject({ kind: 'list' });
  });

  it('say how much only when the owner allowed it', () => {
    const [due] = dueOccurrences([rent], TODAY, 'EUR');
    expect(dueRow(due!, false)).toEqual({ title: 'Rent', side: 'Thu' });
    expect(dueRow(due!, true)).toEqual({ title: 'Rent', side: '€1,250 · Thu' });
  });
});

describe('words', () => {
  it('say amounts in the owner\'s currency, cents only when there are some', () => {
    expect(moneyWords(1250, 'EUR')).toBe('€1,250');
    expect(moneyWords(19.99, 'USD')).toBe('$19.99');
    expect(moneyWords(-42.5, 'EUR')).toBe('−€42.50');
    expect(moneyWords(4820.4, 'EUR', { whole: true })).toBe('€4,820');
  });

  it('say a due day as the owner would', () => {
    expect(dueWords('2026-10-05', TODAY)).toBe('today');
    expect(dueWords('2026-10-06', TODAY)).toBe('tomorrow');
    expect(dueWords('2026-10-08', TODAY)).toBe('Thu');
    expect(dueWords('2026-10-15', TODAY)).toBe('Thu 15 Oct');
  });

  it('say what a statement changed', () => {
    expect(changedWords({ newRows: 12, totalOut: 1240.3, totalIn: 2100, dateRange: { from: '2026-09-01', to: '2026-09-30' } }, 'EUR'))
      .toBe('12 new lines · −€1,240 out · +€2,100 in · 1 Sep – 30 Sep');
    expect(changedWords({ newRows: 0, duplicates: 4 }, 'EUR')).toBe('nothing new');
  });
});

describe('Coming up and Mark paid', () => {
  it('lists each charge due in the next 30 days, soonest first, and never an income', () => {
    const salary: RecurringRow = { ...rent, id: '00000000-0000-4000-8000-000000000002', name: 'Salary', kind: 'income', amount: 3200, anchorDate: '2026-01-28' };
    const phone: RecurringRow = { ...rent, id: '00000000-0000-4000-8000-000000000003', name: 'Phone', amount: 19.99, anchorDate: '2026-01-06', account: null, billedTo: 'Amex' };
    const due = dueOccurrences([rent, salary, phone], TODAY, 'EUR');
    // Thirty days from 5 Oct ends on 3 Nov: November's phone bill is not yet coming up.
    expect(due.map((d) => [d.name, d.date])).toEqual([['Phone', '2026-10-06'], ['Rent', '2026-10-08']]);
    expect(due[0]!.line).toBe('Due tomorrow · on Amex · Monthly');
    expect(due[1]).toMatchObject({ key: `${rent.id}:2026-10-08`, line: 'Due Thu · from Checking · Monthly', side: '€1,250' });
  });

  it('leaves out an occurrence marked paid, there and in the projection', () => {
    const paid = { ...rent, paidThrough: '2026-10-08' };
    expect(dueOccurrences([paid], TODAY, 'EUR')).toEqual([]);
    expect(occurrencesBetween(paid, TODAY, '2026-11-30')).toEqual(['2026-11-08']);
    const p = project({ startDate: TODAY, startBalance: 2000, horizonDays: 10, items: [paid], safetyFloor: 0 });
    expect(p.endBalance).toBe(2000);
    expect(project({ startDate: TODAY, startBalance: 2000, horizonDays: 10, items: [rent], safetyFloor: 0 }).endBalance).toBe(750);
  });
});

describe('the setup sheet\'s hand-off', () => {
  it('asks the advisor to stage, record the balance and ask before committing', () => {
    const prompt = statementPrompt('Checking', '11111111-1111-4111-8111-111111111111', 'sept.pdf');
    expect(prompt).toContain('finance.stage_import (account "Checking", source "statement", artifactId "11111111-1111-4111-8111-111111111111")');
    expect(prompt).toMatch(/ask before committing; never commit on your own/);
    expect(prompt).toContain('#/p/finance/money');
  });
});

describe('the manifest\'s new claims', () => {
  it('adds Mark paid for agents, and keeps setup and the settings from every model', () => {
    const tool = (name: string) => manifest.tools.find((t) => t.name === name);
    expect(tool('finance.mark_paid')).toMatchObject({ tier: 'auto' });
    expect(tool('finance.mark_paid')?.ownerOnly).not.toBe(true);
    expect(tool('finance.setup')).toMatchObject({ tier: 'auto', ownerOnly: true });
    expect(tool('finance.set_money_settings')).toMatchObject({ tier: 'auto', ownerOnly: true });
  });

  it('says what it uses, its host API and its version, as package.json does; buddi.md names the page', () => {
    expect(manifest.uses).toEqual(pkg.buddi.uses);
    expect(manifest.uses).toEqual(['files:library', 'schedule']);
    expect(pkg.buddi.hostApi).toBe('^1.28');
    expect(manifest.version).toBe(pkg.version);
    expect(md).toContain('#/p/finance/money');
    expect(md).toContain('finance.setup');
  });
});
