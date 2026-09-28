/**
 * The credit overview arithmetic, with no database and no clock: every date
 * goes in as a string, so a month end is a test case rather than a hazard.
 */
import { describe, expect, it } from 'vitest';
import {
  closingSentence,
  creditOverview,
  formatPercent,
  overviewCard,
  paymentToTarget,
  scoreTrend,
  weekdayName,
  type CardTerms,
} from './credit.js';

const amex: CardTerms = {
  name: 'Amex',
  balance: 420,
  creditLimit: 1000,
  statementClosesDay: 24,
  reportsDay: null,
  utilizationTarget: null,
};

describe('paymentToTarget', () => {
  it('is what brings the reported balance to the target', () => {
    expect(paymentToTarget(420, 1000, 30)).toBe(120);
  });

  it('rounds up to a whole unit, so a cent of interest cannot put it back over', () => {
    expect(paymentToTarget(420.5, 1000, 30)).toBe(121);
  });

  it('is zero once the card is already at target, and null with no limit', () => {
    expect(paymentToTarget(200, 1000, 30)).toBe(0);
    expect(paymentToTarget(420, null, 30)).toBeNull();
  });
});

describe('overviewCard', () => {
  it('reports utilization today and the utilization it is on course to report', () => {
    const card = overviewCard(
      { ...amex, forecastBalance: 600 },
      { today: '2026-09-21' },
    );
    expect(card.utilization).toBe(42);
    expect(card.reportedBalanceEstimate).toBe(600);
    expect(card.reportedUtilizationEstimate).toBe(60);
    expect(card.overTarget).toBe(true);
    expect(card.paymentToTarget).toBe(300);
  });

  it('falls back to the balance when nothing is forecast', () => {
    const card = overviewCard(amex, { today: '2026-09-21' });
    expect(card.reportedBalanceEstimate).toBe(420);
    expect(card.reportedUtilizationEstimate).toBe(42);
  });

  it('counts the days to the next closing across a month end', () => {
    // Closes on the 2nd; from the 30th of January that is three days away and
    // lands in February, not eleven months later.
    const card = overviewCard(
      { ...amex, statementClosesDay: 2 },
      { today: '2026-01-30' },
    );
    expect(card.statementClosesOn).toBe('2026-02-02');
    expect(card.daysUntilClosing).toBe(3);
  });

  it('clamps a 31st closing day to the last day of a short month', () => {
    const card = overviewCard(
      { ...amex, statementClosesDay: 31 },
      { today: '2026-02-10' },
    );
    expect(card.statementClosesOn).toBe('2026-02-28');
    expect(card.daysUntilClosing).toBe(18);
  });

  it('closes today rather than next month when today IS the closing day', () => {
    const card = overviewCard(amex, { today: '2026-09-24' });
    expect(card.statementClosesOn).toBe('2026-09-24');
    expect(card.daysUntilClosing).toBe(0);
  });

  it('reports to the bureaus on the reporting day after the close, next month if need be', () => {
    const card = overviewCard(
      { ...amex, statementClosesDay: 29, reportsDay: 2 },
      { today: '2026-01-20' },
    );
    expect(card.statementClosesOn).toBe('2026-01-29');
    expect(card.reportsOn).toBe('2026-02-02');
  });

  it('assumes the closing day when no reporting day is recorded', () => {
    const card = overviewCard(amex, { today: '2026-09-21' });
    expect(card.reportsOn).toBe('2026-09-24');
  });

  it("prefers the card's own target over the installation default", () => {
    const strict = overviewCard(
      { ...amex, utilizationTarget: 10 },
      { today: '2026-09-21', defaultUtilizationTarget: 50 },
    );
    expect(strict.utilizationTarget).toBe(10);
    expect(strict.targetIsPerCard).toBe(true);
    expect(strict.overTarget).toBe(true);
    expect(strict.paymentToTarget).toBe(320);

    const relaxed = overviewCard(amex, {
      today: '2026-09-21',
      defaultUtilizationTarget: 50,
    });
    expect(relaxed.utilizationTarget).toBe(50);
    expect(relaxed.targetIsPerCard).toBe(false);
    expect(relaxed.overTarget).toBe(false);
  });

  it('names what has never been recorded, instead of guessing it', () => {
    const card = overviewCard(
      { ...amex, creditLimit: null, statementClosesDay: null },
      { today: '2026-09-21' },
    );
    expect(card.missing).toEqual(['creditLimit', 'statementClosesDay']);
    expect(card.utilization).toBeNull();
    expect(card.statementClosesOn).toBeNull();
    expect(card.daysUntilClosing).toBeNull();
  });
});

