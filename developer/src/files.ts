/**
 * The file half of §4: read, list, search, write, edit — everything that
 * touches the disk, with the bounds the spec names and nothing about tiers or
 * tool shapes, so it can be tested with a temp directory and no registry.
 *
 * Every function here takes a path that `resolveInside` has already blessed.
 * None of them resolves one itself: one boundary, used by every tool, is the
 * whole of §2, and a second resolution in here would be a second place for it
 * to be wrong.
 */
import { constants, createReadStream } from 'node:fs';
import { mkdir, lstat, readdir, rename, rm, stat } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { openNoFollow } from './paths.js';

export const READ_MAX_LINES = 2_000;
export const READ_MAX_BYTES = 200 * 1024;
export const SEARCH_MAX_RESULTS = 200;

/* ------------------------------------------------------------------ *
 * read
 * ------------------------------------------------------------------ */

export interface ReadResult {
  /** The text, with line numbers, ready to be fenced. */
  text: string;
  firstLine: number;
  lastLine: number;
  totalLines: number;
  bytes: number;
  truncated: boolean;
}

/**
 * Binary or not, decided the way `git` decides it: a NUL byte in the first
 * 8 KB. Cheap, and wrong only for files nobody was going to read anyway.
 */
export async function looksBinary(file: string, root?: string): Promise<boolean> {
  const handle = await openNoFollow(file, constants.O_RDONLY, root === undefined ? {} : { root });
  try {
    const buffer = Buffer.alloc(8 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).includes(0);
  } finally {
    await handle.close();
  }
}

/**
 * Read a file without following a link on the final component.
 *
 * Every read in this plugin goes through here rather than `fs.readFile`:
 * `resolveInside` refuses a symlink component it can see, and `O_NOFOLLOW`
 * refuses the one that appeared afterwards.
 */
