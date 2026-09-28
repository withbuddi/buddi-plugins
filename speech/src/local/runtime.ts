/**
 * Transformers.js (ONNX Runtime on the CPU, prebuilt binaries only), pointed
 * at the plugin's directory and never at the network: buddi fetched and
 * verified the files itself (`install.ts`), so the runtime only reads them.
 */
import path from 'node:path';
import { SpeechRefusal } from '../backends/types.js';
import { isInstalled } from '../install.js';
import type { LocalKind } from './models.js';

type Transformers = typeof import('@huggingface/transformers');

/** The runtime, configured to read `localDir` and nothing else. */
export async function localRuntime(localDir: string): Promise<Transformers> {
  const t = await import('@huggingface/transformers');
  t.env.allowRemoteModels = false;
  t.env.allowLocalModels = true;
  t.env.localModelPath = localDir.endsWith(path.sep) ? localDir : `${localDir}${path.sep}`;
  t.env.useFSCache = false;
  t.env.useBrowserCache = false;
  return t;
}

const NAMES: Record<LocalKind, string> = { whisper: 'Whisper on this computer', kokoro: 'Kokoro on this computer' };

/** The plugin directory, when this model is installed in it; a refusal naming the Install otherwise. */
export function installedDir(localDir: string | undefined, kind: LocalKind): string {
  if (!localDir || !isInstalled(localDir, kind)) {
    throw new SpeechRefusal(
      `refused: ${NAMES[kind]} is not installed. The owner installs it on Settings → Speech, or with buddi speech install ${kind}.`,
    );
  }
  return localDir;
}

/** One job at a time, in order: a CPU model run is not something to do twice at once. */
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private waiting = 0;

  run<T>(job: () => Promise<T>): Promise<T> {
    this.waiting += 1;
    const next = this.tail.then(job, job);
    this.tail = next.catch(() => undefined).finally(() => { this.waiting -= 1; });
    return next;
  }

  get size(): number {
    return this.waiting;
  }
}

/**
 * A loaded model kept for a while, then let go: Whisper small holds a few
 * hundred MB, and a voice note an hour does not need it resident.
 */
export class Resident<T extends { dispose?: () => unknown }> {
  private held: { key: string; value: Promise<T> } | undefined;
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly idleMs: number) {}

  get(key: string, load: () => Promise<T>): Promise<T> {
    if (this.timer) clearTimeout(this.timer);
    if (!this.held || this.held.key !== key) {
      void this.release();
      const value = load();
      this.held = { key, value };
      value.catch(() => { if (this.held?.value === value) this.held = undefined; });
    }
    return this.held.value;
  }

  /** Start the idle clock after a use. */
  touch(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.release(), this.idleMs);
    this.timer.unref();
  }

  async release(): Promise<void> {
    const held = this.held;
    this.held = undefined;
    if (!held) return;
    try { await (await held.value).dispose?.(); } catch { /* already gone */ }
  }
}
