/**
 * The owner's secrets, delivered into a child process's environment
 * (docs/owner-secrets.md §3, §4 — the `developer.env` destination).
 *
 * The 2026-09-23 incident this spec answers: with no other way to give a
 * process a password, an agent wrote one into the workspace's `.env`, into the
 * chat and into an agent's memory. The destination below is the other way. A
 * secret the owner stores — bound to `developer.env` with a target naming one
 * workspace directory and one variable name — reaches the plugin only through
 * `deliver` here, and the run that asked for it takes the value straight into
 * the child's environment (`tools/run.ts`). It is never written to a file by
 * buddi, never returned in a result, and never logged; the only trace anywhere
 * is the scrub marker `‹secret:NAME›`, which is how `developer.write` and
 * `developer.edit` recognise content that carries a stored value and refuse it
 * (`storedContentRefusal`).
 *
 * The shape is the mail plugin's (`packages/tools/email/src/credentials.ts`):
 * `deliver` holds the value against the use id, and the one caller that asked
 * takes it at once. A use id is answered to exactly one caller, so two runs
 * starting together never take each other's value, and the map is empty again
 * the moment each run has spawned.
 */
import type { BuddiHost, SecretDestination, SecretListing, SecretUseResult, ToolContext } from '@buddi/core/plugin';
import { ToolRefusal } from '@buddi/core/plugin';
import { isInside, realpathish } from './paths.js';
import type { Workspace } from './store.js';

/** The destination kind a workspace's environment variables are bound to. */
export const ENV_KIND = 'developer.env';

/** What a binding names: one exact workspace directory, one variable name. */
export interface EnvTarget {
  workspace: string;
  variable: string;
}

/**
 * Values delivered and not yet taken, by use id. `deliver` puts one here and
 * the run that asked takes it out at once; see the file comment for why a use
 * id is a safe key.
 */
const handed = new Map<string, string>();

/** The value a use delivered, taken once: the second ask finds nothing. */
export function takeDelivered(use: string): string | undefined {
  const value = handed.get(use);
  if (value !== undefined) handed.delete(use);
  return value;
}

/**
 * The variable name a binding spells, as an environment variable is spelled:
 * upper case, digits and underscores, never starting with a digit. The
 * comparison is by this normal form, so a binding written `admin_password`
 * and a run asking for `ADMIN_PASSWORD` are the same variable — and a binding
 * that is not a variable name at all binds nothing.
 */
export function envVariableName(variable: unknown): string | undefined {
  if (typeof variable !== 'string') return undefined;
  const name = variable.trim().toUpperCase();
  return /^[A-Z_][A-Z0-9_]*$/.test(name) ? name : undefined;
}

/** The target, when it is one: plain data with a workspace path and a variable. */
function envTarget(target: unknown): EnvTarget | undefined {
  if (typeof target !== 'object' || target === null) return undefined;
  const { workspace, variable } = target as { workspace?: unknown; variable?: unknown };
  if (typeof workspace !== 'string' || workspace.trim() === '') return undefined;
  const name = envVariableName(variable);
  return name === undefined ? undefined : { workspace, variable: name };
}

/**
 * Do two spellings name the same directory? Resolved the way `paths.ts`
 * resolves a workspace root (`realpathish` — the deepest existing ancestor,
 * the rest appended) and compared the way that file compares paths
 * (`isInside` both ways is equality, case-insensitive where the platform is).
 * Equality is all a target check needs: the run that asks names the workspace
 * it is standing in, and the binding names the one the owner chose.
 */
async function sameWorkspace(a: string, b: string): Promise<boolean> {
  const left = await realpathish(a);
  const right = await realpathish(b);
  return isInside(left, right) && isInside(right, left);
}

/** `developer.env`: one variable of one workspace's child environment. */
export const envDestination: SecretDestination = {
  kind: ENV_KIND,
  // owner-secrets.md §4: pre-approved per workspace — the value only ever reaches the owner's
  // own processes. A binding the owner made stricter stays stricter; the use
  // machinery runs the stricter of the two.
  maxRule: 'pre-approved',
  async checkTarget(target, bound) {
    const asked = envTarget(target);
    const named = envTarget(bound);
    if (asked === undefined || named === undefined) return false;
    if (asked.variable !== named.variable) return false;
    return sameWorkspace(asked.workspace, named.workspace);
  },
  describe: (target) => {
    const t = envTarget(target);
    return t === undefined
      ? 'an environment variable of a workspace'
      : `the ${t.variable} variable of the workspace at ${t.workspace}`;
  },
  deliver(value, _target, { use }) {
    handed.set(use, value);
  },
};

/* ------------------------------------------------------------------ *
 * The delivery a run or a start asks for
 * ------------------------------------------------------------------ */

/** What a run or a start got from the owner's secrets. Never a value outside `env`. */
export interface EnvSecrets {
  /** Into the child's environment, keyed by variable name. Nothing else holds these. */
  env: Record<string, string>;
  /** The variable names delivered, in the order they went in. */
  delivered: string[];
  /** The variables that did not go, each with one clean sentence saying why. */
  skipped: Array<{ variable: string; why: string }>;
  /** One line when the owner's secrets could not be read at all; nothing was delivered. */
  problem?: string;
}