describe('closingSentence', () => {
  it('is the whole recommendation, computed from the numbers', () => {
    const card = overviewCard(amex, { today: '2026-09-21' });
    // 2026-09-24 is a Thursday, so the last day a payment still counts is the
    // Wednesday before it.
    expect(closingSentence(card)).toBe(
      'Amex closes Thursday at 42%; paying 120 by Wednesday brings it under 30%',
    );
  });

  it('says nothing about a card already at target', () => {
    const card = overviewCard({ ...amex, balance: 200 }, { today: '2026-09-21' });
    expect(closingSentence(card)).toBeNull();
  });

  it('says nothing without a limit — there is no target to be under', () => {
    const card = overviewCard({ ...amex, creditLimit: null }, { today: '2026-09-21' });
    expect(closingSentence(card)).toBeNull();
  });
});

describe('weekdayName and formatPercent', () => {
  it('reads the weekday in UTC, not the machine zone', () => {
    expect(weekdayName('2026-09-24')).toBe('Thursday');
    expect(weekdayName('2026-09-23')).toBe('Wednesday');
  });

  it('never shows a percentage to two decimals', () => {
    expect(formatPercent(42)).toBe('42');
    expect(formatPercent(42.42)).toBe('42.4');
    expect(formatPercent(30)).toBe('30');
  });
});

describe('creditOverview', () => {
  const cards: CardTerms[] = [
    amex,
    {
      name: 'Visa',
      balance: 300,
      creditLimit: 2000,
      statementClosesDay: 5,
      reportsDay: null,
      utilizationTarget: null,
    },
    {
      name: 'Store card',
      balance: 90,
      creditLimit: null,
      statementClosesDay: null,
      reportsDay: null,
      utilizationTarget: null,
    },
  ];

  it('sorts by the closing date, soonest first, and leaves the undated last', () => {
    const overview = creditOverview(cards, { today: '2026-09-21' });
    expect(overview.cards.map((c) => c.name)).toEqual(['Amex', 'Visa', 'Store card']);
  });

  it('sums utilization only over the cards that have a limit', () => {
    const overview = creditOverview(cards, { today: '2026-09-21' });
    expect(overview.totalBalance).toBe(720);
    expect(overview.totalLimit).toBe(3000);
    expect(overview.overallUtilization).toBe(24);
  });

  it('sums the reported estimate separately from the balances today', () => {
    const overview = creditOverview(
      cards.map((c) => (c.name === 'Amex' ? { ...c, forecastBalance: 600 } : c)),
      { today: '2026-09-21' },
    );
    expect(overview.totalReportedEstimate).toBe(900);
    expect(overview.overallReportedUtilization).toBe(30);
  });

  it('lists the cards over target and what has never been asked for', () => {
    const overview = creditOverview(cards, { today: '2026-09-21' });
    expect(overview.overTarget).toEqual(['Amex']);
    expect(overview.missing).toEqual([
      { card: 'Store card', fields: ['creditLimit', 'statementClosesDay'] },
    ]);
  });
});

describe('scoreTrend', () => {
  const points = [
    { bureau: 'Experian', score: 690, observedOn: '2026-07-01' },
    { bureau: 'Experian', score: 712, observedOn: '2026-09-01' },
    { bureau: 'Equifax', score: 705, observedOn: '2026-09-01' },
  ];

  it('compares within a bureau and never across one', () => {
    const trend = scoreTrend(points);
    const experian = trend.perBureau.find((b) => b.bureau === 'Experian');
    expect(experian?.change).toBe(22);
    expect(experian?.direction).toBe('up');
    expect(experian?.spanDays).toBe(62);

    const equifax = trend.perBureau.find((b) => b.bureau === 'Equifax');
    expect(equifax?.change).toBeNull();
    expect(equifax?.direction).toBeNull();
  });

  it('reads a fall and a flat reading apart', () => {
    const down = scoreTrend([
      { bureau: 'Experian', score: 712, observedOn: '2026-07-01' },
      { bureau: 'Experian', score: 700, observedOn: '2026-09-01' },
    ]);
    expect(down.perBureau[0]?.change).toBe(-12);
    expect(down.perBureau[0]?.direction).toBe('down');

    const flat = scoreTrend([
      { bureau: 'Experian', score: 700, observedOn: '2026-07-01' },
      { bureau: 'Experian', score: 700, observedOn: '2026-09-01' },
    ]);
    expect(flat.perBureau[0]?.direction).toBe('flat');
  });

  it('averages the latest reading of each bureau, and says nothing with nothing recorded', () => {
    expect(scoreTrend(points).averageLatest).toBe(709);
    expect(scoreTrend([]).averageLatest).toBeNull();
    expect(scoreTrend([]).latest).toBeNull();
  });

  it('treats the same bureau spelled differently as one series', () => {
    const trend = scoreTrend([
      { bureau: 'experian', score: 690, observedOn: '2026-07-01' },
      { bureau: 'Experian', score: 712, observedOn: '2026-09-01' },
    ]);
    expect(trend.perBureau).toHaveLength(1);
    expect(trend.perBureau[0]?.change).toBe(22);
  });
});
