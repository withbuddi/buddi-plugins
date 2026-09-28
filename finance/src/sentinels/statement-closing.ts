/**
 * statement-closing — a card reports its balance in three days, still over the
 * target it is held to.
 *
 * Information, never urgent: nothing breaks if it is missed, but the window is
 * real and it closes. The issuer snapshots the balance on the closing day, so
 * a payment made after it is a payment made for next cycle as far as the
 * bureaus are concerned.
 */
import { loadStatementForecast } from '../tools/cards.js';
import { num, loadPreferences, today } from '../tools/shared.js';
import { statementClosingFindings, type ClosingCard } from './helpers.js';
import { EVERY_12H, type Finding } from './types.js';
import {
  CREDIT_ROLES,
  agentIdForRoles,
  type MaybeRoleAwareContext,
  type RoleAwareSentinel,
} from './roles.js';

export const statementClosing: RoleAwareSentinel = {
  id: 'finance.statement-closing',
  description:
    "Reports credit cards whose statement closes within three days while utilization is still above the target that card is held to — its own, or the installation's default of 30%. Scored on the balance the card is on course to REPORT, charges billed to it included, not on the balance as it stands today. One finding per card per cycle, carrying the whole recommendation as a sentence.",
  every: EVERY_12H,
  async run(ctx: MaybeRoleAwareContext): Promise<Finding[]> {
    const day = today(ctx);
    const prefs = await loadPreferences(ctx.buddi!.db);
    const { rows } = await ctx.buddi!.db.query(
      `select id, name, balance, credit_limit, statement_day, reports_day, utilization_target
         from finance.liabilities
        where active and kind = 'credit_card'
          and statement_day is not null and credit_limit is not null and credit_limit > 0
        order by name`,
    );
    // The card's own recurring charges are part of what it will report, so the
    // watch scores the forecast balance where there is one — a card that looks
    // fine today and closes over 30% once the premiums land is exactly the case
    // worth a nudge, and the one the balance alone would miss.
    const cards: ClosingCard[] = [];
    for (const r of rows) {
      const card = {
        id: r.id as string,
        name: r.name as string,
        balance: num(r.balance),
        creditLimit: r.credit_limit === null ? null : num(r.credit_limit),
        statementDay: r.statement_day === null ? null : Number(r.statement_day),
      };
      const forecast = await loadStatementForecast(ctx.buddi!.db, card, day);
      cards.push({
        name: card.name,
        balance: card.balance,
        creditLimit: card.creditLimit,
        statementDay: card.statementDay,
        reportsDay: r.reports_day === null ? null : Number(r.reports_day),
        utilizationTarget:
          r.utilization_target === null || r.utilization_target === undefined
            ? null
            : num(r.utilization_target),
        forecastBalance: forecast.hasForecast ? forecast.forecastBalance : null,
      });
    }
    const findings: Finding[] = statementClosingFindings(cards, {
      agentId: agentIdForRoles(ctx, CREDIT_ROLES, { sentinelId: statementClosing.id }),
      today: day,
      currency: prefs.currency,
      defaultUtilizationTarget: prefs.utilizationTarget,
    });
    return findings;
  },
};
