/**
 * Who speaks about a finding — resolved by ROLE, never written down as an id.
 *
 * A finding carries `agentId`, and core has nothing else: `Finding` has no
 * `role` field and `SentinelContext` is `{ db, now, timezone }` with no roster
 * in it. So a plugin that hard-codes `agentId: 'credit-coach'` is naming an
 * agent that may have been deleted this morning, and core will faithfully
 * address a ghost — the finding is stored, the wake mission fires, and there is
 * nobody by that name to speak.
 *
 * This module is the seam. It asks the host, at poll time, who holds a role,
 * and it does so through a shape the host MAY provide rather than one core
 * promises today:
 *
 *   ctx.buddi.owner.agentForRole(role) → an id, or undefined
 *   ctx.agents?.agentForRole() → core's own AgentCatalog, if it is ever passed
 *
 * When neither is there, or nobody holds any of the roles asked for, the answer
 * is `undefined` and the finding goes out with NO agentId. That is not a
 * silence: core documents `agentId` as optional and defaults it to the wake
 * mission's agent, which is by construction an agent that exists. An unaddressed
 * finding reaches the owner; a misaddressed one does not. We say so once per
 * process and never again — a warning on every tick of a twice-daily watch is
 * how a log stops being read.
 */
import type { Finding, Sentinel, SentinelContext } from './types.js';

/** Who should speak about credit: the credit coach, else whoever gives the overview. */
export const CREDIT_ROLES = ['credit', 'overview'] as const;
/** Who should speak about cash, balances and paperwork. */
export const ADVISOR_ROLES = ['overview'] as const;

/** The simplest thing a host can hand us: a role in, an agent id out. */
export type RoleResolver = (role: string) => string | null | undefined;

/** Core's `AgentCatalog`, structurally — we need one method of it. */
interface CatalogLike {
  agentForRole(role: string): { ok: boolean; agent?: { id: string } };
}

/** What a host may add to the sentinel context. Every field optional. */
export interface RosterCarrier {
  agentForRole?: RoleResolver;
  agents?: CatalogLike;
}

/** A context that may or may not carry a roster. */
export type MaybeRoleAwareContext = SentinelContext & RosterCarrier;

/**
 * A sentinel whose `run` accepts the roster when the host has one.
 *
 * It IS a `Sentinel` — core calls it with a plain context and nothing changes —
 * but the wider parameter is part of the type, so a caller that does have a
 * roster can pass it without a cast.
 */
export interface RoleAwareSentinel extends Sentinel {
  run(ctx: MaybeRoleAwareContext): Promise<Finding[]>;
}

const warned = new Set<string>();

/** Tests share a process; each one starts from a clean slate of warnings. */
export function resetRoleWarnings(): void {
  warned.clear();
}

function fromCarrier(carrier: MaybeRoleAwareContext, role: string): string | undefined {
  const direct = carrier.buddi?.owner.agentForRole(role);
  if (typeof direct === 'string' && direct.trim() !== '') return direct.trim();
  const resolution = carrier.agents?.agentForRole(role);
  const id = resolution?.ok === true ? resolution.agent?.id : undefined;
  return typeof id === 'string' && id.trim() !== '' ? id.trim() : undefined;
}

/**
 * The agent holding the first of `roles` that anybody holds, or `undefined`.
 *
 * The order of `roles` is the fallback chain and it is deliberate: credit work
 * goes to whoever holds `credit`, and an installation that never created a
 * credit coach still has someone who gives the overview.
 */
export function agentIdForRoles(
  ctx: MaybeRoleAwareContext,
  roles: readonly string[],
  opts: { sentinelId: string; warn?: (message: string) => void },
): string | undefined {
  for (const role of roles) {
    const id = fromCarrier(ctx, role);
    if (id !== undefined) return id;
  }
  const key = `${opts.sentinelId}:${roles.join(',')}`;
  if (!warned.has(key)) {
    warned.add(key);
    const warn = opts.warn ?? ((message: string) => console.warn(message));
    warn(
      `${opts.sentinelId}: no agent holds ${roles.map((r) => `'${r}'`).join(' or ')}; ` +
        'its findings name no agent and fall to the wake mission\'s agent. ' +
        'Give an agent the role to have them addressed by name.',
    );
  }
  return undefined;
}
