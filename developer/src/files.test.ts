/**
 * The file helpers: the edit rule, the read bounds, the ignore parser and the
 * diff the approval card is made of. No database, no registry — every
 * judgement in here is a function of its arguments.
 */
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  applyEdit,
  hashContent,
  readTextNoFollow,
  globToRegExp,
  ignores,
  listTree,
  looksBinary,
  parseGitignore,
  readBounded,
  renderHits,
  searchFallback,
  shortDiff,
  skippedNote,
  writeFileCreatingParents,
} from './files.js';

describe('applyEdit', () => {
  const content = 'const a = 1;\nconst b = 2;\nconst a = 1;\n';

  it('replaces one exact occurrence', () => {
    expect(applyEdit('hello world', { old: 'world', new: 'there' })).toEqual({
      text: 'hello there',
      replacements: 1,
    });
  });

  it('refuses text that is not there, and says why', () => {
    expect(() => applyEdit(content, { old: 'const c = 3;', new: '' })).toThrow(
      /not in the file.*exactly/s,
    );
  });

  it('refuses an ambiguous match rather than guessing which one', () => {
    expect(() => applyEdit(content, { old: 'const a = 1;', new: 'const a = 9;' })).toThrow(
      /appears 2 times/,
    );
  });

  it('replaces every occurrence when the caller says so', () => {
    const result = applyEdit(content, { old: 'const a = 1;', new: 'const a = 9;', all: true });
    expect(result.replacements).toBe(2);
    expect(result.text).toBe('const a = 9;\nconst b = 2;\nconst a = 9;\n');
  });

  it('refuses an empty needle', () => {
    expect(() => applyEdit(content, { old: '', new: 'x' })).toThrow(/empty/);
  });

  it('never re-reads the replacement as a pattern', () => {
    // `$&` is a replacement pattern to `String.replace`. It must arrive as
    // two characters, not as the matched text.
    expect(applyEdit('a', { old: 'a', new: '$&$&' }).text).toBe('$&$&');
  });
});

describe('shortDiff', () => {
  it('shows what goes and what arrives', () => {
    expect(shortDiff('a\nb\nc\n', 'a\nB\nc\n')).toBe('- b\n+ B');
  });

  it('says so when nothing changed', () => {
    expect(shortDiff('a\n', 'a\n')).toBe('(no change)');
  });

  it('bounds itself, because a card is something a person reads', () => {
    const before = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n');
    const diff = shortDiff(before, '');
    expect(diff.split('\n').length).toBeLessThanOrEqual(41);
    expect(diff).toContain('more changed lines');
  });
});

describe('the .gitignore parser', () => {
  const rules = parseGitignore(['# a comment', 'dist/', '*.log', '/only-at-root', '!keep.log'].join('\n'));

  it('ignores a directory pattern only for directories', () => {
    expect(ignores(rules, 'dist', true)).toBe(true);
    expect(ignores(rules, 'dist', false)).toBe(false);
  });

  it('matches a glob at any depth', () => {
    expect(ignores(rules, 'src/deep/x.log', false)).toBe(true);
  });

  it('anchors a leading slash', () => {
    expect(ignores(rules, 'only-at-root', false)).toBe(true);
    expect(ignores(rules, 'src/only-at-root', false)).toBe(false);
  });

  it('lets a later negation win', () => {
    expect(ignores(rules, 'keep.log', false)).toBe(false);
  });
});

describe('globToRegExp', () => {
  it('spans directories on ** and stops at one on *', () => {
    expect(globToRegExp('src/**/*.ts').test('src/a/b/c.ts')).toBe(true);
    expect(globToRegExp('src/*.ts').test('src/a/b.ts')).toBe(false);
    expect(globToRegExp('src/*.ts').test('src/b.ts')).toBe(true);
  });
});

