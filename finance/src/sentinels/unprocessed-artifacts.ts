/**
 * unprocessed-artifacts — a file was handed in and nothing ever came of it.
 *
 * This is the one sentinel that reads beyond finance's own schema, and it does
 * so deliberately and read-only: the question "did anything in the ledger come
 * out of this document?" can only be asked from the side that owns the ledger.
 * The files come from the Files library through `ctx.buddi.files`, never
 * written here, and the three references it checks are all finance's own
 * columns.
 */
import { localDateString, type FileRow } from '@buddi/core/plugin';
import { unprocessedArtifactsFinding, UNPROCESSED_ARTIFACT_HOURS, type UnprocessedArtifact } from './helpers.js';
import { EVERY_6H, type Finding } from './types.js';
import {
  ADVISOR_ROLES,
  agentIdForRoles,
  type MaybeRoleAwareContext,
  type RoleAwareSentinel,
} from './roles.js';

export const unprocessedArtifacts: RoleAwareSentinel = {
  id: 'finance.unprocessed-artifacts',
  description:
    'Reports files handed in more than a day ago that no transaction, receipt or staged import references.',
  every: EVERY_6H,
  async run(ctx: MaybeRoleAwareContext): Promise<Finding[]> {
    const now = ctx.buddi!.clock.now();
    // Every file handed in before the cutoff, from the Files library (this
    // plugin declares `files:library`), a page of at most a hundred at a time,
    // newest first. The next page starts just after the oldest of this one, so
    // a file sharing its millisecond is not skipped; `seen` drops the repeat.
    const cutoff = new Date(now.getTime() - UNPROCESSED_ARTIFACT_HOURS * 3_600_000);
    const seen = new Map<string, FileRow>();
    for (let before = cutoff; ; ) {
      const page = await ctx.buddi!.files!.list({ before, limit: 100 });
      const fresh = page.filter((file) => !seen.has(file.id));
      for (const file of fresh) seen.set(file.id, file);
      if (page.length < 100 || fresh.length === 0) break;
      const oldest = Date.parse(String(page[page.length - 1]!.createdAt));
      before = new Date(Math.min(oldest + 1, cutoff.getTime()));
    }
    const ids = [...seen.keys()];
    const { rows: referenced } = await ctx.buddi!.db.query<{ id: string }>(
      `select artifact_id::text as id from finance.transactions where artifact_id = any($1::uuid[])
       union select artifact_id::text from finance.receipts where artifact_id = any($1::uuid[])
       union select artifact_id::text from finance.import_stagings where artifact_id = any($1::uuid[])`,
      [ids],
    );
    const done = new Set(referenced.map((r) => r.id));
    const rows = [...seen.values()].filter((file) => !done.has(file.id)).reverse();
    const artifacts: UnprocessedArtifact[] = rows.map((r) => {
      const createdAt = new Date(String(r.createdAt));
      return {
        id: String(r.id),
        filename: r.filename ?? null,
        kind: r.kind as string,
        mime: r.mime as string,
        createdOn: localDateString(createdAt, ctx.buddi!.owner.timezone),
        ageHours: Math.floor((now.getTime() - createdAt.getTime()) / 3_600_000),
      };
    });
    const finding: Finding | null = unprocessedArtifactsFinding(artifacts, {
      agentId: agentIdForRoles(ctx, ADVISOR_ROLES, { sentinelId: unprocessedArtifacts.id }),
    });
    return finding === null ? [] : [finding];
  },
};
