/**
 * The main thread's side of the speech worker (`worker.ts`): one worker for
 * both models, started on the first call and kept, one call at a time.
 *
 * Every call has a budget. Past it the call is refused with one sentence and
 * the worker is terminated (a model run cannot be interrupted any other way)
 * and started again on the next call. A caller's cancel drops a waiting call
 * at once; a running one is told to stop at its next chunk, and the worker
 * is replaced if it has not stopped within a few seconds.
 */
import { Worker } from 'node:worker_threads';
import { SpeechRefusal } from '../backends/types.js';
import { CANCELLED, fromWire, type FromWorker, type Op, type ToWorker, type WorkerSetup } from './protocol.js';
import { SerialQueue } from './runtime.js';
import { speechThreads } from './threads.js';

export interface CallOptions {
  signal?: AbortSignal | undefined;
  /** The budget, from the moment the worker starts on this call. */
  limitMs: number;
  /** "Transcribing", "Speaking": the subject of the timeout sentence. */
  what: string;
  transfer?: ArrayBuffer[];
}

export interface LocalWorkerOptions {
  /** The engine module's URL (a fake one in the tests); absent is the real models. */
  engine?: string;
  threads?: number;
  /** How long a cancelled call may take to stop before its worker is replaced. */
  graceMs?: number;
}

interface Pending {
  settle(error: Error | undefined, value?: unknown): void;
}

const HERE = import.meta.url;

export class LocalWorker {
  private worker: Worker | undefined;
  private readonly queue = new SerialQueue();
  private readonly pending = new Map<number, Pending>();
  private seq = 0;
  /** How many workers were started: a timeout shows as one more. */
  started = 0;
  readonly threads: number;
  private readonly engine: string | undefined;
  private readonly graceMs: number;

  constructor(options: LocalWorkerOptions = {}) {
    this.engine = options.engine;
    this.threads = options.threads ?? speechThreads();
    this.graceMs = options.graceMs ?? 5_000;
  }

  /** Calls waiting or running. */
  get size(): number {
    return this.queue.size;
  }

  call<T>(op: Op, args: unknown, options: CallOptions): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      let stopRunning: (() => void) | undefined;
      const finish = (error: Error | undefined, value?: unknown) => {
        if (settled) return;
        settled = true;
        options.signal?.removeEventListener('abort', onAbort);
        if (error) reject(error);
        else resolve(value as T);
      };
      const onAbort = () => {
        stopRunning?.();
        finish(new SpeechRefusal(CANCELLED));
      };
      if (options.signal?.aborted) return onAbort();
      options.signal?.addEventListener('abort', onAbort, { once: true });

      void this.queue.run(
        () =>
          new Promise<void>((done) => {
            if (settled) return done();
            const worker = this.ensure();
            const id = ++this.seq;
            let grace: NodeJS.Timeout | undefined;
            const timer = setTimeout(() => {
              this.pending.delete(id);
              finish(new SpeechRefusal(`refused: ${options.what} took longer than ${Math.round(options.limitMs / 1000)} seconds, so it was stopped.`));
              void this.restart(worker);
              done();
            }, options.limitMs);
            stopRunning = () => {
              clearTimeout(timer);
              this.post(worker, { type: 'cancel', id });
              grace = setTimeout(() => {
                this.pending.delete(id);
                void this.restart(worker);
                done();
              }, this.graceMs);
            };
            this.pending.set(id, {
              settle: (error, value) => {
                clearTimeout(timer);
                clearTimeout(grace);
                this.pending.delete(id);
                finish(error, value);
                if (this.pending.size === 0) this.worker?.unref();
                done();
              },
            });
            worker.ref();
            this.post(worker, { type: 'call', id, op, args }, options.transfer);
          }),
      );
    });
  }

  /** Stop the worker; the next call starts a new one. */
  async terminate(): Promise<void> {
    if (this.worker) await this.restart(this.worker);
  }

  private post(worker: Worker, message: ToWorker, transfer: ArrayBuffer[] = []): void {
    try { worker.postMessage(message, transfer); } catch { /* it is going away; the exit handler settles */ }
  }

  private ensure(): Worker {
    if (this.worker) return this.worker;
    const setup: WorkerSetup = { threads: this.threads, ...(this.engine ? { engine: this.engine } : {}) };
    const worker = spawn(setup);
    this.started += 1;
    this.worker = worker;
    worker.on('message', (message: FromWorker) => {
      const p = this.pending.get(message.id);
      if (!p) return;
      if (message.type === 'result') p.settle(undefined, message.value);
      else p.settle(fromWire(message.error));
    });
    const gone = (why: string) => {
      if (this.worker !== worker) return;
      this.worker = undefined;
      for (const p of [...this.pending.values()]) p.settle(new SpeechRefusal(`refused: the speech models stopped (${why}). Try again.`));
    };
    worker.on('error', (error) => gone(error.message));
    worker.on('exit', (code) => gone(`exit ${code}`));
    worker.unref();
    return worker;
  }

  private async restart(worker: Worker): Promise<void> {
    if (this.worker === worker) this.worker = undefined;
    await worker.terminate().catch(() => undefined);
  }
}

/**
 * The built `worker.js` next to this file. Run from the TypeScript sources
 * (the tests), the worker is `worker.ts`, loaded through esbuild (vitest's).
 */
function spawn(setup: WorkerSetup): Worker {
  if (!HERE.endsWith('.ts')) return new Worker(new URL('./worker.js', HERE), { workerData: setup, name: 'buddi-speech' });
  return new Worker(TS_BOOTSTRAP, { eval: true, workerData: { ...setup, entry: new URL('./worker.ts', HERE).href }, name: 'buddi-speech' });
}

const TS_BOOTSTRAP = `
const { createRequire, registerHooks } = require('node:module');
const { readFileSync } = require('node:fs');
const { fileURLToPath } = require('node:url');
const { workerData } = require('node:worker_threads');
const fromHere = createRequire(fileURLToPath(workerData.entry));
const fromVite = createRequire(createRequire(fromHere.resolve('vitest/package.json')).resolve('vite'));
const esbuild = createRequire(fromVite.resolve('esbuild'))('esbuild');
registerHooks({
  resolve(spec, ctx, next) {
    try { return next(spec, ctx); } catch (e) {
      if (spec.endsWith('.js') && ctx.parentURL && ctx.parentURL.endsWith('.ts')) return next(spec.slice(0, -3) + '.ts', ctx);
      throw e;
    }
  },
  load(url, ctx, next) {
    if (!url.startsWith('file:') || !url.endsWith('.ts')) return next(url, ctx);
    const { code } = esbuild.transformSync(readFileSync(fileURLToPath(url), 'utf8'), { loader: 'ts', format: 'esm', target: 'es2022', sourcefile: fileURLToPath(url) });
    return { format: 'module', source: code, shortCircuit: true };
  },
});
// An eval'd worker has a global \`__dirname\` of '.', which kokoro-js would take for its own.
delete globalThis.__dirname;
delete globalThis.__filename;
import(workerData.entry);
`;

/** The one worker of this process. */
export const localWorker = new LocalWorker();
