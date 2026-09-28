/**
 * The real models, end to end: download with `installLocal`, speak "This is
 * buddi." with Kokoro, "Je suis Jean Pierre" with its French voice through
 * eSpeak NG, transcribe the bundled clip with Whisper. Skipped
 * unless SPEECH_REAL_MODELS=1; downloads into SPEECH_MODELS_DIR, or a
 * throwaway directory that is deleted afterwards.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, get } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { kokoroLocalBackend, whisperLocalBackend } from './backends/index.js';
import { OggOpusDecoder } from 'ogg-opus-decoder';
import { installLocal, isInstalled } from './install.js';
import { loadEspeak } from './local/espeak.js';
import { ESPEAK_RAW } from './testing/espeak-fixtures.js';
import { isOggOpus } from './magic.js';
import { OGG_CLIP } from './testing/fixtures.js';

const real = process.env.SPEECH_REAL_MODELS === '1' ? describe : describe.skip;

real('the real local models', () => {
  let dir: string;
  const keep = Boolean(process.env.SPEECH_MODELS_DIR);
  beforeAll(async () => { dir = process.env.SPEECH_MODELS_DIR ?? (await mkdtemp(path.join(tmpdir(), 'buddi-speech-real-'))); });
  afterAll(async () => { if (!keep) await rm(dir, { recursive: true, force: true }); });
  const ctx = () => ({ model: '', signal: new AbortController().signal, timeoutMs: 120_000, localDir: dir });

  it('Kokoro says "This is buddi." as an OGG/Opus voice note', async () => {
    let t = Date.now();
    const installed = await installLocal('kokoro', { dir });
    console.log(`kokoro: ${installed.bytes} bytes, ${installed.fetched ? 'fetched' : 'already there'} in ${Date.now() - t} ms`);
    t = Date.now();
    const said = await kokoroLocalBackend.speaker!.synthesize({ text: 'This is buddi.', format: 'ogg-opus', voice: 'af_heart' }, ctx());
    console.log(`kokoro: first synthesis (load + speak) ${Date.now() - t} ms, ${said.bytes.length} bytes`);
    t = Date.now();
    await kokoroLocalBackend.speaker!.synthesize({ text: 'This is buddi.', format: 'ogg-opus' }, ctx());
    console.log(`kokoro: second synthesis ${Date.now() - t} ms`);
    expect(isOggOpus(said.bytes)).toBe(true);
  }, 20 * 60_000);

  it('reads half a minute aloud in the worker while this thread keeps answering HTTP', async () => {
    await installLocal('kokoro', { dir });
    await kokoroLocalBackend.speaker!.synthesize({ text: 'Warm up.', format: 'ogg-opus' }, ctx());
    const server = createServer((_req, res) => res.end('ok'));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    const text = [
      'Good morning. Here is what the day looks like.',
      'Your first meeting is at nine thirty with the design team, and it should take about forty minutes.',
      'After that, the quarterly budget review has moved to eleven, in the small room on the second floor.',
      'Lunch is free, so I kept it that way.',
      'In the afternoon, the train to the coast leaves at four fifteen from platform six, and the tickets are in your email.',
      'The weather there is mild, with a chance of rain in the evening, so take a light coat.',
      'Finally, two invoices are due this week, and nothing else needs your attention today.',
    ].join(' ');
    // A fresh connection each time: fetch's keep-alive adds its own ~480 ms stalls, worker or not.
    const hit = () => new Promise<void>((resolve, reject) => get(url, { agent: false }, (r) => { r.resume(); r.on('end', resolve); }).on('error', reject));
    let done = false;
    const latencies: number[] = [];
    const probe = (async () => {
      while (!done) {
        const t = performance.now();
        await hit();
        latencies.push(performance.now() - t);
        await new Promise((r) => setTimeout(r, 20));
      }
    })();
    const t = Date.now();
    const said = await kokoroLocalBackend.speaker!.synthesize({ text, format: 'ogg-opus' }, ctx());
    const took = Date.now() - t;
    done = true;
    await probe;
    server.close();
    const worst = Math.max(...latencies);
    console.log(`kokoro: ${text.length} chars in ${took} ms, ${said.bytes.length} bytes; ${latencies.length} HTTP probes, worst ${worst.toFixed(1)} ms`);
    expect(isOggOpus(said.bytes)).toBe(true);
    expect(worst).toBeLessThan(50);
  }, 20 * 60_000);

  it('Kokoro says "Je suis Jean Pierre" with ff_siwis, through eSpeak NG, as a valid OGG/Opus voice note', async () => {
    let t = Date.now();
    const installed = await installLocal('kokoro', { dir });
    console.log(`kokoro + espeak: ${installed.bytes} bytes, ${installed.fetched ? 'fetched' : 'already there'} in ${Date.now() - t} ms`);
    expect(isInstalled(dir, 'espeak')).toBe(true);
    // The real eSpeak answers what the fixtures recorded.
    const espeak = await loadEspeak(path.join(dir, 'espeak'));
    for (const [key, raw] of Object.entries(ESPEAK_RAW)) {
      const [voice, text] = [key.slice(0, key.indexOf('|')), key.slice(key.indexOf('|') + 1)];
      expect(espeak.raw(text, voice)).toBe(raw);
    }
    t = Date.now();
    const said = await kokoroLocalBackend.speaker!.synthesize({ text: 'Je suis Jean Pierre.', voice: 'ff_siwis', format: 'ogg-opus' }, ctx());
    const took = Date.now() - t;
    const decoder = new OggOpusDecoder();
    await decoder.ready;
    const out = await decoder.decodeFile(new Uint8Array(said.bytes));
    decoder.free();
    const seconds = out.samplesDecoded / out.sampleRate;
    console.log(`kokoro ff_siwis: "Je suis Jean Pierre." in ${took} ms (load included), ${said.bytes.length} bytes, ${seconds.toFixed(2)} s of audio, ${out.errors.length} decode errors`);
    expect(isOggOpus(said.bytes)).toBe(true);
    expect(out.errors).toEqual([]);
    expect(seconds).toBeGreaterThan(0.8);
    expect(seconds).toBeLessThan(4);
  }, 20 * 60_000);

  it('Whisper hears the bundled clip', async () => {
    let t = Date.now();
    const installed = await installLocal('whisper', { dir });
    console.log(`whisper: ${installed.bytes} bytes, ${installed.fetched ? 'fetched' : 'already there'} in ${Date.now() - t} ms`);
    t = Date.now();
    const heard = await whisperLocalBackend.listener!.transcribe({ bytes: OGG_CLIP, mime: 'audio/ogg' }, ctx());
    console.log(`whisper: first transcription (load + run) ${Date.now() - t} ms: ${JSON.stringify(heard)}`);
    t = Date.now();
    const again = await whisperLocalBackend.listener!.transcribe({ bytes: OGG_CLIP, mime: 'audio/ogg', language: 'en' }, ctx());
    console.log(`whisper: second transcription ${Date.now() - t} ms: ${JSON.stringify(again)}`);
    expect(heard.text.toLowerCase()).toMatch(/hello/);
    expect(heard.language).toBe('en');
  }, 20 * 60_000);

  it('Whisper detects a language other than English when no hint is given', async () => {
    await installLocal('whisper', { dir });
    // Runs only when SPEECH_FRENCH_CLIP names a French recording (WAV, MP3 or OGG/Opus).
    const clip = process.env.SPEECH_FRENCH_CLIP;
    if (!clip) return;
    const { readFile } = await import('node:fs/promises');
    const bytes = await readFile(clip);
    const { sniffAudio } = await import('./magic.js');
    const heard = await whisperLocalBackend.listener!.transcribe({ bytes, mime: sniffAudio(bytes)! }, ctx());
    console.log(`french: ${JSON.stringify(heard)}`);
    expect(heard.language).toBe('fr');
  }, 20 * 60_000);

  it('Whisper hears what Kokoro said: the voice note is real speech', async () => {
    await installLocal('kokoro', { dir });
    await installLocal('whisper', { dir });
    const said = await kokoroLocalBackend.speaker!.synthesize({ text: 'Your train leaves at nine.', format: 'ogg-opus' }, ctx());
    const heard = await whisperLocalBackend.listener!.transcribe({ bytes: said.bytes, mime: 'audio/ogg', language: 'en' }, ctx());
    console.log(`round trip: ${JSON.stringify(heard.text)}`);
    expect(heard.text.toLowerCase()).toMatch(/train/);
  }, 20 * 60_000);

  it('Whisper hears what Kokoro said in French', async () => {
    await installLocal('kokoro', { dir });
    await installLocal('whisper', { dir });
    const said = await kokoroLocalBackend.speaker!.synthesize({ text: 'Bonjour, votre train part à neuf heures.', voice: 'ff_siwis', format: 'ogg-opus' }, ctx());
    const heard = await whisperLocalBackend.listener!.transcribe({ bytes: said.bytes, mime: 'audio/ogg', language: 'fr' }, ctx());
    console.log(`french round trip: ${JSON.stringify(heard.text)}`);
    expect(heard.text.toLowerCase()).toMatch(/train/);
  }, 20 * 60_000);
});
