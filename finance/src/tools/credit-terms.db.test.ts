/**
 * DB-backed tests for the credit domain: a card's terms, the score history,
 * the overview built on both, and the statement-closing watch.
 *
 * Skipped unless DATABASE_URL is set. Like the other DB suites, it never
 * touches the developer's data: it creates a throwaway database, migrates this
 * plugin into it, and drops it at the end.
 */
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ToolRegistry, createPluginHost, createPool, hostBindingOf, migrate } from '@buddi/core/testing';
import type { CoreSentinelContext, CoreToolContext } from '@buddi/core/testing';
import { manifest } from '../index.js';
import { statementClosing } from '../sentinels/statement-closing.js';
import { testDatabaseUrl } from '@buddi/core/testing';

const databaseUrl = await testDatabaseUrl();
const suite = databaseUrl ? describe : describe.skip;

const TEST_DB = `buddi_finance_credit_test_${process.pid}`;

/** 2026-09-15 is a Tuesday; the Amex closes on it. */
const NOW = new Date('2026-09-13T12:00:00Z');
const AMEX = 'Amex Gold';
const VISA = 'Visa Everyday';

/** The context core hands finance: these facts, with finance's `ctx.buddi` built over them. */
function hosted<C extends CoreSentinelContext>(facts: C): C {
  return { ...facts, buddi: createPluginHost(hostBindingOf(manifest), facts) };
}

