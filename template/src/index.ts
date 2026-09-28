/**
 * template — a buddi plugin.
 *
 * The whole contract is `PluginManifest` in `@buddi/core/plugin`, and
 * everything a tool reaches beyond its arguments is on `ctx.buddi`. This file is
 * the smallest honest example of both: one tool at tier `auto` (a read of this
 * plugin's own schema, which runs inline the moment a model calls it) and one
 * at tier `gated` (it changes something the owner cannot get back, so the call
 * becomes an action the owner approves before `execute` is ever reached).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EffectDescription, PluginManifest, ToolDefinition } from '@buddi/core/plugin';
import { z } from 'zod';

/**
 * Absolute, and resolved from the *built* file so it is right from `dist`.
 * `fileURLToPath`, never `new URL(...).pathname`: that form percent-encodes a
 * space, and a data directory called "owner data" then does not exist.
 */
export const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'migrations',
);

/* ------------------------------------------------------------------ *
 * An `auto` tool: a read of this plugin's own schema.
 * ------------------------------------------------------------------ */

const listInput = z.object({
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe('How many notes to return, newest first. Defaults to 20, at most 100.'),
});

export interface Note {
  id: string;
  body: string;
  createdAt: string;
}

export const listNotes: ToolDefinition<z.infer<typeof listInput>, { notes: Note[] }> = {
  name: 'template.list_notes',
  // Say *when* to use it, in the second person to the model.
  description:
    'List the notes this plugin has stored, newest first. Use it before answering anything that ' +
    'depends on what was written down here.',
  tier: 'auto',
  input: listInput,
  async execute(input, ctx) {
    // `ctx.buddi` is the host, bound to this plugin: core sets it on every
    // context it hands you. Reach the database, the clock and the rest there.
    const { rows } = await ctx.buddi!.db.query(
      `select id::text as id, body, created_at from template.note order by created_at desc limit $1`,
      [input.limit ?? 20],
    );
    return {
      notes: (rows as Array<{ id: string; body: string; created_at: Date }>).map((row) => ({
        id: row.id,
        body: row.body,
        createdAt: row.created_at.toISOString(),
      })),
    };
  },
};

/* ------------------------------------------------------------------ *
 * A `gated` tool: it destroys something, so the owner approves it first.
 * ------------------------------------------------------------------ */

const forgetInput = z.object({
  id: z.string().uuid().describe('The note to delete, from template.list_notes.'),
});

export const forgetNote: ToolDefinition<z.infer<typeof forgetInput>, { deleted: boolean }> = {
  name: 'template.forget_note',
  description: 'Delete one note for good. The owner is asked before anything is deleted.',
  tier: 'gated',
  input: forgetInput,
  /**
   * What will actually happen, the whole of it.
   *
   * Pure and read-only: it runs *before* any approval exists. The envelope is
   * what the ledger hashes, so anything that decides the effect belongs in it;
   * the preview is the short plain sentence the owner reads, rendered from the
   * envelope and never from anything a model wrote.
   */
  async describe(input, ctx): Promise<EffectDescription> {
    const { rows } = await ctx.buddi!.db.query(`select body from template.note where id = $1`, [input.id]);
    const body = (rows[0] as { body: string } | undefined)?.body;
    return {
      envelope: { tool: 'template.forget_note', id: input.id, body: body ?? null },
      preview:
        body === undefined
          ? `Delete note ${input.id}, which is not there any more.`
          : `Delete this note for good: "${body.slice(0, 120)}"`,
    };
  },
  async execute(input, ctx) {
    // Only `executeApproved` ever calls a gated `execute`, and it sets
    // `actionId`. Absent, something is calling this outside the approval
    // machinery: fail closed rather than guess.
    const actionId = ctx.actionId?.trim();
    if (!actionId) {
      throw new Error('template.forget_note: no approved action id in the tool context; refusing');
    }
    // One atomic statement, so a replay of the same action cannot act twice.
    const { rowCount } = await ctx.buddi!.db.query(`delete from template.note where id = $1`, [input.id]);
    return { deleted: (rowCount ?? 0) > 0 };
  },
};

/* ------------------------------------------------------------------ *
 * A source, when you want work to start with no agent in the loop.
 * ------------------------------------------------------------------ *
 *
 * A source polls on a period and originates runs. Uncomment it, add
 * `sources: [poll]` to the manifest, and read §2.2 of docs/plugins.md first: a
 * first-contact cursor starts at *now*, the cursor advances in the same
 * transaction as the rows it stands for, and `dedupKey` is stable for the life
 * of that row.
 *
 * import type { Source } from '@buddi/core/plugin';
 *
 * export const poll: Source = {
 *   id: 'template.poll',
 *   description: 'Looks for new work every ten minutes.',
 *   every: 600,
 *   async poll(ctx) {
 *     ctx.buddi!.log('nothing to do');
 *   },
 * };
 */

/* ------------------------------------------------------------------ *
 * The manifest
 * ------------------------------------------------------------------ */

export const manifest: PluginManifest = {
  name: 'template',
  // Bumping this voids every standing approval for this plugin's tools.
  version: '0.1.0',
  schema: 'template',
  migrationsDir: MIGRATIONS_DIR,
  tools: [listNotes, forgetNote],
  // One line, shown before anybody installs you.
  description: 'Keeps short notes, and deletes one when the owner says so.',
  // Every host you intend to reach, and why. Documentation, not a sandbox —
  // and it is compared with your buddi.md at install.
  network: [],
  // The areas of `ctx.buddi` you reach beyond your own schema, directory and
  // approvals: `http`, `files`, `accounts`, ... Repeated as `buddi.uses` in
  // package.json, because the install card is drawn before this file is
  // imported; the two must match. This plugin reaches nothing else.
  uses: [],
};

export default manifest;