/** The same, as bytes: an archive carries a file whatever it holds. */
export async function readBytesNoFollow(file: string, root?: string): Promise<Buffer> {
  const handle = await openNoFollow(file, constants.O_RDONLY, root === undefined ? {} : { root });
  try {
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

export async function readTextNoFollow(file: string, root?: string): Promise<string> {
  const handle = await openNoFollow(file, constants.O_RDONLY, root === undefined ? {} : { root });
  try {
    return await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
}

/** The identity of a file's contents, for "is this still the file I described". */
export function hashContent(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 32);
}

export async function readBounded(
  file: string,
  opts: { from?: number; lines?: number; root?: string } = {},
): Promise<ReadResult> {
  const info = await stat(file);
  if (info.isDirectory()) {
    throw new Error(`refused: ${path.basename(file)} is a directory. Use developer.list for a tree.`);
  }
  if (await looksBinary(file, opts.root)) {
    throw new Error(
      `refused: ${path.basename(file)} is a binary file of ${info.size} bytes. ` +
        'Nothing readable comes out of putting it in a conversation.',
    );
  }
  const raw = await readTextNoFollow(file, opts.root);
  const all = raw.split('\n');
  // A trailing newline makes one empty last element; it is not a line.
  if (all.length > 1 && all[all.length - 1] === '') all.pop();
  const from = Math.max(1, Math.floor(opts.from ?? 1));
  const want = Math.max(1, Math.min(READ_MAX_LINES, Math.floor(opts.lines ?? READ_MAX_LINES)));
  const slice = all.slice(from - 1, from - 1 + want);

  let bytes = 0;
  const kept: string[] = [];
  let byteTruncated = false;
  for (const line of slice) {
    const size = Buffer.byteLength(line, 'utf8') + 1;
    if (bytes + size > READ_MAX_BYTES) {
      byteTruncated = true;
      break;
    }
    bytes += size;
    kept.push(line);
  }
  const width = String(from + kept.length - 1).length;
  const text = kept
    .map((line, index) => `${String(from + index).padStart(width, ' ')}\t${line}`)
    .join('\n');
  return {
    text,
    firstLine: from,
    lastLine: from + Math.max(0, kept.length - 1),
    totalLines: all.length,
    bytes: info.size,
    truncated: byteTruncated || from - 1 + kept.length < all.length,
  };
}

/* ------------------------------------------------------------------ *
 * list
 * ------------------------------------------------------------------ */

/** Never walked into, in any repository, ignored or not. */
export const ALWAYS_SKIPPED = new Set(['node_modules', '.git']);

/**
 * A very small `.gitignore`: the patterns this plugin understands, and an
 * honest note about the ones it does not.
 *
 * It handles a literal name, a directory (`dist/`), a leading `/` (anchored to
 * the file's own directory), a leading `!` (a negation) and `*`/`?` globs. It
 * does **not** handle `**` spanning directories with a prefix, or the ordering
 * subtleties of nested ignore files. Where it is unsure it *keeps* the file —
 * showing one file too many is a worse listing, not a leak, and
 * `git ls-files` below is the accurate path whenever the workspace is a repo.
 */
export interface IgnoreRule {
  negated: boolean;
  dirOnly: boolean;
  anchored: boolean;
  regex: RegExp;
}

export function parseGitignore(text: string): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  for (const raw of text.split('\n')) {
    let line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const negated = line.startsWith('!');
    if (negated) line = line.slice(1);
    const dirOnly = line.endsWith('/');
    if (dirOnly) line = line.slice(0, -1);
    const anchored = line.startsWith('/');
    if (anchored) line = line.slice(1);
    if (line === '') continue;
    const body = line
      .split('')
      .map((ch) => {
        if (ch === '*') return '[^/]*';
        if (ch === '?') return '[^/]';
        return /[.+^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch;
      })
      .join('');
    rules.push({
      negated,
      dirOnly,
      anchored,
      regex: new RegExp(anchored || line.includes('/') ? `^${body}$` : `(^|/)${body}$`),
    });
  }
  return rules;
}

export function ignores(rules: readonly IgnoreRule[], relative: string, isDir: boolean): boolean {
  let ignored = false;
  for (const rule of rules) {
    if (rule.dirOnly && !isDir) continue;
    if (rule.regex.test(relative)) ignored = !rule.negated;
  }
  return ignored;
}

export interface ListOptions {
  depth?: number;
  /** The paths `git ls-files` knows about, relative to the workspace. */
  tracked?: ReadonlySet<string> | undefined;
  limit?: number;
  /** Absolute directories to prune, even when they are inside the workspace. */
  deny?: readonly string[];
}

export interface ListEntry {
  path: string;
  kind: 'file' | 'dir';
  bytes?: number;
  /** When the file was last written, as epoch milliseconds. */
  mtimeMs?: number;
}

/**
 * A listing, and how much of the tree it declined to look at.
 *
 * A walk must never fail on an entry it refuses. The owner's first real
 * workspace held one symbolic link — a dotfile in a bootstrap repository —
 * and the whole call came back as an error, which is the wrong shape of
 * answer entirely: a tree with a link in it is an ordinary tree, and the
 * honest reply is the other four hundred files plus "one was skipped".
 *
 * So every per-entry step is allowed to fail on its own, and the count is
 * carried out with the entries and said out loud in the tool result.
 */
export interface ListResult {
  entries: ListEntry[];
  /** Symlinked, denied or unreadable entries the walk stepped over. */
  skipped: number;
  /** Set when a directory below the depth limit held something not walked. */
  deeper?: true;
  /** Set when the walk stopped at `limit` entries. */
  full?: true;
}

/**
 * A tree, ignoring what `.gitignore` ignores and `node_modules` always.
 *
 * `tracked` is the accurate path: when the workspace is a git repository the
 * caller runs `git ls-files --cached --others --exclude-standard` and hands
 * the answer in, and git's own ignore rules — nested files, `**`, the global
 * excludes file — are what decide. The parser above is the fallback for a
 * directory that is not a repository.
 */
export async function listTree(
  root: string,
  from: string,
  opts: ListOptions = {},
): Promise<ListResult> {
  const maxDepth = Math.max(1, Math.min(10, Math.floor(opts.depth ?? 3)));
  const limit = opts.limit ?? 2_000;
  const out: ListEntry[] = [];
  let skipped = 0;
  let deeper = false;
  let full = false;

  const walk = async (dir: string, depth: number, rules: IgnoreRule[]): Promise<void> => {
    if (out.length >= limit) {
      full = true;
      return;
    }
    if (depth > maxDepth) {
      deeper = true;
      return;
    }
    let localRules = rules;
    if (opts.tracked === undefined) {
      try {
        localRules = [...rules, ...parseGitignore(await readTextNoFollow(path.join(dir, '.gitignore')))];
      } catch {
        /* no ignore file here */
      }
    }
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      // A directory this process may not read is one directory skipped, not
      // a failed listing.
      skipped += 1;
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (out.length >= limit) {
        full = true;
        return;
      }
      if (ALWAYS_SKIPPED.has(entry.name)) continue;
      try {
        const full = path.join(dir, entry.name);
        const relative = path.relative(root, full);
        // A symlink is never walked and never listed: the boundary refuses it
        // for reads too, so listing one would be offering a path that cannot
        // be opened. It is counted, not fatal.
        if (entry.isSymbolicLink()) {
          skipped += 1;
          continue;
        }
        if (opts.deny?.some((denied) => full === denied || full.startsWith(`${denied}/`))) {
          skipped += 1;
          continue;
        }
        const isDir = entry.isDirectory();
        if (opts.tracked !== undefined) {
          // A directory is interesting when anything tracked lives under it.
          const prefix = `${relative}/`;
          const known = isDir
            ? [...opts.tracked].some((file) => file.startsWith(prefix))
            : opts.tracked.has(relative);
          if (!known) continue;
        } else if (ignores(localRules, relative, isDir)) {
          continue;
        }
        if (isDir) {
          out.push({ path: relative, kind: 'dir' });
          await walk(full, depth + 1, localRules);
        } else if (entry.isFile()) {
          const info = await stat(full).catch(() => undefined);
          out.push({ path: relative, kind: 'file', ...(info ? { bytes: info.size, mtimeMs: info.mtimeMs } : {}) });
        } else {
          // A socket, a fifo, a device, or a dirent whose type the
          // filesystem would not say. Nothing to list, and nothing to fail.
          skipped += 1;
        }
      } catch {
        skipped += 1;
      }
    }
  };

  await walk(from, 1, []);
  return { entries: out, skipped, ...(deeper ? { deeper: true as const } : {}), ...(full ? { full: true as const } : {}) };
}

/* ------------------------------------------------------------------ *
 * search (the fallback; ripgrep is in `tools/files.ts`)
 * ------------------------------------------------------------------ */

export interface SearchHit {
  path: string;
  line: number;
  text: string;
}

/** `path:line: text`, which is what §4 says a result looks like. */
export function renderHits(hits: readonly SearchHit[]): string {
  return hits.map((hit) => `${hit.path}:${hit.line}: ${hit.text}`).join('\n');
}

export interface SearchResult {
  hits: SearchHit[];
  /** Entries the scan stepped over: links, denied directories, unreadable files. */
  skipped: number;
}

export async function searchFallback(
  root: string,
  opts: {
    query: string;
    regex?: boolean;
    glob?: string;
    limit?: number;
    tracked?: ReadonlySet<string> | undefined;
    deny?: readonly string[];
  },
): Promise<SearchResult> {
  const limit = opts.limit ?? SEARCH_MAX_RESULTS;
  const matcher = opts.regex === true ? new RegExp(opts.query) : undefined;
  const globRegex = opts.glob === undefined ? undefined : globToRegExp(opts.glob);
  const files = await listTree(root, root, {
    depth: 10,
    limit: 20_000,
    tracked: opts.tracked,
    ...(opts.deny ? { deny: opts.deny } : {}),
  });
  const hits: SearchHit[] = [];
  let skipped = files.skipped;
  for (const entry of files.entries) {
    if (hits.length >= limit) break;
    if (entry.kind !== 'file') continue;
    if (globRegex && !globRegex.test(entry.path)) continue;
    if ((entry.bytes ?? 0) > 2 * 1024 * 1024) continue;
    const full = path.join(root, entry.path);
    if (await looksBinary(full).catch(() => true)) continue;
    let content: string;
    try {
      content = await readTextNoFollow(full);
    } catch {
      // A file that became a link, or that this process may not read. One
      // file skipped; the search still answers.
      skipped += 1;
      continue;
    }
    const lines = content.split('\n');
    for (let i = 0; i < lines.length && hits.length < limit; i += 1) {
      const line = lines[i] as string;
      const found = matcher ? matcher.test(line) : line.includes(opts.query);
      if (found) hits.push({ path: entry.path, line: i + 1, text: line.slice(0, 400) });
    }
  }
  return { hits, skipped };
}

/** "N entries skipped (symlinks or denied)", or nothing to say. */
export function skippedNote(skipped: number): string | null {
  if (skipped <= 0) return null;
  return `${skipped} ${skipped === 1 ? 'entry' : 'entries'} skipped (symlinks or denied)`;
}

/** `src/**\/*.ts` → a regular expression over a workspace-relative path. */
export function globToRegExp(glob: string): RegExp {
  let body = '';
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i] as string;
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        body += '.*';
        i += 1;
        if (glob[i + 1] === '/') i += 1;
      } else {
        body += '[^/]*';
      }
    } else if (ch === '?') body += '[^/]';
    else if (/[.+^${}()|[\]\\]/.test(ch)) body += `\\${ch}`;
    else body += ch;
  }
  return new RegExp(`^${body}$`);
}

