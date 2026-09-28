/**
 * What the mode means, as pure functions.
 *
 * §3: `ask` gates every write and every command; `edit` lets reads, searches,
 * edits and writes through and gates commands; `run` lets a command through
 * **only when it is on the run list** (`runlist.ts`).
 *
 * That last clause is the change two reviews forced. `run` used to mean
 * "anything the §5 denylist did not recognise", which is not a statement about
 * anything. It now means "one of the few programs the owner meant", and the
 * old parser survives only to put a *name* on the card when something asks.
 *
 * The tier a tool *declares* is `session` (see `index.ts`): that is the floor,
 * and it is what makes acceptance §10.5 true by construction — a delegate has
 * no owner request and no session grant, so it never reaches these functions
 * at all. `tierFor` then lowers a call to `auto` when the mode says so.
 */
import type { Tier } from '@buddi/core/plugin';

/**
 * What `ToolDefinition.tierFor` answers, named.
 *
 * Core declares the shape inline; a name for it is what lets the three
 * functions below say what they return, and what the tools import.
 */
export interface TierFor {
  tier: Tier;
  reason?: string;
}
import type { GateDecision } from './parser.js';
import type { RunListDecision } from './runlist.js';
import type { Mode } from './store.js';

/** What matched: "exactly `npm install`" or "any `npm install …` command". */
export interface StandingAllow {
  what: string;
}

/**
 * Does one of the owner's standing allows cover these words?
 *
 * Exact rows match the whole argv; prefix rows match when the command begins
 * with their words. A row never matches an empty command.
 */
export function standingFor(
  allows: ReadonlyArray<{ argv: readonly string[]; prefix: boolean }>,
  words: readonly string[] | undefined,
): StandingAllow | undefined {
  if (!words || words.length === 0) return undefined;
  for (const allow of allows) {
    if (allow.argv.length === 0 || allow.argv.length > words.length) continue;
    if (!allow.prefix && allow.argv.length !== words.length) continue;
    if (allow.argv.every((word, index) => words[index] === word)) {
      const shown = allow.argv.join(' ');
      return { what: allow.prefix ? `any \`${shown} …\` command` : `exactly \`${shown}\`` };
    }
  }
  return undefined;
}

/**
 * No workspace: the call costs nothing, because it will not do anything.
 *
 * `tierFor` may not throw — a throw refuses the call as a tool error — and
 * gating a call that is about to answer "you have no workspace" would put a
 * card in front of the owner for nothing. So it is `auto`, and `execute`
 * returns the refusal.
 */
export const NO_WORKSPACE_IS_AUTO: TierFor = {
  tier: 'auto',
  reason: 'there is no workspace yet, so this call only says so',
};

/** A read is a read in every mode: nothing observable changes. */
export const READ_IS_AUTO: TierFor = { tier: 'auto', reason: 'a read inside the workspace' };

/** `developer.write` and `developer.edit`. */
export function tierForWrite(mode: Mode): TierFor {
  if (mode === 'ask') {
    return { tier: 'gated', reason: 'the workspace is in ask mode, where every write is approved' };
  }
  return { tier: 'auto', reason: `${mode} mode: writes inside the workspace are yours to make` };
}

/**
 * `developer.run` and `developer.start`.
 *
 * `ask` and `edit` gate every command, full stop. `run` gates everything the
 * run list does not allow, and the reason it gives is the run list's — except
 * that the §5 denylist is consulted to *name* a rule when it recognises one,
 * because "npm install installs packages this machine did not have" is a
 * better card than "npm install is not on the run list".
 */
export function tierForCommand(
  mode: Mode,
  runList: RunListDecision,
  named?: GateDecision,
  /** The owner already said "always" to this command in this workspace. */
  standing?: StandingAllow,
): TierFor {
  // A standing allow is the owner's own earlier decision, and it holds in
  // every mode but `ask`, where the owner asked to see everything. It is
  // matched on the argv that will be spawned, so it only ever names a
  // command that is plain.
  if (standing && mode !== 'ask') {
    return { tier: 'auto', reason: `you allowed ${standing.what} in this workspace` };
  }
  if (mode !== 'run') {
    return {
      tier: 'gated',
      reason: `the workspace is in ${mode} mode, where every command is approved`,
    };
  }
  if (runList.allowed) {
    return { tier: 'auto', reason: runList.reason ?? 'run mode, and this command is on the run list' };
  }
  return {
    tier: 'gated',
    reason: named?.gated
      ? (named.reason as string)
      : (runList.reason ?? 'it is not on the run list'),
  };
}

/**
 * `developer.git`: reads are free; **`commit` is auto only in `run` mode**.
 *
 * `commit` moved out of `edit` because `git add` runs a repository's own clean
 * filters and `commit` its own hooks, and both are code in files an agent can
 * write. So a commit in `edit` mode is one more thing the owner sees, and in
 * `run` mode it is part of what `run` already means.
 */
export function tierForGit(mode: Mode, action: string): TierFor {
  if (action === 'status' || action === 'diff' || action === 'log' || action === 'branch_list') {
    return { tier: 'auto', reason: 'a read of the repository' };
  }
  if (action === 'commit') {
    if (mode === 'run') {
      return { tier: 'auto', reason: "run mode: a commit on the agent's own branch" };
    }
    return {
      tier: 'gated',
      reason: `${mode} mode: a commit runs the repository's own filters and hooks, so it is approved`,
    };
  }
  // A new repository is a one-time decision about a directory, and after it
  // every later git action here means something. The owner sees it in every
  // mode.
  if (action === 'init') {
    return { tier: 'gated', reason: 'creating a repository is approved in every mode' };
  }
  if (mode === 'ask') {
    return { tier: 'gated', reason: `ask mode: git ${action} is approved first` };
  }
  return { tier: 'auto', reason: `${mode} mode: git ${action} on the agent's own branch` };
}
