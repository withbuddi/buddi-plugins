/**
 * The rule-namer. **Not a boundary any more** — read `runlist.ts` first.
 *
 * This module used to decide what ran without a card, and two reviews took it
 * apart by executing the bypasses: `env curl …`, `cat $HOME/.ssh/id_ed25519`,
 * `echo x >>~/.zshenv`, `npx …`, `node -e …`, `find . -exec curl`, `git -c
 * foo=bar push`. The lesson is not "add those rows": a lexical denylist over a
 * string a shell re-interprets cannot establish that a program will not read
 * outside the workspace or use the network. So the allowlist in `runlist.ts`
 * decides, and this survives for one job:
 *
 *   **to put a name on the card.** When something is gated, "npm install
 *   installs packages this machine did not have" is a better sentence for an
 *   owner than "npm install is not on the run list", and this is where that
 *   sentence comes from.
 *
 * Nothing is *allowed* because this module did not recognise it. A rule that
 * stops matching costs a vaguer card and nothing else.
 */
import path from 'node:path';

export type GateRule =
  | 'install'
  | 'network'
  | 'outside-workspace'
  | 'elevated'
  | 'destroyer'
  | 'pipe-to-shell'
  | 'unparseable';

export interface GateDecision {
  gated: boolean;
  rule?: GateRule;
  /** One sentence, owner-facing, naming what matched. */
  reason?: string;
}

const ALLOWED: GateDecision = { gated: false };

function gate(rule: GateRule, reason: string): GateDecision {
  return { gated: true, rule, reason };
}

/* ------------------------------------------------------------------ *
 * The tokenizer
 * ------------------------------------------------------------------ */

/** One word, with whether it arrived quoted (a quoted `|` is not a pipe). */
export interface Word {
  text: string;
  quoted: boolean;
}

/** A single simple command: its words, and the operator that introduced it. */
export interface Segment {
  words: Word[];
  /** `|` when this segment is the right-hand side of a pipe. */
  pipedInto: boolean;
}

export type ParseResult =
  | { ok: true; segments: Segment[] }
  | { ok: false; why: string };

const SUBSTITUTIONS = ['$(', '`', '${', '<(', '>('];

/**
 * Split a command line into simple commands.
 *
 * Deliberately small: quotes, the operators `| || && ; & \n`, and nothing
 * else. Every construct it does not handle — a substitution, a heredoc, a
 * brace expansion, an unterminated quote — makes it give up, which is the
 * point.
 */
export function tokenize(command: string): ParseResult {
  for (const marker of SUBSTITUTIONS) {
    if (command.includes(marker)) {
      return { ok: false, why: `it contains ${marker}, a substitution this parser does not read` };
    }
  }
  if (command.includes('<<')) return { ok: false, why: 'it contains a heredoc' };

  const segments: Segment[] = [];
  let words: Word[] = [];
  let current = '';
  let currentQuoted = false;
  let started = false;
  let pipedInto = false;

  const endWord = (): void => {
    if (started) {
      words.push({ text: current, quoted: currentQuoted });
      current = '';
      currentQuoted = false;
      started = false;
    }
  };
  const endSegment = (nextPiped: boolean): void => {
    endWord();
    if (words.length > 0) segments.push({ words, pipedInto });
    words = [];
    pipedInto = nextPiped;
  };

  let i = 0;
  while (i < command.length) {
    const ch = command[i] as string;
    if (ch === '\\') {
      // An escape: take the next character literally, whatever it is.
      const next = command[i + 1];
      if (next === undefined) return { ok: false, why: 'it ends in a backslash' };
      current += next;
      started = true;
      i += 2;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const close = command.indexOf(ch, i + 1);
      if (close === -1) return { ok: false, why: 'it has an unterminated quote' };
      const inner = command.slice(i + 1, close);
      if (ch === '"') {
        for (const marker of SUBSTITUTIONS) {
          if (inner.includes(marker)) {
            return { ok: false, why: `it contains ${marker} inside double quotes` };
          }
        }
      }
      current += inner;
      currentQuoted = true;
      started = true;
      i = close + 1;
      continue;
    }
    if (ch === ' ' || ch === '\t') {
      endWord();
      i += 1;
      continue;
    }
    if (ch === '|') {
      const double = command[i + 1] === '|';
      endSegment(!double);
      i += double ? 2 : 1;
      continue;
    }
    if (ch === '&') {
      const double = command[i + 1] === '&';
      endSegment(false);
      i += double ? 2 : 1;
      continue;
    }
    if (ch === ';' || ch === '\n') {
      endSegment(false);
      i += 1;
      continue;
    }
    current += ch;
    started = true;
    i += 1;
  }
  endSegment(false);
  if (segments.length === 0) return { ok: false, why: 'it is empty' };
  return { ok: true, segments };
}

