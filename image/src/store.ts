/** The plugin's two tables. */
import type { DbArea, FilesArea } from '@buddi/core/plugin';

/** `ctx.buddi.db`, or anything that answers a query as it does. */
type Db = Pick<DbArea, 'query'>;

export const DEFAULT_DAILY_CAP = 30;

export interface Settings {
  accountId: string | null;
  model: string | null;
  dailyCap: number;
}

export async function getSettings(db: Db): Promise<Settings> {
  const { rows } = await db.query(`select account_id, model, daily_cap from image.settings where id`);
  const row = rows[0] as { account_id: string | null; model: string | null; daily_cap: number } | undefined;
  return { accountId: row?.account_id ?? null, model: row?.model ?? null, dailyCap: row?.daily_cap ?? DEFAULT_DAILY_CAP };
}

export async function setSettings(db: Db, settings: Settings, now: Date): Promise<Settings> {
  await db.query(
    `insert into image.settings (id, account_id, model, daily_cap, updated_at) values (true, $1, $2, $3, $4)
     on conflict (id) do update set account_id = excluded.account_id, model = excluded.model,
       daily_cap = excluded.daily_cap, updated_at = excluded.updated_at`,
    [settings.accountId, settings.model, settings.dailyCap, now],
  );
  return getSettings(db);
}

/** Images stored since midnight in the owner's timezone. */
export async function countToday(db: Db, now: Date, timezone: string): Promise<number> {
  const { rows } = await db.query(
    `select count(*)::int as n from image.generation
      where created_at >= (date_trunc('day', $1::timestamptz at time zone $2) at time zone $2)`,
    [now, timezone],
  );
  return (rows[0] as { n: number }).n;
}

export interface GenerationRecord {
  artifactId: string;
  agentId: string;
  conversationId: string | null;
  prompt: string;
  aspect: string;
  referenceIds: string[];
  backend: string;
  accountId: string;
  model: string;
  bytes: number;
  now: Date;
}

export async function recordGeneration(db: Db, record: GenerationRecord): Promise<string> {
  const { rows } = await db.query(
    `insert into image.generation
       (artifact_id, agent_id, conversation_id, prompt, aspect, reference_ids, backend, account_id, model, bytes, created_at)
     values ($1, $2, $3, $4, $5, $6::uuid[], $7, $8, $9, $10, $11) returning id::text`,
    [record.artifactId, record.agentId, record.conversationId, record.prompt, record.aspect, record.referenceIds,
      record.backend, record.accountId, record.model, record.bytes, record.now],
  );
  return (rows[0] as { id: string }).id;
}

export async function recentGenerations(db: Db, files: FilesArea, limit = 20): Promise<Array<Record<string, unknown>>> {
  const { rows } = await db.query(
    `select g.artifact_id::text as id, g.agent_id as agent, left(g.prompt, 120) as prompt, g.backend, g.model,
            g.created_at as "createdAt"
       from image.generation g
      order by g.created_at desc limit $1`,
    [limit],
  );
  for (const row of rows) row.name = (await files.get(String(row.id)))?.filename ?? null;
  return rows as Array<Record<string, unknown>>;
}

/**
 * The last time an image was stored with each account: a success, since a
 * row is written only after the picture came back and was kept. The settings
 * page reads it to tell a compatible server that has drawn from one that has
 * only ever chatted.
 */
export async function lastSuccessByAccount(db: Db): Promise<Map<string, Date>> {
  const { rows } = await db.query(
    `select account_id, max(created_at) as at from image.generation group by account_id`,
  );
  return new Map((rows as Array<{ account_id: string; at: Date }>).map((r) => [r.account_id, new Date(r.at)]));
}
