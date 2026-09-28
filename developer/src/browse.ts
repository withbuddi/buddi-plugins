/**
 * The owner's reads of a workspace: what the canvas's Files tab is drawn from.
 *
 * These are page *queries*, not tools (docs/plugin-pages.md §3): the
 * owner is reading their own disk, so no agent's mode or tier applies, and
 * nothing here can write. What does apply is the boundary, unchanged — every
 * path goes through `resolveInside`, the same function `developer.read` and
 * `developer.list` use, so a query cannot name a path outside the workspace,
 * cannot follow a symbolic link out of it and cannot reach the deny list; and
 * every open is `O_NOFOLLOW` with the identity check after it (`openNoFollow`).
 *
 * A listing is the same listing the agent gets (`listTree`, git's ignore rules
 * when it is a repository), one folder at a time. A refusal — a link, a path
 * that is not there — is the owner's to read, so it leaves as a
 * `QueryRefusal` with the boundary's own sentence.
 */
import { constants } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { QueryRefusal, pageFile, type PageFile, type ToolContext } from '@buddi/core/plugin';
import { z } from 'zod';
import { ARCHIVE_LIMITS, zip, type ZipEntry } from './archive.js';
import { listTree, looksBinary, readBytesNoFollow } from './files.js';
import { PathRefused, openNoFollow, resolveInside } from './paths.js';
import { getWorkspace, type Workspace } from './store.js';
import { denyInside, trackedFiles } from './tools/files.js';

/** How many entries one folder shows. More is a folder nobody reads as a list. */
export const FOLDER_MAX_ENTRIES = 1_000;

const agent = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/, 'an agent id');
const relativePath = z.string().max(4096);

export const workspaceParams = z.object({ agent }).strict();
export const listParams = z.object({ agent, path: relativePath.optional() }).strict();
export const statParams = z.object({ agent, path: relativePath.min(1) }).strict();
export const readParams = z
  .object({
    agent,
    path: relativePath.min(1),
    /** A cache-buster the page builds from size and mtime; never read here. */
    v: z.string().max(64).optional(),
    download: z.enum(['1']).optional(),
  })
  .strict();
export const archiveParams = z.object({ agent, path: relativePath.optional() }).strict();

export type FileType = 'text' | 'image' | 'pdf' | 'other';

const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
};

/** What a file is, from its name and — for text — its first 8 KB. */
export async function typeOf(file: string, root: string): Promise<{ type: FileType; mime: string }> {
  const ext = path.extname(file).toLowerCase();
  const image = IMAGE_TYPES[ext];
  if (image) return { type: 'image', mime: image };
  if (ext === '.pdf') return { type: 'pdf', mime: 'application/pdf' };
  return (await looksBinary(file, root))
    ? { type: 'other', mime: 'application/octet-stream' }
    : { type: 'text', mime: 'text/plain; charset=utf-8' };
}

/** The workspace an agent has, or a refusal the owner reads. */
async function workspaceOf(ctx: ToolContext, agentId: string): Promise<Workspace> {
  const workspace = await getWorkspace(ctx.buddi!.db, agentId);
  if (!workspace) throw new QueryRefusal(`${agentId} has no workspace.`);
  return workspace;
}

/** The boundary's refusals, and a path that is not there, as sentences for the owner. */
async function owned<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    if (err instanceof PathRefused) throw new QueryRefusal(err.message);
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') throw new QueryRefusal('That path is not in the workspace any more.');
    throw err;
  }
}

function relativeTo(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join('/');
}

async function resolve(workspace: Workspace, candidate: string, allowRoot: boolean): Promise<string> {
  return resolveInside(workspace.dir, candidate, {
    allowRoot,
    toolchainPath: workspace.toolchainPath,
  });
}

export async function workspaceFor(params: z.infer<typeof workspaceParams>, ctx: ToolContext) {
  const workspace = await getWorkspace(ctx.buddi!.db, params.agent);
  return { workspace: workspace ? { name: path.basename(workspace.dir), dir: workspace.dir } : null };
}

export interface FolderEntry {
  name: string;
  path: string;
  kind: 'file' | 'dir';
  bytes: number | null;
  mtimeMs: number | null;
}

