/**
 * Which loopback port a started process listens on (§12).
 *
 * Three sources, in the order the preview trusts them:
 *
 *  1. an explicit `port` on `developer.start` — the agent knows;
 *  2. the command itself — `--port 5173`, `PORT=3000 npm run dev`;
 *  3. the process's own first lines — "Local: http://localhost:5173/".
 *
 * All three are pure string work, which is what makes them testable without a
 * dev server; the impure part (reading the log file for a while after start)
 * lives in `processes.ts` and calls (3).
 */

/** A TCP port a thing may actually listen on. */
export function isPort(value: number): boolean {
  return Number.isInteger(value) && value > 0 && value < 65536;
}

/**
 * The port a command line asks for, or undefined.
 *
 * Ordered so the most explicit wins: a `PORT=` assignment, then `--port`, then
 * `-p`. `-p` is last because it means "publish" to docker and "port" to almost
 * everything else, and a wrong guess here only means the preview points
 * somewhere useless.
 */
export function portFromCommand(command: string): number | undefined {
  const patterns = [
    /(?:^|\s)(?:PORT|VITE_PORT|SERVER_PORT)=(\d{1,5})(?:\s|$)/,
    /--port[=\s]+(\d{1,5})(?:\s|$)/,
    /--port\s+(\d{1,5})(?:\s|$)/,
    /(?:^|\s)-p[=\s]+(\d{1,5})(?:\s|$)/,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(command);
    const port = match?.[1] === undefined ? Number.NaN : Number(match[1]);
    if (isPort(port)) return port;
  }
  return undefined;
}

/**
 * The port a process announced in its output, or undefined.
 *
 * Only loopback: a line about `0.0.0.0` or a public host is a server saying it
 * listens somewhere this plugin has no business proxying, and §12 is explicit
 * that a preview is a reverse proxy to a *loopback* port.
 */
export function portFromOutput(text: string): number | undefined {
  const urls = /https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0):(\d{1,5})/g;
  for (const match of text.matchAll(urls)) {
    const port = Number(match[2]);
    if (isPort(port)) return port;
  }
  const listening = /(?:listening|running|ready|started)[^\n]*?\bport\b\D{0,4}(\d{2,5})/i.exec(text);
  if (listening?.[1] !== undefined) {
    const port = Number(listening[1]);
    if (isPort(port)) return port;
  }
  return undefined;
}

/** The three sources, in order, as one call. */
export function detectPort(input: {
  explicit?: number | undefined;
  command: string;
  output?: string;
}): number | undefined {
  if (input.explicit !== undefined && isPort(input.explicit)) return input.explicit;
  const fromCommand = portFromCommand(input.command);
  if (fromCommand !== undefined) return fromCommand;
  if (input.output !== undefined) return portFromOutput(input.output);
  return undefined;
}

/**
 * Does the server this command starts reload the page by itself after a
 * change — a dev server with hot reload, which the preview proxy carries over
 * its websocket?
 *
 * The canvas reloads a preview after a write only when the answer is no: a
 * static server (`python -m http.server`, `npx serve`) never tells the page a
 * file changed, and a second reload on top of Vite's own is a flicker and a
 * lost state for nothing. Read from the command, and through a package
 * script when the command is `npm run dev` or its cousins, since that is where
 * the real program is named. Pure string work; `scripts` is the project's
 * `package.json` scripts, or empty.
 *
 * An unknown server is taken to be static: a reload too many is a flicker, a
 * reload too few is an owner looking at a page that is not what was written.
 */
const SELF_RELOADING =
  /(?:^|[\s/])(vite|next|nuxt|nuxi|astro|remix|webpack(?:-dev-server)?|react-scripts|parcel|gatsby|svelte-kit|vue-cli-service|ng|live-server|browser-sync|eleventy|hugo|jekyll)(?:\s|$)/;

export function reloadsItself(command: string, scripts: Record<string, string> = {}): boolean {
  if (SELF_RELOADING.test(command)) return true;
  const words = command.trim().split(/\s+/);
  const [runner, first, second] = words;
  if (runner === undefined || !['npm', 'pnpm', 'yarn', 'bun'].includes(runner)) return false;
  // `npm run dev`, `pnpm dev`, `yarn dev`, `npm start`.
  const script = first === 'run' || first === 'run-script' ? second : first;
  if (script === undefined) return false;
  const body = scripts[script];
  return typeof body === 'string' && SELF_RELOADING.test(body);
}
