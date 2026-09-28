/**
 * What runs in `run` mode without a card: an **allowlist**, and now a
 * **grammar per program**.
 *
 * Two earlier shapes failed, and both failures are the same mistake made
 * smaller each time:
 *
 *  1. A denylist over a command string. Reviews executed `env curl`,
 *     `cat $HOME/.ssh/id_ed25519`, `echo x >>~/.zshenv`, `npx`, `node -e`.
 *     A lexical denylist over something a shell re-reads establishes nothing.
 *  2. An allowlist of *programs*, with a heuristic for "does this argument
 *     look like a path". Verification walked through it: `node
 *     --import=data:text/javascript,…`, `make -C /tmp`, `grep -f /etc/passwd`,
 *     `sort -o /tmp/out`, `find -files0-from`, `rg -L`, `grep -R`, `find -L`.
 *     Every one is a listed program reading or writing somewhere it should
 *     not, through a flag nobody enumerated. "Which program" is not the
 *     question; "which program, with which flags" is.
 *
 * So each program on the list carries a pinned grammar: the exact flags it may
 * be given, whether each takes a value and of what kind, and what its operands
 * are. A flag that is not in the table is gated, by name. Compact (`-C/tmp`),
 * joined (`--out=/tmp`) and clustered (`-rn`) forms are all parsed to the same
 * flag, so a spelling is not a bypass.
 *
 * What the grammar does **not** claim: that a listed program is safe. `npm
 * test` runs a project's own scripts, as the owner. The grammar bounds which
 * program starts and with what; §5 of the spec says the rest out loud.
 */
import path from 'node:path';

export interface PlainCommand {
  words: string[];
}

export type PlainResult = { ok: true; command: PlainCommand } | { ok: false; why: string };

/**
 * Characters a shell reads as something other than text. Any of them, quoted
 * or not, makes a command not plain.
 *
 * Quoted ones are refused too. `echo "a (b)"` is harmless and is still
 * refused, because "we can tell which quotes a shell would have honoured" is
 * exactly the reasoning that failed. Nothing is run through a shell any more,
 * so the only purpose of the rule is to keep the words the grammar inspects
 * identical to the words the program receives.
 *
 * `*` and `?` are **not** on the list, and that is deliberate: they expand in
 * a shell and there is no shell, so they reach the program as the two
 * characters they are. That is what makes `rg -g *.ts` and
 * `grep --include=*.ts` expressible at all — the glob is the program's to
 * read, not a filename this plugin has to resolve.
 */