/* ------------------------------------------------------------------ *
 * write and edit
 * ------------------------------------------------------------------ */

export interface EditOutcome {
  before: string;
  after: string;
  replacements: number;
  created: boolean;
}

/**
 * Exact-string replacement, refused when `old` is absent or ambiguous.
 *
 * Ambiguity is a refusal rather than a first-match, because "the first one" is
 * a guess about which of two identical lines the model meant, and a guess that
 * edits a file is the expensive kind. `all: true` is how the caller says it
 * meant every one of them.
 */
export function applyEdit(
  content: string,
  input: { old: string; new: string; all?: boolean },
): { text: string; replacements: number } {
  if (input.old === '') throw new Error('refused: `old` is empty; there is nothing to find.');
  const occurrences = content.split(input.old).length - 1;
  if (occurrences === 0) {
    throw new Error(
      'refused: the text to replace is not in the file. Read it again — it has to match exactly, whitespace included.',
    );
  }
  if (occurrences > 1 && input.all !== true) {
    throw new Error(
      `refused: the text to replace appears ${occurrences} times. Give more surrounding lines so it names one place, or pass all: true.`,
    );
  }
  const text = input.all === true
    ? content.split(input.old).join(input.new)
    : content.replace(input.old, () => input.new);
  return { text, replacements: input.all === true ? occurrences : 1 };
}