/* ------------------------------------------------------------------ *
 * The rules
 * ------------------------------------------------------------------ */

/** The base name of a command word: `/usr/bin/curl` is still `curl`. */
function commandName(word: string): string {
  const base = word.includes('/') ? (word.split('/').pop() as string) : word;
  return base.toLowerCase();
}

/** Everything after the command that is not a flag. */
function operands(words: Word[]): string[] {
  return words.slice(1).filter((w) => !w.text.startsWith('-')).map((w) => w.text);
}

function flags(words: Word[]): string[] {
  return words.slice(1).filter((w) => w.text.startsWith('-')).map((w) => w.text);
}

/** Wrappers that run another command; the rest of the words are the command. */
const WRAPPERS = new Map<string, number>([
  ['env', 0],
  ['nohup', 0],
  ['nice', 0],
  ['ionice', 0],
  ['stdbuf', 0],
  ['time', 0],
  ['timeout', 1],
  ['command', 0],
  ['builtin', 0],
  ['exec', 0],
  ['setsid', 0],
  ['watch', 0],
  ['xargs', 0],
  ['parallel', 0],
]);

/** Programs that run a program written inline. */
const INTERPRETERS = new Set(['node', 'python', 'python3', 'ruby', 'perl', 'php', 'deno', 'bun', 'osascript']);
const INLINE_FLAGS = new Set(['-e', '-E', '-p', '-c', '--eval', '--print']);

/** What a machine is made to do to itself, or to the owner's login. */
const PERSISTENCE = new Set([
  'crontab',
  'launchctl',
  'systemctl',
  'at',
  'defaults',
  'security',
  'osascript',
  'open',
  'ssh-keygen',
  'ssh-add',
  'chsh',
]);

const INSTALLERS = new Map<string, string[]>([
  ['npm', ['install', 'i', 'ci', 'add', 'update', 'link', 'exec', 'create']],
  ['npx', ['*']],
  ['bunx', ['*']],
  ['uvx', ['*']],
  ['pipx', ['run', 'install']],
  ['deno', ['install', 'cache', 'run']],
  ['pnpm', ['install', 'i', 'add', 'update', 'link', 'dlx', 'create', 'exec']],
  ['yarn', ['install', 'add', 'upgrade', 'link', 'dlx', 'create']],
  ['bun', ['install', 'add', 'link']],
  ['pip', ['install', 'uninstall']],
  ['pip3', ['install', 'uninstall']],
  ['uv', ['add', 'pip', 'sync', 'install']],
  ['poetry', ['add', 'install', 'update']],
  ['gem', ['install', 'update']],
  ['cargo', ['install', 'add']],
  ['go', ['install', 'get']],
  ['brew', ['install', 'upgrade', 'tap', 'reinstall']],
  ['apt', ['install', 'upgrade']],
  ['apt-get', ['install', 'upgrade']],
  ['composer', ['install', 'require', 'update']],
  ['gradle', ['--refresh-dependencies']],
]);

/** Commands that are a network call whatever their arguments are. */
const NETWORK = new Set([
  'curl',
  'wget',
  'ssh',
  'scp',
  'sftp',
  'rsync',
  'nc',
  'ncat',
  'netcat',
  'telnet',
  'ftp',
  'http',
  'httpie',
]);

/** `git` subcommands that reach the network or rewrite history. */
const GIT_NETWORK = new Set(['push', 'pull', 'fetch', 'clone', 'remote', 'submodule']);
const GIT_DESTROYER = new Map<string, string>([
  ['reset', '--hard'],
  ['clean', '-fd'],
  ['filter-branch', ''],
  ['rebase', ''],
]);

const ELEVATED = new Set(['sudo', 'doas', 'su', 'pkexec']);

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish']);

/** Redirection targets that are not a path into the world. */
const HARMLESS_REDIRECTS = new Set(['/dev/null', '/dev/stdout', '/dev/stderr', '/dev/tty']);

