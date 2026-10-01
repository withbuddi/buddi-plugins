/**
 * stale-balance — the number every projection starts from has gone cold.
 *
 * Only accounts the cash flow actually reads: a retirement account nobody has
 * confirmed in a month changes no answer, and asking about it teaches the
 * owner that these messages are not worth reading.
 */
import { num, loadPreferences, today, toDateString } from '../tools/shared.js';
import { STALE_BALANCE_DAYS, staleBalanceFindings, type StaleAccount } from './helpers.js';
import { DAILY, type Finding, WAKE_COALESCE } from './types.js';
import {
  ADVISOR_ROLES,
  agentIdForRoles,
  type MaybeRoleAwareContext,
  type RoleAwareSentinel,
} from './roles.js';

export const staleBalance: RoleAwareSentinel = {
  id: 'finance.stale-balance',
  description:
    'Reports cash-flow accounts whose balance has not been confirmed for more than two weeks.',
  every: DAILY,
  coalesce: WAKE_COALESCE,
  async run(ctx: MaybeRoleAwareContext): Promise<Finding[]> {
    const day = today(ctx);
    const prefs = await loadPreferences(ctx.buddi!.db);
    const { rows } = await ctx.buddi!.db.query(
      `select name, balance, balance_as_of from finance.accounts
        where include_in_cashflow and balance_as_of < $1::date - $2::int
        order by balance_as_of, name`,
      [day, STALE_BALANCE_DAYS],
    );
    const accounts: StaleAccount[] = rows.map((r) => ({
      name: r.name as string,
      balance: num(r.balance),
      balanceAsOf: toDateString(r.balance_as_of),
    }));
    const findings: Finding[] = staleBalanceFindings(accounts, {
      agentId: agentIdForRoles(ctx, ADVISOR_ROLES, { sentinelId: staleBalance.id }),
      today: day,
      currency: prefs.currency,
    });
    return findings;
  },
};
