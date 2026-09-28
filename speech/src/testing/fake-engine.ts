/**
 * A stand-in for the real models, loaded by the speech worker in the tests
 * (`local/client.test.ts`). What it does depends on the text or the bytes:
 * `hang` blocks its thread the way a synchronous ONNX run does, `slow` works
 * in small steps checking for a cancel, `french` is the typed refusal.
 */
import { NotEnglishRefusal, SpeechRefusal } from '../backends/types.js';
import type { Engine, EngineOptions } from '../local/protocol.js';

const instance = Math.random().toString(36).slice(2, 8);

function block(ms: number): void {
  const end = Date.now() + ms;
  while (Date.now() < end) { /* a model run holding the thread */ }
}

export function createEngine(options: EngineOptions): Engine {
  return {
    async transcribe({ bytes, mime, language }) {
      return { text: `${bytes.byteLength} bytes of ${mime}, ${options.threads} threads, engine ${instance}`, ...(language ? { language } : {}) };
    },
    async detectLanguage({ languages }) {
      return languages?.[0] ?? 'en';
    },
    async synthesize({ text, voice }, check) {
      if (text.startsWith('hang')) block(Number(text.split(' ')[1] ?? 60_000));
      if (text === 'slow') {
        for (let i = 0; i < 1000; i++) {
          block(10);
          await new Promise((r) => setImmediate(r));
          check();
        }
      }
      if (text === 'french') throw new NotEnglishRefusal();
      if (text === 'refuse') throw new SpeechRefusal('refused: the fake says no.');
      if (text === 'crash') throw new TypeError('something inside broke');
      const bytes = new Uint8Array(Buffer.from(`${voice}:${text}`));
      return { bytes, seconds: 1 };
    },
    async voices() {
      return [{ id: 'af_fake', name: 'Fake', language: 'en-us', gender: 'Female' }];
    },
  };
}
