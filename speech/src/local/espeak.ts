/**
 * eSpeak NG, loaded in the speech worker from the files `install.ts` put in
 * `<dir>/espeak` (Echogarden's Emscripten build: `espeak-ng.js` and its
 * language data, GPL-3.0, fetched at install time and never a dependency of
 * this plugin). One instance, kept with Kokoro and let go with it.
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { EspeakLike } from './phonemes.js';

interface EspeakWorker {
  set_voice(name: string): number;
  convert_to_phonemes(text: string, ipa: boolean): { ptr: number };
}

interface EspeakModule {
  eSpeakNGWorker: new () => EspeakWorker;
  HEAPU8: Uint8Array;
  _free?: (ptr: number) => void;
}

export interface LoadedEspeak extends EspeakLike {
  dispose(): void;
}

const utf8 = new TextDecoder();

/** Load eSpeak from its directory: the module reads its data file from beside it. */
export async function loadEspeak(dir: string): Promise<LoadedEspeak> {
  const { default: init } = (await import(pathToFileURL(path.join(dir, 'espeak-ng.js')).href)) as { default: (m: object) => Promise<EspeakModule> };
  const m = await init({ locateFile: (file: string) => path.join(dir, file) });
  const worker = new m.eSpeakNGWorker();
  let voice: string | undefined;
  return {
    raw(text, name) {
      if (name !== voice) {
        if (worker.set_voice(name) !== 0) throw new Error(`eSpeak NG has no voice "${name}".`);
        voice = name;
      }
      const { ptr } = worker.convert_to_phonemes(text, true);
      if (!ptr) return '';
      const heap = m.HEAPU8;
      let end = ptr;
      while (heap[end] !== 0) end++;
      const out = utf8.decode(heap.subarray(ptr, end));
      // Echogarden's build hands back a buffer of its own for each call.
      m._free?.(ptr);
      return out;
    },
    dispose() {
      voice = undefined;
    },
  };
}
