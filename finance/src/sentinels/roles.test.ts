/**
 * Who a finding is addressed to, and what happens when nobody holds the role.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPluginHost, hostBindingOf } from '@buddi/core/testing';
import { manifest } from '../index.js';
import {
  ADVISOR_ROLES,
  CREDIT_ROLES,
  agentIdForRoles,
  resetRoleWarnings,
  type MaybeRoleAwareContext,
} from './roles.js';

/** Only the fields the resolver reads; no database is ever touched. */
const base = { db: null, now: () => new Date(), timezone: 'UTC' } as unknown as
  MaybeRoleAwareContext;

const rosterOf = (held: Record<string, string>): MaybeRoleAwareContext => {
  const facts: MaybeRoleAwareContext = { ...base, agentForRole: (role) => held[role] ?? undefined };
  return { ...facts, buddi: createPluginHost(hostBindingOf(manifest), facts as never) };
};

beforeEach(() => {
  resetRoleWarnings();
});

describe('agentIdForRoles', () => {
  it('names the agent holding the first role asked for', () => {
    const warn = vi.fn();
    const id = agentIdForRoles(rosterOf({ credit: 'credit-coach' }), CREDIT_ROLES, {
      sentinelId: 'finance.statement-closing',
      warn,
    });
    expect(id).toBe('credit-coach');
    expect(warn).not.toHaveBeenCalled();
  });

  it('falls back down the chain when nobody holds the first role', () => {
    const warn = vi.fn();
    // The owner deleted the credit coach; the advisor still gives the overview.
    const id = agentIdForRoles(rosterOf({ overview: 'finance-advisor' }), CREDIT_ROLES, {
      sentinelId: 'finance.statement-closing',
      warn,
    });
    expect(id).toBe('finance-advisor');
    expect(warn).not.toHaveBeenCalled();
  });

  it('prefers the credit role over the overview one when both are held', () => {
    const id = agentIdForRoles(
      rosterOf({ credit: 'credit-coach', overview: 'finance-advisor' }),
      CREDIT_ROLES,
      { sentinelId: 'finance.minimum-due', warn: vi.fn() },
    );
    expect(id).toBe('credit-coach');
  });

  it('names nobody when nobody holds any of the roles, and warns once', () => {
    const warn = vi.fn();
    const ctx = rosterOf({});
    expect(
      agentIdForRoles(ctx, CREDIT_ROLES, { sentinelId: 'finance.statement-closing', warn }),
    ).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("'credit' or 'overview'");

    // Twice a day, for ever, is how a log stops being read.
    agentIdForRoles(ctx, CREDIT_ROLES, { sentinelId: 'finance.statement-closing', warn });
    agentIdForRoles(ctx, CREDIT_ROLES, { sentinelId: 'finance.statement-closing', warn });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('warns once per sentinel, not once for all of them', () => {
    const warn = vi.fn();
    const ctx = rosterOf({});
    agentIdForRoles(ctx, CREDIT_ROLES, { sentinelId: 'finance.statement-closing', warn });
    agentIdForRoles(ctx, CREDIT_ROLES, { sentinelId: 'finance.minimum-due', warn });
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('names nobody when the host carries no roster at all', () => {
    const warn = vi.fn();
    expect(
      agentIdForRoles(base, ADVISOR_ROLES, { sentinelId: 'finance.stale-balance', warn }),
    ).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("reads core's own catalog shape when a host passes one", () => {
    const ctx: MaybeRoleAwareContext = {
      ...base,
      agents: {
        agentForRole: (role) =>
          role === 'credit'
            ? { ok: true, agent: { id: 'money' } }
            : { ok: false },
      },
    };
    expect(
      agentIdForRoles(ctx, CREDIT_ROLES, { sentinelId: 'finance.minimum-due', warn: vi.fn() }),
    ).toBe('money');
  });

  it('treats an empty or whitespace id as nobody', () => {
    const warn = vi.fn();
    expect(
      agentIdForRoles(rosterOf({ credit: '  ' }), ['credit'], {
        sentinelId: 'finance.statement-closing',
        warn,
      }),
    ).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
