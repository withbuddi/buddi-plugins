/**
 * A picture of a page the agent's own server serves.
 *
 * §1: the developer agent has no browser, and this does not give it one. It
 * is one throwaway headless Chromium, opened for one page on a loopback port
 * the agent's own process tree holds, closed the moment the PNG exists. No
 * profile, no cookies carried over, no service workers, and no host but the
 * target: every request the page makes elsewhere is aborted by route
 * interception, and every hostname fails to resolve.
 *
 * **Which Chromium.** The one buddi's browser plugin already uses: Playwright's
 * own download in its cache (`~/Library/Caches/ms-playwright` on a Mac,
 * `PLAYWRIGHT_BROWSERS_PATH` when set), found by the same Playwright version
 * buddi pins, so the revision matches and nothing is downloaded twice.
 * `BUDDI_BROWSER_CHANNEL=chrome` means the installed Google Chrome, as it does
 * there. A missing binary is a refusal that names the command installing it.
 */
import { createRequire } from 'node:module';
import { connect } from 'node:net';
import { chromium, type Browser } from 'playwright-core';

export const SCREENSHOT_DEFAULT_WIDTH = 1280;
export const SCREENSHOT_DEFAULT_HEIGHT = 800;
export const SCREENSHOT_MIN_WIDTH = 320;
export const SCREENSHOT_MAX_WIDTH = 2560;
export const SCREENSHOT_MIN_HEIGHT = 240;
export const SCREENSHOT_MAX_HEIGHT = 1600;
/** A full page is clipped here: a feed that scrolls for ever is not a picture. */
export const SCREENSHOT_MAX_FULL_HEIGHT = 8000;
/** How long the page has to load before the shot is taken anyway. */
export const SCREENSHOT_LOAD_MS = 10_000;

const PLAYWRIGHT_VERSION: string = (() => {
  try {
    const require = createRequire(import.meta.url);
    return (require('playwright-core/package.json') as { version: string }).version;
  } catch {
    return '1.63.0';
  }
})();

/** The one command that installs the Chromium this tool looks for. */
export const CHROMIUM_INSTALL_COMMAND = `npx playwright@${PLAYWRIGHT_VERSION} install chromium`;

/**
 * A URL path on the agent's own server, or a sentence saying why not.
 *
 * Only a path: it starts with one `/`, carries no scheme, no host, no
 * backslash and no whitespace, and joined to the loopback origin it stays on
 * that origin. `//evil.example/` and `http://…` are refused, not repaired.
 */
export function screenshotPath(raw: string | undefined): { path: string } | { refusal: string } {
  const value = raw ?? '/';
  const refuse = {
    refusal:
      `refused: "${value.slice(0, 80)}" is not a path. Give a path on your own server, such as ` +
      '"/" or "/settings?tab=2"; this tool takes no URL and no host.',
  };
  if (value.length > 2048) return refuse;
  if (!value.startsWith('/') || value.startsWith('//')) return refuse;
  if (/[\\\s\u0000-\u001f\u007f]/.test(value)) return refuse;
  const base = 'http://127.0.0.1:1';
  let joined: URL;
  try {
    joined = new URL(value, base);
  } catch {
    return refuse;
  }
  if (joined.origin !== new URL(base).origin) return refuse;
  return { path: `${joined.pathname}${joined.search}${joined.hash}` };
}

/** Width and height, defaulted and held inside the caps. */
export function screenshotViewport(width?: number, height?: number): { width: number; height: number } {
  const clamp = (value: number, min: number, max: number): number =>
    Math.min(max, Math.max(min, Math.round(value)));
  return {
    width: clamp(width ?? SCREENSHOT_DEFAULT_WIDTH, SCREENSHOT_MIN_WIDTH, SCREENSHOT_MAX_WIDTH),
    height: clamp(height ?? SCREENSHOT_DEFAULT_HEIGHT, SCREENSHOT_MIN_HEIGHT, SCREENSHOT_MAX_HEIGHT),
  };
}

/**
 * Which loopback address the server is on: 127.0.0.1, else ::1, as the
 * gateway's preview proxy decides it (Vite on a Mac binds `localhost`, which
 * is ::1 alone). Both are this machine; neither is a host the agent named.
 */
export async function loopbackFor(port: number): Promise<'127.0.0.1' | '[::1]'> {
  for (const host of ['127.0.0.1', '::1'] as const) {
    const open = await new Promise<boolean>((resolve) => {
      const probe = connect({ port, host });
      const finish = (value: boolean): void => {
        probe.destroy();
        resolve(value);
      };
      probe.setTimeout(250, () => finish(false));
      probe.once('connect', () => finish(true));
      probe.once('error', () => finish(false));
    });
    if (open) return host === '::1' ? '[::1]' : host;
  }
  return '127.0.0.1';
}

export interface ShotInput {
  port: number;
  path: string;
  width: number;
  height: number;
  fullPage: boolean;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
}

export interface Shot {
  png: Buffer;
  url: string;
  /** The HTTP status of the page itself, or null when none came back. */
  status: number | null;
  /** False when the 10 s ran out and the shot was taken of what was there. */
  loaded: boolean;
  /** Requests the page made to anywhere else, aborted. */
  blocked: number;
  /** The image's own height: the viewport's, or the page's for a full page. */
  imageHeight: number;
}

