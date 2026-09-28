/**
 * For the DB suites: a tool call the way the owner saying yes would run it.
 *
 * `registry.invoke` on a gated tool records an action and waits for the
 * owner, rightly. The suites that import statements want the write itself, so
 * a gated tool is described (a refusal there is the tool saying no before any
 * card) and then executed with the envelope it described, as an approved
 * action is. Everything else goes through the registry as it stands.
 *
 * Plugin code reaches core through `@buddi/core/plugin` only, this file
 * included, so the suite hands in its registry and how it builds the host.
 */
import type { ToolContext } from '@buddi/core/plugin';
import { manifest } from '../index.js';

export type Invoked = { ok: true; output: any } | { ok: false; reason: string; message: string };

interface Invoker<C> {
  invoke(name: string, args: unknown, ctx: C): Promise<{ ok: true; output: unknown } | { ok: false; reason: string; message: string }>;
}

export async function invokeApproved<C extends ToolContext>(
  registry: Invoker<C>,
  name: string,
  args: unknown,
  ctx: C,
  hostFor: (ctx: C) => NonNullable<ToolContext['buddi']>,
): Promise<Invoked> {
  const tool = manifest.tools.find((t) => t.name === name);
  if (!tool || tool.tier !== 'gated' || !tool.describe || !tool.input) {
    const result = await registry.invoke(name, args, ctx);
    return result.ok ? { ok: true, output: result.output } : { ok: false, reason: result.reason, message: result.message };
  }
  const parsed = tool.input.safeParse(args);
  if (!parsed.success) return { ok: false, reason: 'invalid-input', message: parsed.error.message };
  // The registry hands a plugin its host on every call; this does the same.
  const own: C = { ...ctx };
  own.buddi = ctx.buddi ?? hostFor(own);
  try {
    const effect = await tool.describe(parsed.data, own);
    const output = await tool.execute(parsed.data, { ...own, approvedEffect: { envelope: effect.envelope } });
    return { ok: true, output };
  } catch (err) {
    return { ok: false, reason: 'tool-error', message: err instanceof Error ? err.message : String(err) };
  }
}
