/**
 * floor-breach — the projection says the owner runs out of room.
 *
 * It reuses `finance.project_cashflow` itself rather than re-deriving a
 * projection: the tool already knows which accounts are spendable, which
 * recurring items to believe, what the measured daily burn is and which
 * pending charges are committed. A sentinel that computed its own projection
 * would eventually disagree with the one the agent quotes, and the owner would
 * be told two different things about the same week.
 */
import { projectCashflow } from '../tools/cashflow.js';
import { loadPreferences, today } from '../tools/shared.js';
import { floorBreachFinding } from './helpers.js';
import { EVERY_6H, type Finding, WAKE_COALESCE } from './types.js';
import {
  ADVISOR_ROLES,
  agentIdForRoles,
  type MaybeRoleAwareContext,
  type RoleAwareSentinel,
} from './roles.js';

/** Far enough to see a month coming, short enough that the tail stays real. */
export const FLOOR_BREACH_HORIZON_DAYS = 30;

interface CashflowShape {
  startDate: string;
  minBalance: number;
  minBalanceDate: string;
  firstBreachDate: string | null;
  safetyFloor: number;
  currency: string;
}

export const floorBreach: RoleAwareSentinel = {
  id: 'finance.floor-breach',
  description:
    'Projects 30 days of cash and reports the first day the balance falls below the safety floor (or below zero when no floor is set).',
  every: EVERY_6H,
  coalesce: WAKE_COALESCE,
  async run(ctx: MaybeRoleAwareContext): Promise<Finding[]> {
    const toolCtx = { buddi: ctx.buddi! };
    const prefs = await loadPreferences(ctx.buddi!.db, ctx.buddi!.owner);

    // No recorded balance and no items is not a breach, it is an empty ledger.
    const { rows } = await ctx.buddi!.db.query(
      `select count(*)::int as n from finance.accounts where include_in_cashflow`,
    );
    if ((rows[0]?.n ?? 0) === 0) return [];

    const result = (await projectCashflow.execute(
      { horizonDays: FLOOR_BREACH_HORIZON_DAYS },
      toolCtx,
    )) as CashflowShape;

    const agentId = agentIdForRoles(ctx, ADVISOR_ROLES, { sentinelId: floorBreach.id });
    const finding = floorBreachFinding({
      agentId,
      firstBreachDate: result.firstBreachDate ?? null,
      minBalance: result.minBalance,
      minBalanceDate: result.minBalanceDate,
      safetyFloor: result.safetyFloor ?? prefs.safetyFloor,
      currency: result.currency ?? prefs.currency,
      startDate: result.startDate ?? today(ctx),
      horizonDays: FLOOR_BREACH_HORIZON_DAYS,
    });
    return finding === null ? [] : [finding];
  },
};