describe('the disk-backed helpers', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'buddi-developer-files-'));
    await mkdir(path.join(dir, 'src'), { recursive: true });
    await mkdir(path.join(dir, 'node_modules', 'left'), { recursive: true });
    await mkdir(path.join(dir, 'dist'), { recursive: true });
    await writeFile(path.join(dir, '.gitignore'), 'dist/\n');
    await writeFile(path.join(dir, 'src', 'a.ts'), 'const a = 1;\nconst b = 2;\n');
    await writeFile(path.join(dir, 'dist', 'a.js'), 'var a = 1;\n');
    await writeFile(path.join(dir, 'node_modules', 'left', 'index.js'), 'module.exports = 1;\n');
    await writeFile(path.join(dir, 'binary.bin'), Buffer.from([0x00, 0x01, 0x02, 0x00]));
    await writeFile(
      path.join(dir, 'long.txt'),
      Array.from({ length: 5_000 }, (_, i) => `line ${i + 1}`).join('\n'),
    );
  });

  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('numbers the lines it read and says where it stopped', async () => {
    const result = await readBounded(path.join(dir, 'src', 'a.ts'));
    expect(result.text).toBe('1\tconst a = 1;\n2\tconst b = 2;');
    expect(result.totalLines).toBe(2);
    expect(result.truncated).toBe(false);
  });

  it('reads a window of a long file', async () => {
    const result = await readBounded(path.join(dir, 'long.txt'), { from: 10, lines: 3 });
    expect(result.text).toBe('10\tline 10\n11\tline 11\n12\tline 12');
    expect(result.firstLine).toBe(10);
    expect(result.lastLine).toBe(12);
    expect(result.truncated).toBe(true);
  });

  it('stops at 2,000 lines', async () => {
    const result = await readBounded(path.join(dir, 'long.txt'));
    expect(result.lastLine).toBe(2_000);
    expect(result.truncated).toBe(true);
  });

  it('refuses a binary file with its size', async () => {
    expect(await looksBinary(path.join(dir, 'binary.bin'))).toBe(true);
    await expect(readBounded(path.join(dir, 'binary.bin'))).rejects.toThrow(/binary file of 4 bytes/);
  });

  /**
   * The failure the owner hit: one symbolic link in a real workspace — a
   * dotfile in a bootstrap repository — and the whole listing came back as an
   * error. A tree with a link in it is an ordinary tree, and the answer is
   * the rest of it plus a count.
   */
  it('lists a tree that contains links, and says how many it stepped over', async () => {
    const tree = path.join(dir, 'linky');
    const outside = path.join(dir, 'outside-target');
    await mkdir(path.join(tree, 'real'), { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(tree, 'real', 'a.ts'), 'const needle = 1;\n');
    await writeFile(path.join(outside, 'secret.txt'), 'needle\n');
    await symlink(path.join(outside, 'secret.txt'), path.join(tree, 'zprofile'));
    await symlink(outside, path.join(tree, 'linkdir'));

    const listed = await listTree(tree, tree, { depth: 4 });
    expect(listed.entries.map((entry) => entry.path)).toEqual(['real', 'real/a.ts']);
    expect(listed.skipped).toBe(2);
    expect(skippedNote(listed.skipped)).toBe('2 entries skipped (symlinks or denied)');

    const found = await searchFallback(tree, { query: 'needle' });
    expect(found.hits.map((hit) => hit.path)).toEqual(['real/a.ts']);
    expect(found.skipped).toBe(2);
  });

  it('says nothing when it stepped over nothing', async () => {
    expect(skippedNote(0)).toBeNull();
    expect(skippedNote(1)).toBe('1 entry skipped (symlinks or denied)');
  });

  it('never lists a symlink, because nothing can open one', async () => {
    await symlink(path.join(dir, 'src', 'a.ts'), path.join(dir, 'src', 'alias.ts'));
    const { entries } = await listTree(dir, dir, { depth: 4 });
    expect(entries.map((entry) => entry.path)).not.toContain('src/alias.ts');
  });

  it('prunes a denied directory that lies inside the workspace, and counts it', async () => {
    await mkdir(path.join(dir, 'secrets'), { recursive: true });
    await writeFile(path.join(dir, 'secrets', 'key'), 'k');
    const listed = await listTree(dir, dir, { depth: 4, deny: [path.join(dir, 'secrets')] });
    expect(listed.entries.map((entry) => entry.path)).not.toContain('secrets');
    expect(listed.skipped).toBeGreaterThan(0);
  });

  it('leaves out node_modules and what .gitignore ignores', async () => {
    const { entries } = await listTree(dir, dir, { depth: 4 });
    const paths = entries.map((entry) => entry.path);
    expect(paths).toContain('src/a.ts');
    expect(paths.some((p) => p.startsWith('node_modules'))).toBe(false);
    expect(paths.some((p) => p.startsWith('dist'))).toBe(false);
  });

  it('honours git ls-files when it is given one', async () => {
    const { entries } = await listTree(dir, dir, { depth: 4, tracked: new Set(['src/a.ts']) });
    expect(entries.map((entry) => entry.path)).toEqual(['src', 'src/a.ts']);
  });

  it('searches, and says path:line: text', async () => {
    const { hits } = await searchFallback(dir, { query: 'const b' });
    expect(renderHits(hits)).toBe('src/a.ts:2: const b = 2;');
  });

  it('creates parents on the way to a new file', async () => {
    const file = path.join(dir, 'a', 'b', 'c.txt');
    expect(await writeFileCreatingParents(file, 'hi')).toBe(true);
    expect(await writeFileCreatingParents(file, 'again')).toBe(false);
  });
});

