/**
 * The speech worker without the models: a fake engine (`testing/fake-engine.ts`)
 * behind the real worker and client. The round trip, the refusals keeping
 * their class, the gateway's thread staying free while a model run blocks,
 * cancelling, and the budget terminating and replacing the worker.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { NotEnglishRefusal, SpeechRefusal } from '../backends/types.js';
import { LocalWorker } from './client.js';
import { CANCELLED } from './protocol.js';
import { speechThreads } from './threads.js';

const FAKE = new URL('../testing/fake-engine.ts', import.meta.url).href;
const workers: LocalWorker[] = [];

function fake(options: { threads?: number; graceMs?: number } = {}): LocalWorker {
  const w = new LocalWorker({ engine: FAKE, threads: options.threads ?? 2, ...(options.graceMs ? { graceMs: options.graceMs } : {}) });
  workers.push(w);
  return w;
}

const say = (w: LocalWorker, text: string, extra: { signal?: AbortSignal; limitMs?: number } = {}) =>
  w.call<{ bytes: Uint8Array }>('synthesize', { dir: '/nowhere', text, voice: 'af_fake' }, { limitMs: extra.limitMs ?? 10_000, what: 'Speaking', signal: extra.signal });

afterEach(async () => {
  await Promise.all(workers.splice(0).map((w) => w.terminate()));
});

describe('the speech worker', () => {
  it('answers each call, with the bytes transferred both ways', async () => {
    const w = fake({ threads: 3 });
    const clip = new Uint8Array(1234);
    const heard = await w.call<{ text: string; language?: string }>('transcribe', { dir: '/nowhere', bytes: clip, mime: 'audio/ogg', language: 'fr' }, {
      limitMs: 10_000,
      what: 'Transcribing',
      transfer: [clip.buffer],
    });
    expect(heard.text).toMatch(/^1234 bytes of audio\/ogg, 3 threads, engine /);
    expect(heard.language).toBe('fr');
    expect(clip.byteLength).toBe(0); // transferred, not copied

    const said = await say(w, 'Hello there.');
    expect(Buffer.from(said.bytes).toString()).toBe('af_fake:Hello there.');
    expect(await w.call('detectLanguage', { dir: '/nowhere', bytes: new Uint8Array(1), mime: 'audio/ogg', languages: ['de'] }, { limitMs: 10_000, what: 'Listening' })).toBe('de');
    expect(await w.call('voices', {}, { limitMs: 10_000, what: 'Listing' })).toEqual([{ id: 'af_fake', name: 'Fake', language: 'en-us', gender: 'Female' }]);
    expect(w.started).toBe(1);
  });

  it('keeps a refusal a refusal, not-english typed, and anything else a plain error', async () => {
    const w = fake();
    await expect(say(w, 'french')).rejects.toBeInstanceOf(NotEnglishRefusal);
    await expect(say(w, 'refuse')).rejects.toMatchObject({ refusal: true, message: 'refused: the fake says no.' });
    const crash = await say(w, 'crash').catch((e: unknown) => e);
    expect(crash).toBeInstanceOf(Error);
    expect(crash).not.toBeInstanceOf(SpeechRefusal);
    expect((crash as Error).message).toBe('something inside broke');
  });

  it('leaves the main thread free while a model run holds the worker\'s', async () => {
    const w = fake();
    await say(w, 'warm up'); // the worker and its engine are loaded
    let last = Date.now();
    let worst = 0;
    const tick = setInterval(() => {
      const now = Date.now();
      worst = Math.max(worst, now - last);
      last = now;
    }, 5);
    try {
      await say(w, 'hang 600');
    } finally {
      clearInterval(tick);
    }
    expect(worst).toBeLessThan(50);
  });

  it('runs one call at a time, in order', async () => {
    const w = fake();
    const order: string[] = [];
    const first = say(w, 'hang 200').then(() => order.push('first'));
    const second = say(w, 'quick').then(() => order.push('second'));
    expect(w.size).toBe(2);
    await Promise.all([first, second]);
    expect(order).toEqual(['first', 'second']);
  });

  it('drops a waiting call at once when cancelled, and stops a running one at its next step', async () => {
    const w = fake();
    const running = new AbortController();
    const waiting = new AbortController();
    const slow = say(w, 'slow', { signal: running.signal });
    const queued = say(w, 'after', { signal: waiting.signal });
    waiting.abort();
    await expect(queued).rejects.toThrow(CANCELLED);
    await new Promise((r) => setTimeout(r, 100));
    const t = Date.now();
    running.abort();
    await expect(slow).rejects.toThrow(CANCELLED);
    expect(Date.now() - t).toBeLessThan(50);
    // The same worker takes the next call: the cancel was honoured, not forced.
    expect(Buffer.from((await say(w, 'next')).bytes).toString()).toBe('af_fake:next');
    expect(w.started).toBe(1);
  });

  it('refuses a call already cancelled without starting anything', async () => {
    const w = fake();
    const c = new AbortController();
    c.abort();
    await expect(say(w, 'never', { signal: c.signal })).rejects.toThrow(CANCELLED);
    expect(w.started).toBe(0);
  });

  it('past its budget: refuses with a sentence, terminates the worker, and starts a new one for the next call', async () => {
    const w = fake();
    const t = Date.now();
    await expect(say(w, 'hang 60000', { limitMs: 300 })).rejects.toThrow('refused: Speaking took longer than 0 seconds, so it was stopped.');
    expect(Date.now() - t).toBeLessThan(2_000);
    const heard = await w.call<{ text: string }>('transcribe', { dir: '/nowhere', bytes: new Uint8Array(3), mime: 'audio/wav' }, { limitMs: 10_000, what: 'Transcribing' });
    expect(heard.text).toMatch(/^3 bytes/);
    expect(w.started).toBe(2);
  });

  it('replaces a worker that does not stop within the grace after a cancel', async () => {
    const w = fake({ graceMs: 200 });
    const c = new AbortController();
    const stuck = say(w, 'hang 60000', { signal: c.signal });
    await new Promise((r) => setTimeout(r, 100));
    c.abort();
    await expect(stuck).rejects.toThrow(CANCELLED);
    expect(Buffer.from((await say(w, 'fresh')).bytes).toString()).toBe('af_fake:fresh');
    expect(w.started).toBe(2);
  });
});

describe('the thread count', () => {
  it('keeps two cores for the rest of buddi, at most four, at least one', () => {
    expect(speechThreads({}, 1)).toBe(1);
    expect(speechThreads({}, 2)).toBe(1);
    expect(speechThreads({}, 4)).toBe(2);
    expect(speechThreads({}, 6)).toBe(4);
    expect(speechThreads({}, 16)).toBe(4);
  });

  it('takes SPEECH_THREADS, within the cores there are, and ignores nonsense', () => {
    expect(speechThreads({ SPEECH_THREADS: '8' }, 16)).toBe(8);
    expect(speechThreads({ SPEECH_THREADS: '64' }, 16)).toBe(16);
    expect(speechThreads({ SPEECH_THREADS: '1' }, 16)).toBe(1);
    expect(speechThreads({ SPEECH_THREADS: '0' }, 16)).toBe(4);
    expect(speechThreads({ SPEECH_THREADS: 'lots' }, 16)).toBe(4);
  });
});