function missingBinary(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /Executable doesn't exist|browserType\.launch: .*not found|Chromium distribution .* is not found/i.test(
    message,
  );
}

/** Launch, or a refusal that says how to install what is missing. */
export async function launchThrowaway(env: NodeJS.ProcessEnv = process.env): Promise<Browser> {
  try {
    return await chromium.launch({
      headless: true,
      ...(env.BUDDI_BROWSER_CHANNEL === 'chrome' ? { channel: 'chrome' } : {}),
      chromiumSandbox: true,
      timeout: 15_000,
      args: [
        // Every name fails to resolve but the two loopback literals.
        '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE ::1',
        '--disable-quic',
        '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
        '--disable-background-networking',
        '--disable-component-update',
        '--disable-sync',
        '--no-first-run',
        '--no-default-browser-check',
      ],
    });
  } catch (error) {
    if (missingBinary(error)) {
      throw new Error(
        'refused: there is no Chromium for screenshots on this machine. The owner installs it once ' +
          `with \`${CHROMIUM_INSTALL_COMMAND}\` (the same download buddi's browser uses); do not ` +
          'install a browser into the project for this.',
      );
    }
    throw new Error(
      `the screenshot browser did not start: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`,
    );
  }
}

/** Is Chromium there to launch? For a test deciding whether to skip. */
export async function chromiumAvailable(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  try {
    const browser = await launchThrowaway(env);
    await browser.close();
    return true;
  } catch {
    return false;
  }
}

/**
 * Open the page in a fresh context, wait up to 10 s for it to load, take the
 * shot, close everything. Nothing survives the call.
 */
export async function takeScreenshot(input: ShotInput): Promise<Shot> {
  input.signal?.throwIfAborted();
  const host = await loopbackFor(input.port);
  const origin = `http://${host}:${input.port}`;
  const url = `${origin}${input.path}`;
  const browser = await launchThrowaway(input.env);
  const onAbort = (): void => {
    void browser.close().catch(() => {});
  };
  input.signal?.addEventListener('abort', onAbort, { once: true });
  let blocked = 0;
  try {
    const context = await browser.newContext({
      viewport: { width: input.width, height: input.height },
      serviceWorkers: 'block',
      acceptDownloads: false,
      javaScriptEnabled: true,
      permissions: [],
    });
    const sameOrigin = (raw: string): boolean => {
      try {
        return new URL(raw).origin === origin;
      } catch {
        return false;
      }
    };
    await context.route('**/*', async (route) => {
      if (sameOrigin(route.request().url())) {
        await route.continue().catch(() => {});
      } else {
        blocked += 1;
        await route.abort('blockedbyclient').catch(() => {});
      }
    });
    await context.routeWebSocket(/.*/, (ws) => {
      const target = new URL(ws.url());
      const sameHost = target.host === new URL(origin).host;
      if (sameHost && (target.protocol === 'ws:' || target.protocol === 'wss:')) {
        ws.connectToServer();
      } else {
        blocked += 1;
        void ws.close().catch(() => {});
      }
    });
    const page = await context.newPage();
    page.on('dialog', (dialog) => {
      void dialog.dismiss().catch(() => {});
    });
    // A page that opens another window gets it closed at once.
    context.on('page', (other) => {
      if (other !== page) void other.close().catch(() => {});
    });
    let status: number | null = null;
    let loaded = true;
    try {
      const response = await page.goto(url, { waitUntil: 'load', timeout: SCREENSHOT_LOAD_MS });
      status = response?.status() ?? null;
      // A short settle for a page that renders after load; never required.
      await page.waitForLoadState('networkidle', { timeout: 1_500 }).catch(() => {});
    } catch (error) {
      input.signal?.throwIfAborted();
      const message = error instanceof Error ? error.message : String(error);
      if (!/Timeout/i.test(message)) {
        throw new Error(
          `refused: nothing answered at ${input.path} on port ${input.port}: ${message.split('\n')[0]}`,
        );
      }
      loaded = false;
    }
    let imageHeight = input.height;
    let clip: { x: number; y: number; width: number; height: number } | undefined;
    if (input.fullPage) {
      const full = await page
        .evaluate(
          // A string, so this file needs no DOM types: it runs in the page.
          'Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0)',
        )
        .then((value) => (typeof value === 'number' ? value : input.height))
        .catch(() => input.height);
      imageHeight = Math.min(Math.max(full, input.height), SCREENSHOT_MAX_FULL_HEIGHT);
      clip = { x: 0, y: 0, width: input.width, height: imageHeight };
    }
    const png = await page.screenshot({
      type: 'png',
      fullPage: input.fullPage,
      ...(clip ? { clip } : {}),
      timeout: SCREENSHOT_LOAD_MS,
      animations: 'disabled',
    });
    return { png, url, status, loaded, blocked, imageHeight };
  } finally {
    input.signal?.removeEventListener('abort', onAbort);
    await browser.close().catch(() => {});
  }
}