describe('reading and writing through a link', () => {
  let dir: string;
  let outside: string;

  beforeAll(async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'buddi-developer-nofollow-'));
    dir = path.join(root, 'workspace');
    outside = path.join(root, 'outside.txt');
    await mkdir(dir, { recursive: true });
    await writeFile(outside, 'secret\n');
    await symlink(outside, path.join(dir, 'link.txt'));
  });

  afterAll(async () => {
    if (dir) await rm(path.dirname(dir), { recursive: true, force: true });
  });

  /**
   * `resolveInside` refuses a link it can see. This is the other half: the
   * link that appears *after* the check, which only the open can refuse.
   */
  it('refuses to read through a link, whatever the caller already checked', async () => {
    await expect(readTextNoFollow(path.join(dir, 'link.txt'))).rejects.toThrow(/symbolic link/);
  });

  it('writes over a link instead of through it', async () => {
    await writeFileCreatingParents(path.join(dir, 'link.txt'), 'mine\n');
    // The file outside is untouched, and the link is gone: the rename
    // replaced it rather than following it.
    expect(await readFile(outside, 'utf8')).toBe('secret\n');
    expect(await readFile(path.join(dir, 'link.txt'), 'utf8')).toBe('mine\n');
  });

  /**
   * `O_NOFOLLOW` closes the last component. This is the other half: a
   * *directory* above it swapped for a link between the walk and the open.
   * The re-walk after the open is what refuses it — and it is checked with a
   * link that is already in place, because a test that tried to win a real
   * race would be a test that passed by luck.
   */
  it('refuses when a directory above the file became a link', async () => {
    const root = path.dirname(dir);
    const real = path.join(dir, 'pkg');
    const elsewhere = path.join(root, 'elsewhere');
    await mkdir(real, { recursive: true });
    await mkdir(elsewhere, { recursive: true });
    await writeFile(path.join(real, 'a.ts'), 'mine\n');
    await writeFile(path.join(elsewhere, 'a.ts'), 'theirs\n');
    // The check happened against the real directory; by the time the file is
    // opened, `pkg` is a link somewhere else.
    await rm(real, { recursive: true, force: true });
    await symlink(elsewhere, real);
    await expect(readTextNoFollow(path.join(real, 'a.ts'), dir)).rejects.toThrow(
      /became a symbolic link/,
    );
    // Without the root there is nothing to re-walk, and the read succeeds —
    // which is exactly why every caller passes one.
    expect(await readTextNoFollow(path.join(real, 'a.ts'))).toBe('theirs\n');
    await rm(real, { force: true });
  });

  it('leaves no temp file behind', async () => {
    await writeFileCreatingParents(path.join(dir, 'ordinary.txt'), 'x');
    const { readdir } = await import('node:fs/promises');
    const names = await readdir(dir);
    expect(names.filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });
});

describe('hashContent', () => {
  it('is the identity of what a diff was computed against', () => {
    expect(hashContent('a')).toBe(hashContent('a'));
    expect(hashContent('a')).not.toBe(hashContent('b'));
    expect(hashContent('')).toHaveLength(32);
  });
});