/**
 * Write a file: to a temp file in the same directory, then `rename` over.
 *
 * Two reasons, and the second is the one the review cared about. A rename is
 * atomic, so a reader never sees half a file — and it never *follows* a link
 * at the destination: writing through `O_TRUNC` to a path that became a
 * symlink between the check and the open would write through it, and a rename
 * replaces the link instead.
 */
export async function writeFileCreatingParents(
  file: string,
  content: string,
  root?: string,
): Promise<boolean> {
  let existed = true;
  try {
    await lstat(file);
  } catch {
    existed = false;
  }
  await mkdir(path.dirname(file), { recursive: true });
  const temp = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${randomBytes(6).toString('hex')}.tmp`,
  );
  const handle = await openNoFollow(
    temp,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    root === undefined ? {} : { root },
  );
  try {
    await handle.writeFile(content, 'utf8');
  } finally {
    await handle.close();
  }
  try {
    await rename(temp, file);
  } catch (err) {
    await rm(temp, { force: true });
    throw err;
  }
  return !existed;
}

/**
 * A minimal unified-ish diff for the approval card.
 *
 * Line-by-line, no LCS: an approval card is a human reading "these lines go,
 * those arrive", and a real diff algorithm here would be a second thing to
 * maintain for a nicer-looking card. `git diff` is what `summarise` uses when
 * a real diff is wanted.
 */
export function shortDiff(before: string, after: string, opts: { context?: number } = {}): string {
  const a = before.split('\n');
  const b = after.split('\n');
  const limit = opts.context ?? 40;
  const out: string[] = [];
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  let j = 0;
  while (
    j < a.length - i &&
    j < b.length - i &&
    a[a.length - 1 - j] === b[b.length - 1 - j]
  ) {
    j += 1;
  }
  for (const line of a.slice(i, a.length - j)) out.push(`- ${line}`);
  for (const line of b.slice(i, b.length - j)) out.push(`+ ${line}`);
  if (out.length === 0) return '(no change)';
  if (out.length > limit) {
    return [...out.slice(0, limit), `… ${out.length - limit} more changed lines`].join('\n');
  }
  return out.join('\n');
}