const PENDING_WHY =
  'the owner has a card to decide this use — the card names the variable and the command — and the value goes in once it is decided';
const REFUSED_WHY = 'the binding refused this use, so nothing was delivered';

/**
 * Every binding for this workspace, asked for and delivered.
 *
 * `list` answers names and bindings only — the variable names come from the
 * bindings themselves, never from anything the caller claimed — and one `use`
 * per variable carries the binding check, the rule and the delivery. A pending
 * card or a refusal skips the variable and says so by name in the result;
 * nothing here throws. A process with no secrets area, or a listing that
 * fails, degrades to "no delivery" and one line (§E of the build note): the
 * child simply runs without the variable, as it always did.
 */
export async function envSecretsFor(ctx: ToolContext, workspace: Workspace): Promise<EnvSecrets> {
  const none: EnvSecrets = { env: {}, delivered: [], skipped: [] };
  const secrets = ctx.buddi?.secrets;
  if (secrets === undefined) {
    return {
      ...none,
      problem: 'owner secrets are not available in this process, so no variables were delivered.',
    };
  }
  let listed: SecretListing[];
  try {
    listed = await secrets.list();
  } catch {
    return { ...none, problem: "the owner's secrets could not be read, so no variables were delivered." };
  }
  // Which secret fills which variable of *this* workspace, from the bindings
  // alone. Two bindings for one variable: the first secret named wins, and the
  // rest are not asked — one variable, one value.
  const wanted = new Map<string, string>();
  for (const listing of listed) {
    for (const binding of listing.bindings) {
      if (binding.kind !== ENV_KIND) continue;
      const target = envTarget(binding.target);
      if (target === undefined || wanted.has(target.variable)) continue;
      if (await sameWorkspace(target.workspace, workspace.dir)) wanted.set(target.variable, listing.name);
    }
  }
  const env: Record<string, string> = {};
  const delivered: string[] = [];
  const skipped: Array<{ variable: string; why: string }> = [];
  for (const variable of [...wanted.keys()].sort()) {
    let outcome: SecretUseResult;
    try {
      outcome = await secrets.use(wanted.get(variable)!, ENV_KIND, { workspace: workspace.dir, variable });
    } catch {
      skipped.push({ variable, why: 'the use could not be asked in this process, so nothing was delivered' });
      continue;
    }
    if ('done' in outcome) {
      const value = takeDelivered(outcome.use);
      if (value === undefined || value.trim() === '') {
        skipped.push({ variable, why: 'the use was allowed but nothing was delivered' });
      } else {
        env[variable] = value;
        delivered.push(variable);
      }
    } else if ('pending' in outcome) {
      skipped.push({ variable, why: PENDING_WHY });
    } else {
      skipped.push({ variable, why: REFUSED_WHY });
    }
  }
  return { env, delivered, skipped };
}

/**
 * The result's `secrets` field, when there is anything to say: which variables
 * went into the child's environment, which did not and why, and the degrade
 * line when the owner's secrets could not be read. By name, never by value —
 * and absent altogether when nothing was bound, so an ordinary run's result
 * carries no secrets noise at all.
 */
export function secretsResult(secrets: EnvSecrets): { secrets: Record<string, unknown> } | Record<string, never> {
  if (secrets.delivered.length === 0 && secrets.skipped.length === 0 && secrets.problem === undefined) return {};
  return {
    secrets: {
      delivered: secrets.delivered,
      skipped: secrets.skipped,
      ...(secrets.problem === undefined ? {} : { note: secrets.problem }),
    },
  };
}

/* ------------------------------------------------------------------ *
 * The write refusal: the file is never the test
 * ------------------------------------------------------------------ */

/** The marker a scrubbed value carries, name included. */
const MARKER = /‹secret:([^›]+)›/g;

/**
 * The refusal for content that carries a stored value (owner-secrets §4):
 * the candidate content goes through the host's scrub, and a scrub that
 * changed anything means a stored value is in it — whatever the file, because
 * the file is never the test and agents write `.env` files with ordinary
 * configuration all the time. The names come from the scrubbed form, so the
 * agent is told what to bind and never sees what it must not copy. A process
 * with no secrets scrubs nothing, and everything passes unchanged.
 */
export function storedContentRefusal(buddi: BuddiHost, content: string): ToolRefusal | undefined {
  const scrubbed = buddi.scrub(content);
  if (scrubbed === content) return undefined;
  const markers = [...new Set([...scrubbed.matchAll(MARKER)].map((match) => match[0]))];
  return new ToolRefusal(
    `refused: this content contains a stored secret (${markers.join(', ')}), and writing it would copy the value ` +
      'into a file — which is exactly how one reached .env, the chat and memory last time. Bind it instead: the ' +
      'owner stores it in Settings → Keys and secrets, bound to developer.env for this workspace, and ' +
      'developer.start and developer.run deliver it into the process environment. Nothing in the file needs it.',
  );
}