/**
 * Does this word name somewhere outside the workspace?
 *
 * Lexical on purpose — the parser is pure, and the file tools do the
 * realpath check through `resolveInside`. `~` in any form is outside, an
 * absolute path is outside unless it resolves inside the workspace, and a
 * `..` segment is outside unless it climbs back in.
 */
export function pointsOutside(word: string, workspace: string): boolean {
  if (word === '~' || word.startsWith('~/')) return true;
  if (HARMLESS_REDIRECTS.has(word)) return false;
  if (path.isAbsolute(word)) {
    const rel = path.relative(workspace, path.resolve(word));
    return rel.startsWith('..') || path.isAbsolute(rel);
  }
  if (word.split('/').includes('..')) {
    const rel = path.relative(workspace, path.resolve(workspace, word));
    return rel.startsWith('..') || path.isAbsolute(rel);
  }
  return false;
}

/** The part of `--out=/etc/x` that is a path. */
function pathish(word: string): string {
  const eq = word.indexOf('=');
  if (word.startsWith('-') && eq !== -1) return word.slice(eq + 1);
  if (word.startsWith('-')) return '';
  return word;
}

/**
 * The subcommand of a `git` invocation, skipping the global options and their
 * values.
 *
 * `git -c http.proxy=x push` used to read as `git http.proxy=x`, because the
 * flag's value looked like the first operand. The options that take a value
 * are the ones listed here; everything else that starts with `-` is a flag of
 * its own.
 */
const GIT_GLOBAL_WITH_VALUE = new Set(['-c', '-C', '--exec-path', '--git-dir', '--work-tree', '--namespace']);

export function gitSubcommand(words: readonly Word[]): string | undefined {
  let i = 1;
  while (i < words.length) {
    const word = (words[i] as Word).text;
    if (!word.startsWith('-')) return word;
    if (GIT_GLOBAL_WITH_VALUE.has(word)) i += 2;
    else i += 1;
  }
  return undefined;
}

function destroyerIn(words: Word[], workspace: string): GateDecision | undefined {
  const name = commandName(words[0]?.text ?? '');
  const args = operands(words);
  const allFlags = flags(words).join(' ');

  if (name === 'rm') {
    const recursive = /r/i.test(allFlags.replace(/--\w+/g, '')) || allFlags.includes('--recursive');
    const force = allFlags.includes('f') || allFlags.includes('--force');
    if (recursive || force) {
      for (const target of args) {
        const t = target.replace(/\/+$/, '');
        if (
          t === '' ||
          t === '.' ||
          t === '/' ||
          t === '*' ||
          t === '~' ||
          t.startsWith('~/') ||
          t.startsWith('..') ||
          path.isAbsolute(t)
        ) {
          return gate(
            'destroyer',
            `\`rm\` with ${allFlags} over ${target}: that is the workspace root or above it.`,
          );
        }
      }
    }
  }
  if (name === 'mkfs' || name.startsWith('mkfs.')) {
    return gate('destroyer', '`mkfs` formats a filesystem.');
  }
  if (name === 'dd') {
    if (words.slice(1).some((w) => w.text.startsWith('of='))) {
      return gate('destroyer', '`dd` with `of=` writes over whatever that names.');
    }
  }
  if (name === 'shutdown' || name === 'reboot' || name === 'halt') {
    return gate('destroyer', `\`${name}\` stops the machine buddi runs on.`);
  }
  if (name === 'chmod' || name === 'chown') {
    if (args.some((a) => pointsOutside(a, workspace))) {
      return gate('destroyer', `\`${name}\` over a path outside the workspace.`);
    }
  }
  if (name === 'git') {
    const sub = gitSubcommand(words);
    if (sub !== undefined && GIT_DESTROYER.has(sub)) {
      const needle = GIT_DESTROYER.get(sub) as string;
      const rest = words.slice(1).map((w) => w.text).join(' ');
      if (needle === '' || rest.includes(needle) || (sub === 'clean' && /-[a-z]*f[a-z]*d/.test(rest))) {
        return gate('destroyer', `\`git ${sub}\` throws work away that nothing else keeps.`);
      }
    }
  }
  return undefined;
}

export interface ClassifyOptions {
  /** The workspace root, for the "a path outside it" rule. Absolute. */
  workspace: string;
}

/**
 * The whole decision for one command line: gated, or not, and why.
 *
 * `gated: false` means "no rule in §5 matched"; the *mode* is what decides
 * whether that runs without a card, and that is `tierForCommand` in
 * `modes.ts`, not this.
 */