suite('the credit domain (postgres)', () => {
  let admin: Pool;
  let pool: Pool;
  let ctx: CoreToolContext;
  /**
   * The sentinel half of the context.
   *
   * A sentinel is handed a `CoreSentinelContext`, not a `CoreToolContext`: it carries
   * `agentForRole`, which answers with the id of the agent holding a role or
   * **`undefined`** when nobody does (`packages/core/src/sentinels/types.ts`).
   * These suites used to spread a `CoreToolContext` into `run()` and answer with
   * `null`, which typechecked against an older core and does not against this
   * one — `null` is not `undefined`, and "nobody holds it" has one spelling.
   */
  let sentinelCtx: CoreSentinelContext;
  const registry = new ToolRegistry();

  const call = async (name: string, args: unknown): Promise<any> => {
    const result = await registry.invoke(name, args, ctx);
    if (!result.ok) throw new Error(`${name} refused (${result.reason}): ${result.message}`);
    return result.output;
  };

  beforeAll(async () => {
    const url = new URL(databaseUrl as string);
    admin = createPool(databaseUrl as string);
    await admin.query(`drop database if exists ${TEST_DB}`);
    await admin.query(`create database ${TEST_DB}`);

    const testUrl = new URL(url.toString());
    testUrl.pathname = `/${TEST_DB}`;
    pool = createPool(testUrl.toString());
    await migrate(pool, { schema: manifest.schema, dir: manifest.migrationsDir });

    registry.register(manifest);
    ctx = { db: pool, ownerId: 'test', now: () => NOW, timezone: 'UTC' };
    sentinelCtx = hosted({ db: pool, ownerId: 'test', now: () => NOW, timezone: 'UTC', agentForRole: () => undefined });

    await call('finance.set_preferences', { currency: 'USD', safetyFloor: 0 });
    await call('finance.set_liability', {
      name: AMEX,
      kind: 'credit_card',
      balance: 700,
      minimumPayment: 35,
      dueDay: 5,
    });
    await call('finance.set_liability', {
      name: VISA,
      kind: 'credit_card',
      balance: 300,
      creditLimit: 2000,
      minimumPayment: 25,
      dueDay: 12,
      statementDay: 28,
    });
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`drop database if exists ${TEST_DB}`);
      await admin.end();
    }
  });

  /* ---------------- the default target ---------------- */

  describe('the utilization target', () => {
    it('defaults to 30% for the installation', async () => {
      const prefs = await call('finance.get_preferences', {});
      expect(prefs.utilizationTarget).toBe(30);
    });
  });

  /* ---------------- set_card_terms ---------------- */

  describe('finance.set_card_terms', () => {
    it('refuses a card it does not know, and says where to record it', async () => {
      const result = await call('finance.set_card_terms', {
        card: 'Nonexistent',
        creditLimit: 500,
      });
      expect(result.status).toBe('unknown-card');
      expect(result.message).toMatch(/finance\.set_liability/);
    });

    it('records the closing day, the reporting day, the limit and the target', async () => {
      const result = await call('finance.set_card_terms', {
        card: AMEX,
        statementClosesDay: 15,
        reportsDay: 18,
        creditLimit: 1000,
      });
      expect(result).toMatchObject({
        status: 'ok',
        card: AMEX,
        statementClosesDay: 15,
        reportsDay: 18,
        creditLimit: 1000,
        utilizationTarget: 30,
        targetIsPerCard: false,
        statementClosesOn: '2026-09-15',
        reportsOn: '2026-09-18',
        utilization: 70,
      });
      expect(result.missing).toEqual([]);
    });

    it('matches the card case-insensitively', async () => {
      const result = await call('finance.set_card_terms', {
        card: 'amex gold',
        utilizationTarget: 25,
      });
      expect(result.card).toBe(AMEX);
      expect(result.utilizationTarget).toBe(25);
      expect(result.targetIsPerCard).toBe(true);
    });

    it('changes only what was passed, and leaves the rest alone', async () => {
      const result = await call('finance.set_card_terms', { card: AMEX, creditLimit: 1000 });
      expect(result).toMatchObject({
        statementClosesDay: 15,
        reportsDay: 18,
        utilizationTarget: 25,
      });
      // Put the card back on the installation default for the tests below.
      await pool.query(
        `update finance.liabilities set utilization_target = null where lower(name) = lower($1)`,
        [AMEX],
      );
    });

    it('refuses a call that sets nothing', async () => {
      const result = await registry.invoke('finance.set_card_terms', { card: AMEX }, ctx);
      expect(result.ok).toBe(false);
    });
  });

  /* ---------------- record_credit_score ---------------- */

  describe('finance.record_credit_score', () => {
    it('stores the bureau, the source and the date, and has no delta the first time', async () => {
      const first = await call('finance.record_credit_score', {
        bureau: 'Experian',
        score: 690,
        observedOn: '2026-07-01',
        source: 'Credit Karma',
      });
      expect(first).toMatchObject({
        bureau: 'Experian',
        source: 'Credit Karma',
        score: 690,
        observedOn: '2026-07-01',
        delta: null,
      });
    });

    it('defaults the date to today in the owner zone', async () => {
      const row = await call('finance.record_credit_score', {
        bureau: 'Equifax',
        score: 705,
      });
      expect(row.observedOn).toBe('2026-09-13');
      expect(row.source).toBeNull();
    });

    it('measures the change against the same bureau, never across bureaus', async () => {
      const second = await call('finance.record_credit_score', {
        bureau: 'Experian',
        score: 712,
        observedOn: '2026-09-01',
      });
      expect(second).toMatchObject({ delta: 22, previousScore: 690 });
    });

    it('keeps a history rather than overwriting', async () => {
      const history = await call('finance.credit_score_history', {});
      expect(history.count).toBe(3);
      expect(history.scores[0]).toMatchObject({ bureau: 'Equifax', score: 705 });
      const experian = history.scores.filter((s: any) => s.bureau === 'Experian');
      expect(experian).toHaveLength(2);
    });
  });

  /* ---------------- credit_overview ---------------- */

  describe('finance.credit_overview', () => {
    it('gives, per card, the balance, limit, utilization, closing date and days until', async () => {
      const overview = await call('finance.credit_overview', {});
      const amex = overview.cards.find((c: any) => c.name === AMEX);
      expect(amex).toMatchObject({
        balance: 700,
        creditLimit: 1000,
        utilization: 70,
        utilizationTarget: 30,
        statementClosesOn: '2026-09-15',
        daysUntilClosing: 2,
        reportsOn: '2026-09-18',
        reportedUtilizationEstimate: 70,
        overTarget: true,
        paymentToTarget: 400,
        payBy: '2026-09-14',
      });
    });

    it('carries the whole recommendation as one sentence, and none for a card at target', async () => {
      const overview = await call('finance.credit_overview', {});
      const amex = overview.cards.find((c: any) => c.name === AMEX);
      const visa = overview.cards.find((c: any) => c.name === VISA);
      expect(amex.sentence).toBe(
        'Amex Gold closes Tuesday at 70%; paying 400 by Monday brings it under 30%',
      );
      expect(visa.sentence).toBeNull();
      expect(overview.overTarget).toEqual([AMEX]);
    });

    it('reports the overall utilization across every card with a limit', async () => {
      const overview = await call('finance.credit_overview', {});
      expect(overview).toMatchObject({
        totalBalance: 1000,
        totalLimit: 3000,
        overallUtilization: 33.33,
        totalReportedEstimate: 1000,
        overallReportedUtilization: 33.33,
        defaultUtilizationTarget: 30,
      });
    });

    it('carries the score history and its trend, per bureau', async () => {
      const overview = await call('finance.credit_overview', {});
      expect(overview.score.count).toBe(3);
      const experian = overview.score.perBureau.find((b: any) => b.bureau === 'Experian');
      expect(experian).toMatchObject({ change: 22, direction: 'up' });
      const equifax = overview.score.perBureau.find((b: any) => b.bureau === 'Equifax');
      expect(equifax).toMatchObject({ change: null, direction: null });
    });

    it('is scored on what a card will REPORT once its charges land', async () => {
      await call('finance.add_recurring', {
        kind: 'charge',
        name: 'GEICO premium',
        amount: 300,
        cadence: 'monthly',
        anchorDate: '2026-09-14',
        liability: VISA,
      });
      const overview = await call('finance.credit_overview', {});
      const visa = overview.cards.find((c: any) => c.name === VISA);
      expect(visa.balance).toBe(300);
      expect(visa.reportedBalanceEstimate).toBe(600);
      expect(visa.reportedUtilizationEstimate).toBe(30);
      expect(visa.overTarget).toBe(false);
    });

    it('names what has never been asked for, once, with the tool that records it', async () => {
      await call('finance.set_liability', {
        name: 'Store card',
        kind: 'credit_card',
        balance: 90,
        minimumPayment: 10,
        dueDay: 20,
      });
      const overview = await call('finance.credit_overview', {});
      expect(overview.missing).toContainEqual({
        card: 'Store card',
        fields: ['creditLimit', 'statementClosesDay'],
      });
      expect(overview.askOnce.join(' ')).toMatch(/Store card/);
      expect(overview.message).toMatch(/finance\.set_card_terms/);
      await pool.query(`update finance.liabilities set active = false where name = 'Store card'`);
    });
  });

  /* ---------------- the statement-closing sentinel ---------------- */

  describe('finance.statement-closing', () => {
    it('raises one finding per card, with the sentence as its title', async () => {
      const findings = await statementClosing.run(sentinelCtx);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.key).toBe(`statement:${AMEX}:2026-09-15`);
      expect(findings[0]?.severity).toBe('info');
      expect(findings[0]?.title).toBe(
        'Amex Gold closes Tuesday at 70%; paying 400 by Monday brings it under 30%',
      );
    });

    it('keys the same card and cycle identically on every run in the window', async () => {
      const first = await statementClosing.run(sentinelCtx);
      const later = await statementClosing.run(hosted({
        ...sentinelCtx,
        now: () => new Date('2026-09-14T06:00:00Z'),
      }));
      expect(later).toHaveLength(1);
      expect(later[0]?.key).toBe(first[0]?.key);
    });

    it('keys the next cycle differently, so it is heard again', async () => {
      const next = await statementClosing.run(hosted({
        ...sentinelCtx,
        now: () => new Date('2026-10-13T12:00:00Z'),
      }));
      expect(next[0]?.key).toBe(`statement:${AMEX}:2026-10-15`);
    });

    it('addresses the finding to whoever holds the credit role', async () => {
      const [held] = await statementClosing.run(hosted({
        ...sentinelCtx,
        agentForRole: (role: string) => (role === 'credit' ? 'credit-coach' : undefined),
      }));
      expect(held?.agentId).toBe('credit-coach');
    });

    it('falls back to the overview role when nobody holds credit', async () => {
      const [fallback] = await statementClosing.run(hosted({
        ...sentinelCtx,
        agentForRole: (role: string) => (role === 'overview' ? 'finance-advisor' : undefined),
      }));
      expect(fallback?.agentId).toBe('finance-advisor');
    });

    it('names nobody, rather than a ghost, when no agent holds either role', async () => {
      const [orphan] = await statementClosing.run(hosted({ ...sentinelCtx, agentForRole: () => undefined }));
      expect(orphan?.agentId).toBeUndefined();
      expect('agentId' in (orphan as object)).toBe(false);
      // Still a finding: core defaults an unaddressed one to the wake mission's
      // agent, so the owner hears it.
      expect(orphan?.key).toBe(`statement:${AMEX}:2026-09-15`);
    });

    it("measures a card against its own target when it carries one", async () => {
      await call('finance.set_card_terms', { card: AMEX, utilizationTarget: 90 });
      expect(await statementClosing.run(sentinelCtx)).toEqual([]);
      await pool.query(
        `update finance.liabilities set utilization_target = null where lower(name) = lower($1)`,
        [AMEX],
      );
    });

    it('stays quiet once the card is paid under its target', async () => {
      await call('finance.set_liability', {
        name: AMEX,
        kind: 'credit_card',
        balance: 250,
        minimumPayment: 35,
        dueDay: 5,
      });
      expect(await statementClosing.run(sentinelCtx)).toEqual([]);
    });
  });
});
