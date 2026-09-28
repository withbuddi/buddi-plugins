/**
 * When Ledger is worth offering: while nobody holds `overview`, so an owner
 * with a hand-made advisor is not asked to add a second one.
 */
import { describe, expect, it } from 'vitest';
import type { ToolContext } from '@buddi/core/plugin';
import { ledgerOfferQuery, ledgerWanted } from './agents.js';

const withRoles = (held: Record<string, string>): Pick<ToolContext, 'buddi'> =>
  ({ buddi: { owner: { agentForRole: (role: string) => held[role] } } }) as unknown as Pick<ToolContext, 'buddi'>;

describe('the Ledger offer', () => {
  it('is wanted while no agent holds overview', () => {
    expect(ledgerWanted(withRoles({}))).toBe(true);
    // Another role held changes nothing.
    expect(ledgerWanted(withRoles({ mail: 'mail-triage', credit: 'credit-coach' }))).toBe(true);
  });

  it('is not wanted once any agent holds overview, whatever it is called', () => {
    expect(ledgerWanted(withRoles({ overview: 'finance-advisor' }))).toBe(false);
    expect(ledgerWanted(withRoles({ overview: 'ledger' }))).toBe(false);
  });

  it('is wanted when the host cannot say who holds a role', () => {
    expect(ledgerWanted({} as Pick<ToolContext, 'buddi'>)).toBe(true);
  });

  it('answers through the page query as { wanted }', async () => {
    const query = ledgerOfferQuery();
    expect(query.params.parse({})).toEqual({});
    await expect(query.produce({}, withRoles({}) as ToolContext)).resolves.toEqual({ wanted: true });
    await expect(query.produce({}, withRoles({ overview: 'finance-advisor' }) as ToolContext)).resolves.toEqual({
      wanted: false,
    });
  });
});