export async function listFolder(params: z.infer<typeof listParams>, ctx: ToolContext) {
  const workspace = await workspaceOf(ctx, params.agent);
  return owned(async () => {
    const from = await resolve(workspace, params.path ?? '', true);
    const info = await stat(from);
    if (!info.isDirectory()) throw new QueryRefusal(`${params.path} is a file, not a folder.`);
    const root = await resolve(workspace, '', true);
    const tracked = await trackedFiles(workspace);
    const listed = await listTree(root, from, {
      depth: 1,
      limit: FOLDER_MAX_ENTRIES,
      tracked: tracked?.files,
      deny: await denyInside(workspace),
    });
    const entries: FolderEntry[] = listed.entries
      .map((entry) => ({
        name: path.basename(entry.path),
        path: entry.path.split(path.sep).join('/'),
        kind: entry.kind,
        bytes: entry.bytes ?? null,
        mtimeMs: entry.mtimeMs ?? null,
      }))
      // Folders first, then files, each by name: the order a file browser has.
      .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1));
    return {
      path: relativeTo(root, from),
      name: path.basename(from),
      entries,
      skipped: listed.skipped,
      truncated: listed.full === true,
    };
  });
}

export async function statFile(params: z.infer<typeof statParams>, ctx: ToolContext) {
  const workspace = await workspaceOf(ctx, params.agent);
  return owned(async () => {
    const file = await resolve(workspace, params.path, false);
    const root = await resolve(workspace, '', true);
    const info = await stat(file);
    if (!info.isFile()) throw new QueryRefusal(`${params.path} is not a file.`);
    const { type, mime } = await typeOf(file, root);
    return {
      path: relativeTo(root, file),
      name: path.basename(file),
      bytes: info.size,
      mtimeMs: info.mtimeMs,
      type,
      mime,
    };
  });
}

export async function readFile(params: z.infer<typeof readParams>, ctx: ToolContext): Promise<PageFile> {
  const workspace = await workspaceOf(ctx, params.agent);
  return owned(async () => {
    const file = await resolve(workspace, params.path, false);
    const root = await resolve(workspace, '', true);
    if (!(await stat(file)).isFile()) throw new QueryRefusal(`${params.path} is not a file.`);
    const { mime } = await typeOf(file, root);
    const handle = await openNoFollow(file, constants.O_RDONLY, { root });
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw new QueryRefusal(`${params.path} is not a file.`);
      return pageFile({
        // The descriptor that was checked, streamed and closed when it ends.
        body: handle.createReadStream({ autoClose: true }),
        contentType: mime,
        filename: path.basename(file),
        disposition: params.download === '1' ? 'attachment' : 'inline',
        size: info.size,
        immutable: params.v !== undefined,
      });
    } catch (err) {
      await handle.close().catch(() => undefined);
      throw err;
    }
  });
}

/** Refused, with the cap in the sentence the page shows. */
export function archiveCapSentence(): string {
  return (
    `This folder is over the archive cap of ${Math.round(ARCHIVE_LIMITS.bytes / (1024 * 1024))} MB or ` +
    `${ARCHIVE_LIMITS.files.toLocaleString('en-GB')} files. Download a smaller folder.`
  );
}

export async function archiveFolder(params: z.infer<typeof archiveParams>, ctx: ToolContext): Promise<PageFile> {
  const workspace = await workspaceOf(ctx, params.agent);
  return owned(async () => {
    const from = await resolve(workspace, params.path ?? '', true);
    const root = await resolve(workspace, '', true);
    const info = await stat(from);
    if (!info.isDirectory()) throw new QueryRefusal(`${params.path} is a file, not a folder.`);
    const tracked = await trackedFiles(workspace);
    const listed = await listTree(root, from, {
      depth: 10,
      limit: ARCHIVE_LIMITS.files * 2,
      tracked: tracked?.files,
      deny: await denyInside(workspace),
    });
    const files = listed.entries.filter((entry) => entry.kind === 'file');
    const total = files.reduce((sum, entry) => sum + (entry.bytes ?? 0), 0);
    if (listed.full || files.length > ARCHIVE_LIMITS.files || total > ARCHIVE_LIMITS.bytes) {
      throw new QueryRefusal(archiveCapSentence());
    }
    const base = path.relative(root, from);
    const entries: ZipEntry[] = [];
    let bytes = 0;
    for (const entry of files) {
      const file = path.join(root, entry.path);
      let data: Buffer;
      try {
        // Through the boundary again, and opened without following a link:
        // the tree was walked a moment ago and may have changed since.
        await resolve(workspace, entry.path, false);
        data = await readBytesNoFollow(file, root);
      } catch {
        continue;
      }
      bytes += data.length;
      if (bytes > ARCHIVE_LIMITS.bytes) throw new QueryRefusal(archiveCapSentence());
      const inside = (base === '' ? entry.path : path.relative(base, entry.path)).split(path.sep).join('/');
      entries.push({ name: inside, data, mtime: new Date(entry.mtimeMs ?? Date.now()) });
    }
    const body = zip(entries);
    const name = base === '' ? path.basename(root) : path.basename(from);
    return pageFile({
      body,
      contentType: 'application/zip',
      filename: `${name}.zip`,
      disposition: 'attachment',
      size: body.length,
    });
  });
}
