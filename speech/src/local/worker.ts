/**
 * The speech worker: a `worker_threads` Worker that runs the local models,
 * so a long reply read aloud or a long voice note never holds the gateway's
 * event loop. Started and restarted by `client.ts`; it loads the engine
 * (`engine.js`, or a fake one named in `workerData.engine`) on the first call.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { CANCELLED, toWire, type Engine, type EngineModule, type FromWorker, type ToWorker, type WorkerSetup } from './protocol.js';
import { SpeechRefusal } from '../backends/types.js';

const setup = workerData as WorkerSetup;
const port = parentPort!;
let engine: Promise<Engine> | undefined;
const active = new Set<number>();
const cancelled = new Set<number>();

function load(): Promise<Engine> {
  engine ??= (import(setup.engine ?? new URL('./engine.js', import.meta.url).href) as Promise<EngineModule>).then((m) => m.createEngine({ threads: setup.threads }));
  return engine;
}

function send(message: FromWorker, transfer: ArrayBuffer[] = []): void {
  port.postMessage(message, transfer);
}

/** Bytes in a buffer of their own, so it can be transferred (a pooled Buffer's cannot). */
function owned(value: unknown): unknown {
  const bytes = (value as { bytes?: unknown } | undefined)?.bytes;
  if (!(bytes instanceof Uint8Array)) return value;
  const alone = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength && bytes.buffer instanceof ArrayBuffer;
  return { ...(value as object), bytes: alone ? bytes : bytes.slice() };
}

function transferOf(value: unknown): ArrayBuffer[] {
  const bytes = (value as { bytes?: unknown } | undefined)?.bytes;
  return bytes instanceof Uint8Array ? [bytes.buffer as ArrayBuffer] : [];
}

async function call(id: number, op: string, args: never): Promise<void> {
  active.add(id);
  const check = () => { if (cancelled.has(id)) throw new SpeechRefusal(CANCELLED); };
  try {
    check();
    const e = await load();
    check();
    const value =
      op === 'transcribe' ? await e.transcribe(args, check)
      : op === 'detectLanguage' ? await e.detectLanguage(args, check)
      : op === 'synthesize' ? await e.synthesize(args, check)
      : op === 'voices' ? await e.voices()
      : (() => { throw new Error(`unknown speech worker call: ${op}`); })();
    const out = owned(value);
    send({ type: 'result', id, value: out }, transferOf(out));
  } catch (error) {
    send({ type: 'error', id, error: toWire(error) });
  } finally {
    active.delete(id);
    cancelled.delete(id);
  }
}

port.on('message', (message: ToWorker) => {
  if (message.type === 'cancel') { if (active.has(message.id)) cancelled.add(message.id); }
  else void call(message.id, message.op, message.args as never);
});