export function classifyCommand(command: string, opts: ClassifyOptions): GateDecision {
  const trimmed = command.trim();
  if (trimmed === '') return gate('unparseable', 'the command is empty.');
  const parsed = tokenize(trimmed);
  if (!parsed.ok) {
    return gate('unparseable', `this command could not be read safely: ${parsed.why}.`);
  }
  const workspace = path.resolve(opts.workspace);

  for (const segment of parsed.segments) {
    let words = segment.words;
    // `FOO=bar cmd …`: leading assignments are not the command.
    while (words.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]?.text ?? '')) {
      words = words.slice(1);
    }
    if (words.length === 0) continue;
    // A wrapper is not the command: `env curl …` is curl, and naming `env` on
    // the card would be naming the wrong thing.
    let name = commandName(words[0]?.text ?? '');
    let guard = 0;
    while (WRAPPERS.has(name) && guard < 5) {
      if (ELEVATED.has(name)) break;
      const skip = WRAPPERS.get(name) as number;
      words = words.slice(1 + skip).filter((word) => !word.text.startsWith('-'));
      if (words.length === 0) break;
      name = commandName(words[0]?.text ?? '');
      guard += 1;
    }
    if (words.length === 0) continue;

    if (INTERPRETERS.has(name) && words.slice(1).some((word) => INLINE_FLAGS.has(word.text))) {
      return gate('elevated', `\`${name}\` with an inline program runs code nobody read.`);
    }
    if (PERSISTENCE.has(name)) {
      return gate('destroyer', `\`${name}\` changes what this machine does when nobody is looking.`);
    }
    if (ELEVATED.has(name)) {
      return gate('elevated', `\`${name}\` runs with rights beyond the owner's own user.`);
    }
    if (segment.pipedInto && SHELLS.has(name)) {
      return gate('pipe-to-shell', `output is piped into \`${name}\`, which runs whatever it receives.`);
    }
    if (SHELLS.has(name) && words.some((w) => w.text === '-c')) {
      return gate('pipe-to-shell', `\`${name} -c\` runs a command this parser never saw.`);
    }
    if (NETWORK.has(name)) {
      return gate('network', `\`${name}\` reaches the network.`);
    }
    const args = operands(words);
    const sub = name === 'git' ? gitSubcommand(words) : args[0];
    if (name === 'git' && sub !== undefined && GIT_NETWORK.has(sub)) {
      return gate('network', `\`git ${sub}\` talks to a remote.`);
    }
    if ((name === 'npm' || name === 'pnpm' || name === 'yarn' || name === 'bun') && sub === 'publish') {
      return gate('network', `\`${name} publish\` sends this package to a registry.`);
    }
    if ((name === 'npm' || name === 'pnpm' || name === 'yarn') && (sub === 'login' || sub === 'adduser' || sub === 'token')) {
      return gate('network', `\`${name} ${sub}\` authenticates against a registry.`);
    }
    if (name === 'docker' && (sub === 'push' || sub === 'pull' || sub === 'login')) {
      return gate('network', `\`docker ${sub}\` talks to a registry.`);
    }
    const installerSubs = INSTALLERS.get(name);
    if (installerSubs) {
      const hit =
        installerSubs.includes('*') ||
        (sub !== undefined && installerSubs.includes(sub)) ||
        words.slice(1).some((w) => installerSubs.includes(w.text));
      // A bare `npm`/`pnpm`/`yarn` with no subcommand installs, historically.
      const bare = (name === 'yarn' || name === 'pnpm') && args.length === 0;
      if (hit || bare) {
        return gate('install', `\`${name}${sub ? ` ${sub}` : ''}\` installs packages this machine did not have.`);
      }
    }

    const destroyer = destroyerIn(words, workspace);
    if (destroyer) return destroyer;

    for (const word of words.slice(1)) {
      // A quoted word can still be a path, but a quoted `../..` in a grep
      // pattern is a pattern. Being conservative costs a card, so quoted or
      // not, a word that reads as a path outside is one.
      const candidate = pathish(word.text);
      if (candidate === '') continue;
      if (pointsOutside(candidate, workspace)) {
        return gate(
          'outside-workspace',
          `the argument ${word.text} names ${candidate}, which is outside the workspace.`,
        );
      }
    }
  }
  return ALLOWED;
}