const SPECIAL = /[$`|;&<>(){}\[\]!~\n\r\\#]/;

/**
 * Split a command into words: whitespace, with `'…'` and `"…"` holding a word
 * together. No expansion of any kind, because there is no shell.
 */
export function plainWords(command: string): PlainResult {
  const trimmed = command.trim();
  if (trimmed === '') return { ok: false, why: 'the command is empty' };
  if (trimmed.length > 4000) return { ok: false, why: 'the command is longer than 4,000 characters' };
  const special = SPECIAL.exec(trimmed);
  if (special) {
    return {
      ok: false,
      why: `it contains ${JSON.stringify(special[0])}, which a shell would read as something other than text`,
    };
  }
  const words: string[] = [];
  let current = '';
  let started = false;
  let i = 0;
  while (i < trimmed.length) {
    const ch = trimmed[i] as string;
    if (ch === "'" || ch === '"') {
      const close = trimmed.indexOf(ch, i + 1);
      if (close === -1) return { ok: false, why: 'it has an unterminated quote' };
      current += trimmed.slice(i + 1, close);
      started = true;
      i = close + 1;
      continue;
    }
    if (ch === ' ' || ch === '\t') {
      if (started) {
        words.push(current);
        current = '';
        started = false;
      }
      i += 1;
      continue;
    }
    current += ch;
    started = true;
    i += 1;
  }
  if (started) words.push(current);
  if (words.length === 0) return { ok: false, why: 'the command is empty' };
  return { ok: true, command: { words } };
}

/* ------------------------------------------------------------------ *
 * The grammar
 * ------------------------------------------------------------------ */

/**
 * What a flag takes after it.
 *
 * `path` is the one that matters: its value is collected and resolved inside
 * the workspace exactly like an operand, which is what `grep --include=`,
 * `tsc -p` and `find -newer` need and what `sort -o` would have needed had it
 * been allowed at all.
 */
export type FlagValue = 'none' | 'number' | 'word' | 'glob' | 'regex' | 'path';

/** What the words that are not flags are. */
export type OperandKind =
  /** A file or directory inside the workspace; resolved. */
  | 'path'
  /** A package pattern (`./...`), or a path; resolved when it is a path. */
  | 'package'
  /** An npm script: `[a-z0-9:_.-]+`. */
  | 'script'
  /** A make target. */
  | 'target'
  /** One free word (a search pattern, a test name), then paths. */
  | 'pattern-then-paths'
  /** A bare word, no slashes: a python module, a `which` argument. */
  | 'word'
  /** Anything at all, because the program only prints it. */
  | 'any'
  /** None allowed. */
  | 'none';

export interface Grammar {
  /** Subcommands this program may be given, and whether one is required. */
  subcommands?: { allowed: readonly string[]; required: boolean };
  /** Every flag it may be given. Anything else is gated, by name. */
  flags: Readonly<Record<string, FlagValue>>;
  operands: OperandKind;
  /** At most this many operands; undefined means no limit. */
  maxOperands?: number;
  /**
   * It needs an operand, unless this flag is there. `node` with neither is an
   * interactive process, which is not a command.
   */
  atLeastOne?: { orFlag: string; why: string };
  /**
   * Hand the rest of the words to another program's grammar — `python -m
   * pytest -q` is a pytest command wearing a python hat.
   */
  delegateAfter?: { flag: string; to: readonly string[] };
  /** A program whose arguments are an expression, not flags: `find`. */
  expression?: Readonly<Record<string, FlagValue>>;
}

const SCRIPT_NAME = /^[a-z0-9:_.-]+$/;
const TARGET_NAME = /^[A-Za-z0-9:_.-]+$/;
const BARE_WORD = /^[A-Za-z0-9:_.@-]+$/;

/**
 * The table. Adding a row, or a flag to one, is a decision about what `run`
 * mode means — so it is one place, and it is read as prose.
 */
export const RUN_LIST: ReadonlyMap<string, Grammar> = new Map<string, Grammar>([
  // Node runs a file. Not `-e`, not `--eval`, not `-p`, not `--require`, not
  // `--import` (which takes a `data:` URL and is therefore `-e` spelled
  // differently), not `--loader`.
  [
    'node',
    {
      flags: { '--test': 'none' },
      operands: 'path',
      atLeastOne: { orFlag: '--test', why: 'node with no script is an interactive process, not a command' },
    },
  ],

  // A package manager runs one of the project's own scripts, by name. No
  // flags at all: `-r`, `--filter` and `-C` all change *which* project.
  ...(['npm', 'pnpm', 'yarn', 'bun'] as const).map(
    (name): [string, Grammar] => [
      name,
      {
        subcommands: { allowed: ['run', 'test', 'build', 'lint', 'typecheck'], required: true },
        flags: {},
        operands: 'script',
        maxOperands: 1,
      },
    ],
  ),

  // Python starts one of five modules, or runs one file of the project's own
  // — `python3 scripts/build.py`, the way `node build.js` already runs. With
  // `-m` first the rest of the words are read by that module's own grammar.
  ...(['python', 'python3'] as const).map(
    (name): [string, Grammar] => [
      name,
      {
        flags: { '-m': 'word' },
        operands: 'path',
        maxOperands: 1,
        delegateAfter: { flag: '-m', to: ['pytest', 'unittest', 'mypy', 'ruff', 'black'] },
      },
    ],
  ),

  [
    'pytest',
    {
      flags: {
        '-q': 'none',
        '-x': 'none',
        '-v': 'none',
        '-k': 'word',
        '--maxfail': 'number',
        '-p': 'word',
      },
      operands: 'path',
    },
  ],
  ['unittest', { flags: {}, operands: 'word' }],

  [
    'go',
    {
      subcommands: { allowed: ['test', 'build', 'vet', 'fmt'], required: true },
      flags: { '-v': 'none', '-run': 'regex' },
      operands: 'package',
    },
  ],
  [
    'cargo',
    {
      subcommands: { allowed: ['test', 'build', 'check', 'clippy', 'fmt'], required: true },
      flags: { '-v': 'none', '--release': 'none', '-run': 'regex' },
      operands: 'word',
    },
  ],

  // Bare targets. `-C` is "go somewhere else first" and `-f` is "use another
  // makefile"; both are how a make command stops being about this project.
  ['make', { flags: {}, operands: 'target' }],

  ['tsc', { flags: { '-p': 'path', '--project': 'path', '--noEmit': 'none' }, operands: 'path' }],
  ...(['vitest', 'jest'] as const).map(
    (name): [string, Grammar] => [
      name,
      {
        subcommands: { allowed: ['run'], required: false },
        flags: { '-t': 'word' },
        operands: 'path',
      },
    ],
  ),

  ['eslint', { flags: { '--fix': 'none' }, operands: 'path' }],
  ['prettier', { flags: { '--check': 'none', '--write': 'none' }, operands: 'path' }],
  [
    'ruff',
    {
      subcommands: { allowed: ['check', 'format'], required: false },
      flags: { '--check': 'none', '--fix': 'none' },
      operands: 'path',
    },
  ],
  ['black', { flags: { '--check': 'none' }, operands: 'path' }],
  ['mypy', { flags: { '--check': 'none' }, operands: 'path' }],

  ['ls', { flags: { '-l': 'none', '-a': 'none' }, operands: 'path' }],
  ['cat', { flags: {}, operands: 'path' }],
  ['head', { flags: { '-n': 'number', '-c': 'number' }, operands: 'path' }],
  ['tail', { flags: { '-n': 'number', '-c': 'number' }, operands: 'path' }],
  ['wc', { flags: { '-l': 'none', '-c': 'none', '-w': 'none' }, operands: 'path' }],

  // `-f` reads the patterns from a file, `-R` follows symlinks, and neither
  // is on the list. `--include` is, and its value is a glob, not a path.
  [
    'grep',
    {
      flags: {
        '-n': 'none',
        '-i': 'none',
        '-r': 'none',
        '-E': 'none',
        '-F': 'none',
        '-w': 'none',
        '-c': 'none',
        '-l': 'none',
        '--include': 'glob',
      },
      operands: 'pattern-then-paths',
    },
  ],
  [
    'rg',
    {
      flags: {
        '-n': 'none',
        '-i': 'none',
        '-w': 'none',
        '-l': 'none',
        '-c': 'none',
        '--no-follow': 'none',
        '-g': 'glob',
        '-t': 'word',
      },
      operands: 'pattern-then-paths',
    },
  ],

  // `find` takes an expression, not flags, so it has a table of its own.
  // `-L`, `-H` and `-follow` follow links out; `-exec`, `-execdir`, `-ok`,
  // `-okdir` run programs; `-delete`, `-fprint*` and `-fls` write.
  [
    'find',
    {
      flags: {},
      operands: 'path',
      expression: {
        '-name': 'glob',
        '-iname': 'glob',
        '-type': 'word',
        '-maxdepth': 'number',
        '-mindepth': 'number',
        '-path': 'glob',
        '-newer': 'path',
        '-size': 'word',
        '-not': 'none',
        '-o': 'none',
        '-a': 'none',
      },
    },
  ],

  ['diff', { flags: { '-u': 'none', '-r': 'none' }, operands: 'path' }],
  // `-o` writes the sorted output somewhere, which is how `sort` becomes a
  // way to create a file outside the workspace.
  ['sort', { flags: { '-n': 'none', '-r': 'none', '-u': 'none' }, operands: 'path' }],
  ['uniq', { flags: { '-c': 'none' }, operands: 'path' }],
  ['echo', { flags: {}, operands: 'any' }],
  ['pwd', { flags: {}, operands: 'none' }],
  ['which', { flags: {}, operands: 'word', maxOperands: 1 }],
]);

/* ------------------------------------------------------------------ *
 * The decision
 * ------------------------------------------------------------------ */

export interface RunListDecision {
  /** True only when this may run with no card. */
  allowed: boolean;
  /** Why not, in one sentence, for the card and for the model. */
  reason?: string;
  /** The words, when the command was plain. */
  words?: string[];
  /** Every path the command names; the caller resolves each one. */
  pathArgs?: string[];
}

/** A path argument that is already outside, before anything is resolved. */
export function pathArgRefusal(word: string): string | undefined {
  if (word === '') return 'an empty path';
  if (path.isAbsolute(word)) return `${word} is an absolute path`;
  if (word.split('/').includes('..')) return `${word} climbs out of the workspace with ".."`;
  return undefined;
}

/** `./...`, `pkg/...` — a package pattern, which names no single file. */
export function isPackagePattern(word: string): boolean {
  return word === './...' || word.endsWith('/...');
}

/**
 * A flag's value has to *be* what the table said it was.
 *
 * Declaring `-k` a word and then accepting `../../etc/passwd` would make the
 * table a comment. A `word` names one thing and carries no path separator at
 * all. A `glob` may carry one — it filters what is already being searched and
 * cannot add a root — but may not climb with `..` or begin with `/`, which
 * are the two ways a filter tries to become a place. A `regex` may contain
 * anything: it is a pattern, never resolved as a path or handed to a
 * filesystem call. A `path` is checked by `pathArgRefusal` and then resolved
 * by the caller, and a `number` is digits.
 */
export function valueRefusal(
  spec: FlagValue,
  name: string,
  value: string,
  program: string,
): string | undefined {
  switch (spec) {
    case 'number':
      return /^\d+$/.test(value) ? undefined : `${name} takes a number on the run list for ${program}`;
    case 'word':
      if (value.includes('/') || value.split(/[\\/]/).includes('..')) {
        return `${name} takes a plain word on the run list for ${program}, not a path`;
      }
      return undefined;
    case 'glob':
      // A glob *filters* what is already being searched; it cannot add a root.
      // So `src/*.ts` is a glob and is fine, while a climb or a leading slash
      // is an attempt to name somewhere else and is not.
      if (value.startsWith('/')) {
        return `${name} takes a glob on the run list for ${program}, and a glob does not begin with /`;
      }
      if (value.split('/').includes('..')) {
        return `${name} takes a glob on the run list for ${program}, and a glob does not climb with ".."`;
      }
      return undefined;
    case 'regex':
      // A pattern, and only ever a pattern: nothing resolves it, nothing
      // opens it, and it never reaches `pathArgs`.
      return undefined;
    case 'path':
      return pathArgRefusal(value);
    case 'none':
    default:
      return undefined;
  }
}

/** One parsed argument. */
type Parsed =
  | { kind: 'flag'; name: string; value?: string }
  | { kind: 'operand'; value: string };

/**
 * Parse one word against a flag table, in every spelling a program accepts.
 *
 * `--flag`, `--flag=value`, `--flag value`, `-f`, `-fvalue`, `-f value`, and
 * `-abc` where every letter is a valueless flag. A word that matches none of
 * them is gated by name — which is the whole difference between this and the
 * heuristic it replaces.
 */
function parseArgs(
  words: readonly string[],
  flags: Readonly<Record<string, FlagValue>>,
  program: string,
): { ok: true; parsed: Parsed[] } | { ok: false; why: string } {
  const out: Parsed[] = [];
  let i = 0;
  let onlyOperands = false;
  const gate = (why: string): { ok: false; why: string } => ({ ok: false, why });

  while (i < words.length) {
    const word = words[i] as string;
    i += 1;
    if (onlyOperands || word === '-' || !word.startsWith('-')) {
      if (word === '-') return gate(`- is not on the run list for ${program}`);
      out.push({ kind: 'operand', value: word });
      continue;
    }
    if (word === '--') {
      onlyOperands = true;
      continue;
    }
    const take = (name: string, joined: string | undefined): { ok: false; why: string } | undefined => {
      const spec = flags[name];
      if (spec === undefined) return gate(`${name} is not on the run list for ${program}`);
      if (spec === 'none') {
        if (joined !== undefined) return gate(`${name} takes no value on the run list for ${program}`);
        out.push({ kind: 'flag', name });
        return undefined;
      }
      const value = joined ?? words[i];
      if (joined === undefined) i += 1;
      if (value === undefined) return gate(`${name} needs a value`);
      const wrong = valueRefusal(spec, name, value, program);
      if (wrong) return gate(wrong);
      out.push({ kind: 'flag', name, value });
      return undefined;
    };

    if (word.startsWith('--')) {
      const eq = word.indexOf('=');
      const name = eq === -1 ? word : word.slice(0, eq);
      const refusal = take(name, eq === -1 ? undefined : word.slice(eq + 1));
      if (refusal) return refusal;
      continue;
    }
    // A short flag. Exact first (`-p`), then compact (`-C/tmp`, `-n20`), then
    // a cluster of valueless letters (`-rn`, `-la`).
    if (flags[word] !== undefined) {
      const refusal = take(word, undefined);
      if (refusal) return refusal;
      continue;
    }
    const head = word.slice(0, 2);
    // `-p=value` as well as `-pvalue`: a leading `=` is punctuation, not the
    // first character of a path.
    const rest = word.slice(2).replace(/^=/, '');
    if (rest !== '' && flags[head] !== undefined && flags[head] !== 'none') {
      const refusal = take(head, rest);
      if (refusal) return refusal;
      continue;
    }
    const letters = word.slice(1).split('');
    const cluster = letters.every((letter) => flags[`-${letter}`] === 'none');
    if (cluster && letters.length > 0) {
      for (const letter of letters) out.push({ kind: 'flag', name: `-${letter}` });
      continue;
    }
    // Name the *flag*, not the whole word: `-C/tmp` is `-C` with a value, and
    // a refusal that says `-C/tmp` reads as though the spelling were the
    // problem rather than the flag.
    const looksCompact = word.length > 2 && /^[^A-Za-z0-9]/.test(word.slice(2));
    return gate(`${looksCompact ? head : word} is not on the run list for ${program}`);
  }
  return { ok: true, parsed: out };
}

/** `find`'s expression: an optional path, then the predicates in its table. */
function classifyFind(
  words: readonly string[],
  grammar: Grammar,
  pathArgs: string[],
): string | undefined {
  const expression = grammar.expression as Readonly<Record<string, FlagValue>>;
  let i = 0;
  let seenPredicate = false;
  while (i < words.length) {
    const word = words[i] as string;
    i += 1;
    if (!word.startsWith('-')) {
      if (seenPredicate) return `${word} is not on the run list for find`;
      const refusal = pathArgRefusal(word);
      if (refusal) return `${refusal}, so it is outside the workspace`;
      pathArgs.push(word);
      continue;
    }
    seenPredicate = true;
    const spec = expression[word];
    if (spec === undefined) return `${word} is not on the run list for find`;
    if (spec === 'none') continue;
    const value = words[i];
    i += 1;
    if (value === undefined) return `${word} needs a value`;
    if (spec === 'number' && !/^\d+$/.test(value)) return `${word} takes a number`;
    if (spec === 'path') {
      const refusal = pathArgRefusal(value);
      if (refusal) return `${refusal}, so it is outside the workspace`;
      pathArgs.push(value);
    }
  }
  return undefined;
}

/**
 * An operand that reads as a flag.
 *
 * `cat -- -rf` puts `-rf` past the `--`, which stops *this* parser reading it
 * as a flag — and says nothing about the program, which may well re-read it
 * as one. A file whose name begins with a dash is vanishingly rare and a
 * card costs nothing, so it asks.
 */
function looksLikeFlag(operand: string): boolean {
  return operand.startsWith('-') && operand !== '-';
}

function checkOperands(
  operands: readonly string[],
  grammar: Grammar,
  program: string,
  pathArgs: string[],
): string | undefined {
  if (grammar.maxOperands !== undefined && operands.length > grammar.maxOperands) {
    return `${program} takes at most ${grammar.maxOperands} argument${
      grammar.maxOperands === 1 ? '' : 's'
    } on the run list`;
  }
  if (grammar.operands !== 'any') {
    const dashed = operands.find(looksLikeFlag);
    if (dashed !== undefined) {
      return `${dashed} is not on the run list for ${program}: an argument that begins with a dash is read as a flag`;
    }
  }
  switch (grammar.operands) {
    case 'none':
      if (operands.length > 0) return `${program} takes no arguments on the run list`;
      return undefined;
    case 'any':
      return undefined;
    case 'script':
      for (const operand of operands) {
        if (!SCRIPT_NAME.test(operand)) return `${operand} is not a script name`;
      }
      return undefined;
    case 'target':
      for (const operand of operands) {
        if (!TARGET_NAME.test(operand)) return `${operand} is not a make target`;
      }
      return undefined;
    case 'word':
      for (const operand of operands) {
        if (!BARE_WORD.test(operand)) return `${operand} is not a plain word`;
      }
      return undefined;
    case 'package':
      for (const operand of operands) {
        const refusal = pathArgRefusal(operand);
        if (refusal) return `${refusal}, so it is outside the workspace`;
        if (!isPackagePattern(operand)) pathArgs.push(operand);
      }
      return undefined;
    case 'pattern-then-paths':
      for (const [index, operand] of operands.entries()) {
        if (index === 0) continue;
        const refusal = pathArgRefusal(operand);
        if (refusal) return `${refusal}, so it is outside the workspace`;
        pathArgs.push(operand);
      }
      return undefined;
    case 'path':
    default:
      for (const operand of operands) {
        const refusal = pathArgRefusal(operand);
        if (refusal) return `${refusal}, so it is outside the workspace`;
        pathArgs.push(operand);
      }
      return undefined;
  }
}

/** The grammar, applied to one program's own words. */
function classifyProgram(
  program: string,
  rest: readonly string[],
  pathArgs: string[],
): { ok: true } | { ok: false; why: string } {
  const grammar = RUN_LIST.get(program);
  if (!grammar) {
    return { ok: false, why: `${program} is not on the run list` };
  }

  const words = rest;

  // A delegating program is a way to *start* another one, and the rest of the
  // words belong to that one's grammar. So it is answered before this
  // program's own flags are parsed — `python3 -m pytest -q` is a pytest
  // command, and `-q` is pytest's flag, not python's.
  if (grammar.delegateAfter) {
    const { flag, to } = grammar.delegateAfter;
    const first = words[0];
    // The flag must be the *first* word, and searching for it was the bug:
    // `python evil.py -m pytest` contains `-m`, and python runs `evil.py`.
    // Anything before the flag is refused by name.
    // A program that also takes operands of its own (`python3 file.py`) falls
    // through to its grammar when the first word is not the flag — and a
    // flag *there* is still refused by name, so `python3 file.py -m pytest`
    // is `-m` outside the table, not a module.
    const delegates = first === flag || grammar.operands === 'none';
    if (first === undefined) {
      return {
        ok: false,
        why:
          `${program} is only on the run list as \`${program} ${flag}\` with one of ${to.join(', ')}` +
          (grammar.operands === 'none' ? '' : ', or with one file to run'),
      };
    }
    if (delegates && first !== flag) {
      return {
        ok: false,
        why:
          `${first} is not on the run list for ${program}: it is only on the list as ` +
          `\`${program} ${flag}\` with one of ${to.join(', ')}, and ${flag} must come first`,
      };
    }
    // Running a file, the delegate flag is not a flag at all: `python evil.py
    // -m pytest` would run evil.py, so `-m` there is refused by name.
    if (!delegates) return classifyPlain(program, { ...grammar, flags: {} }, words, pathArgs);
    const module = words[1];
    if (module === undefined) {
      return { ok: false, why: `${flag} needs a value` };
    }
    if (!to.includes(module)) {
      return { ok: false, why: `${program} ${flag} ${module} is not on the run list` };
    }
    return classifyProgram(module, words.slice(2), pathArgs);
  }

  return classifyPlain(program, grammar, words, pathArgs);
}

/** The grammar proper: flags, subcommand, operands. */
function classifyPlain(
  program: string,
  grammar: Grammar,
  words: readonly string[],
  pathArgs: string[],
): { ok: true } | { ok: false; why: string } {
  if (grammar.expression) {
    const refusal = classifyFind(words, grammar, pathArgs);
    return refusal ? { ok: false, why: refusal } : { ok: true };
  }

  // Flags first, then the subcommand: it is the first *operand*, so a flag
  // before it is named as the flag it is rather than as a missing
  // subcommand.
  const parsed = parseArgs(words, grammar.flags, program);
  if (!parsed.ok) return { ok: false, why: parsed.why };

  for (const item of parsed.parsed) {
    if (item.kind !== 'flag' || item.value === undefined) continue;
    if (grammar.flags[item.name] !== 'path') continue;
    const refusal = pathArgRefusal(item.value);
    if (refusal) return { ok: false, why: `${refusal}, so it is outside the workspace` };
    pathArgs.push(item.value);
  }

  let operands = parsed.parsed
    .filter((item): item is { kind: 'operand'; value: string } => item.kind === 'operand')
    .map((item) => item.value);

  if (grammar.subcommands) {
    const sub = operands[0];
    if (sub === undefined) {
      if (grammar.subcommands.required) {
        return { ok: false, why: `${program} needs one of ${grammar.subcommands.allowed.join(', ')}` };
      }
    } else if (grammar.subcommands.allowed.includes(sub)) {
      operands = operands.slice(1);
    } else if (grammar.subcommands.required) {
      return { ok: false, why: `${program} ${sub} is not on the run list` };
    }
  }

  if (grammar.atLeastOne && operands.length === 0) {
    const has = parsed.parsed.some(
      (item) => item.kind === 'flag' && item.name === grammar.atLeastOne?.orFlag,
    );
    if (!has) return { ok: false, why: grammar.atLeastOne.why };
  }

  const refusal = checkOperands(operands, grammar, program, pathArgs);
  return refusal ? { ok: false, why: refusal } : { ok: true };
}

/**
 * The whole question: may this command run in `run` mode with no card?
 *
 * Pure. The caller resolves `pathArgs` through `resolveInside` — the
 * filesystem half of the same rule — and gates on a refusal.
 */
export function classifyForRunList(command: string): RunListDecision {
  const parsed = plainWords(command);
  if (!parsed.ok) {
    return { allowed: false, reason: `not a plain command: ${parsed.why}` };
  }
  const words = parsed.command.words;
  const program = words[0] as string;
  // A program is a bare name on the list. A path to a program — `./x`,
  // `/usr/bin/curl`, `bin/tool` — is not on any list.
  if (program.includes('/')) {
    return {
      allowed: false,
      reason: `not a plain command: ${program} names a program by path rather than by name`,
      words,
    };
  }
  const pathArgs: string[] = [];
  const outcome = classifyProgram(program, words.slice(1), pathArgs);
  if (!outcome.ok) return { allowed: false, reason: outcome.why, words };
  return { allowed: true, words, pathArgs };
}

/* ------------------------------------------------------------------ *
 * Two allowances that need the filesystem: the pure halves
 *
 * The run list is pure and the caller (`runListFor`) owns the filesystem, so
 * each of these answers "what would have to exist for this to be allowed",
 * and the caller looks.
 * ------------------------------------------------------------------ */

/**
 * An install that only reproduces the lockfile — `npm ci`, `pnpm install
 * --frozen-lockfile`, a bare `yarn install` — fetches what the repository
 * already declares, which is what the owner did themselves when they cloned
 * it. It is allowed in `run` mode **when the lockfile is there**; the caller
 * checks. `npm install <package>` names something new and stays a card.
 *
 * Answers the lockfiles that would have to exist in the directory, or
 * `undefined` when this is not such an install.
 */
export function lockfileInstall(words: readonly string[]): { lockfiles: string[]; what: string } | undefined {
  const [program, ...rest] = words;
  if (program === undefined) return undefined;
  const flags = rest.filter((word) => word.startsWith('-'));
  const operands = rest.filter((word) => !word.startsWith('-'));
  const sub = operands[0];
  // Any operand after the subcommand is a package name: something new.
  if (operands.length > 1) return undefined;
  const only = (allowed: readonly string[]): boolean => flags.every((flag) => allowed.includes(flag));
  switch (program) {
    case 'npm':
      if (sub === 'ci' && only(['--ignore-scripts', '--no-audit', '--no-fund'])) {
        return { lockfiles: ['package-lock.json', 'npm-shrinkwrap.json'], what: 'npm ci' };
      }
      if ((sub === 'install' || sub === 'i') && only(['--no-audit', '--no-fund', '--ignore-scripts'])) {
        return { lockfiles: ['package-lock.json', 'npm-shrinkwrap.json'], what: 'npm install' };
      }
      return undefined;
    case 'pnpm':
      if ((sub === 'install' || sub === 'i') && only(['--frozen-lockfile', '--ignore-scripts', '--offline', '--prefer-offline'])) {
        return { lockfiles: ['pnpm-lock.yaml'], what: 'pnpm install' };
      }
      return undefined;
    case 'yarn':
      if ((sub === undefined || sub === 'install') && only(['--immutable', '--frozen-lockfile', '--ignore-scripts'])) {
        return { lockfiles: ['yarn.lock'], what: 'yarn install' };
      }
      return undefined;
    case 'bun':
      if ((sub === undefined || sub === 'install' || sub === 'i') && only(['--frozen-lockfile', '--ignore-scripts'])) {
        return { lockfiles: ['bun.lock', 'bun.lockb'], what: 'bun install' };
      }
      return undefined;
    default:
      return undefined;
  }
}

/**
 * `npx <bin> …` where `<bin>` is one the project already installed under
 * `node_modules/.bin` runs the project's own code, exactly as `npm run` does;
 * `npx` only fetches when the binary is missing, and the caller checks that
 * it is not. The arguments are the binary's own, bounded the one way the
 * grammar can: none may be absolute, climb with `..`, or start at `~`.
 *
 * Answers the relative path that would have to exist, or `undefined`.
 */
export function localBinary(words: readonly string[]): { relative: string; bin: string } | undefined {
  const [program, bin, ...args] = words;
  if (program !== 'npx' || bin === undefined) return undefined;
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(bin)) return undefined;
  for (const arg of args) {
    if (arg.startsWith('~') || path.isAbsolute(arg) || arg.split('/').includes('..')) return undefined;
  }
  return { relative: path.join('node_modules', '.bin', bin), bin };
}

