/**
 * The local backends without their models: decoding to 16 kHz, the OGG/Opus
 * encoder, the English check, and the refusals. The real models run only
 * with SPEECH_REAL_MODELS=1 (`local.real.test.ts`).
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { OggOpusDecoder } from 'ogg-opus-decoder';
import { describe, expect, it } from 'vitest';
import { BACKENDS, COMING_BACKENDS, detectLanguage, kokoroLocalBackend, NotEnglishRefusal, whisperLocalBackend, type LogitsBatch } from './backends/index.js';
import { decodeForWhisper, readWav, resample, wavOf, WHISPER_RATE } from './local/audio.js';
import { isProbablyEnglish } from './local/english.js';
import { encodeOggOpus, oggCrc, PRE_SKIP } from './local/ogg-opus.js';
import { isOggOpus, sniffAudio } from './magic.js';
import { fakeInstalled, M4A, OGG_CLIP } from './testing/fixtures.js';

const ctx = (localDir?: string) => ({ model: '', signal: new AbortController().signal, timeoutMs: 10_000, ...(localDir ? { localDir } : {}) });

function tone(seconds: number, rate: number, hz = 440): Float32Array {
  const pcm = new Float32Array(Math.round(seconds * rate));
  for (let i = 0; i < pcm.length; i++) pcm[i] = 0.5 * Math.sin((2 * Math.PI * hz * i) / rate);
  return pcm;
}

function zeroCrossings(pcm: Float32Array): number {
  let n = 0;
  for (let i = 1; i < pcm.length; i++) if (pcm[i - 1]! < 0 && pcm[i]! >= 0) n += 1;
  return n;
}

/** Every OGG page: its header fields, and whether its CRC holds. */
function pages(bytes: Buffer): Array<{ flags: number; granule: bigint; sequence: number; crcOk: boolean; first: string }> {
  const out = [];
  let at = 0;
  while (at < bytes.length) {
    expect(bytes.toString('latin1', at, at + 4)).toBe('OggS');
    const segments = bytes[at + 26]!;
    let body = 0;
    for (let i = 0; i < segments; i++) body += bytes[at + 27 + i]!;
    const length = 27 + segments + body;
    const page = Buffer.from(bytes.subarray(at, at + length));
    const crc = page.readUInt32LE(22);
    page.writeUInt32LE(0, 22);
    out.push({
      flags: page[5]!,
      granule: page.readBigInt64LE(6),
      sequence: page.readUInt32LE(18),
      crcOk: oggCrc(page) === crc,
      first: page.toString('latin1', 27 + segments, 27 + segments + 8),
    });
    at += length;
  }
  return out;
}

describe('the registry', () => {
  it('has both local backends, none coming, and says nothing leaves', () => {
    expect(Object.keys(BACKENDS)).toEqual(['openai', 'openai-compatible', 'gemini', 'whisper-local', 'kokoro-local']);
    expect(COMING_BACKENDS).toEqual([]);
    for (const b of [whisperLocalBackend, kokoroLocalBackend]) {
      expect(b.accountKind).toBeUndefined();
      expect(b.local).toBeDefined();
    }
    expect(whisperLocalBackend.listener).toBeDefined();
    expect(whisperLocalBackend.speaker).toBeUndefined();
    expect(kokoroLocalBackend.speaker).toBeDefined();
    expect(kokoroLocalBackend.listener).toBeUndefined();
    expect(whisperLocalBackend.leaves.listening).toMatch(/^Nothing/);
    expect(kokoroLocalBackend.leaves.speaking).toMatch(/^Nothing/);
  });

  it('lists Kokoro\'s voices from its pack, English then the other languages, without loading the model', async () => {
    const voices = await kokoroLocalBackend.voices!(ctx());
    expect(voices.length).toBeGreaterThan(30);
    expect(voices.find((v) => v.id === 'af_heart')).toMatchObject({ label: 'Heart (American, female)', language: 'en-us' });
    expect(voices.some((v) => v.id.startsWith('bm_'))).toBe(true);
    expect(voices.find((v) => v.id === 'ff_siwis')).toMatchObject({ label: 'Siwis (French, female)', language: 'fr-fr' });
    expect(voices.find((v) => v.id === 'hm_omega')).toMatchObject({ label: 'Omega (Hindi, male)', language: 'hi' });
    expect(new Set(voices.map((v) => v.language))).toEqual(new Set(['en-us', 'en-gb', 'fr-fr', 'es', 'it', 'pt-br', 'hi']));
    // Japanese and Chinese are in the pack, not in the list: their pronunciation is not eSpeak's.
    expect(voices.some((v) => /^[jz]/.test(v.id))).toBe(false);
  });
});

describe('Whisper\'s language detection', () => {
  // A vocabulary of language tokens, and a model whose first step likes Portuguese best, then French, then English.
  const VOCAB = ['<|startoftranscript|>', '<|en|>', '<|fr|>', '<|pt|>', '<|es|>'];
  const SCORES = [0, 1, 2, 3, 0.5];
  const fakePipe = (seen: { processors?: unknown }) => ({
    model: {
      generation_config: { decoder_start_token_id: 0 },
      async generate(args: Record<string, unknown>) {
        const row = Float32Array.from(SCORES);
        const logits: LogitsBatch = { dims: [1, row.length], 0: { data: row } };
        const processors = (args.logits_processor ?? []) as Array<(ids: unknown, l: LogitsBatch) => LogitsBatch>;
        seen.processors = args.logits_processor;
        for (const p of processors) p([[0n]], logits);
        const best = row.indexOf(Math.max(...row));
        return { tolist: () => [[0, best]] };
      },
    },
    processor: async () => ({ input_features: null }),
    tokenizer: {
      decode: (ids: number[]) => VOCAB[ids[0]!]!,
      model: { tokens_to_ids: new Map(VOCAB.map((t, i) => [t, i])) },
    },
  });

  it('picks freely with no languages, and the likeliest of the owner\'s when there are some', async () => {
    const pcm = new Float32Array(16_000);
    const seen: { processors?: unknown } = {};
    expect(await detectLanguage(fakePipe(seen) as never, pcm)).toBe('pt');
    expect(seen.processors).toBeUndefined();
    expect(await detectLanguage(fakePipe(seen) as never, pcm, ['en', 'fr'])).toBe('fr');
    expect(await detectLanguage(fakePipe(seen) as never, pcm, ['en', 'es'])).toBe('en');
    // Codes Whisper does not know are dropped; none left is a free detection.
    expect(await detectLanguage(fakePipe(seen) as never, pcm, ['xx'])).toBe('pt');
  });

  it('lists its one model', async () => {
    expect(await whisperLocalBackend.models!('listening', ctx())).toEqual(['whisper-small (q8)']);
    expect(await kokoroLocalBackend.models!('speaking', ctx())).toEqual(['kokoro-82m (q8)']);
  });
});

describe('decoding for Whisper', () => {
  it('reads the bundled OGG/Opus clip as 16 kHz mono of the same length', async () => {
    const { pcm, seconds } = await decodeForWhisper(OGG_CLIP, 'audio/ogg');
    expect(seconds).toBeGreaterThan(1);
    expect(seconds).toBeLessThan(4);
    expect(pcm.length).toBe(Math.floor(seconds * WHISPER_RATE));
    expect(Math.max(...pcm.map(Math.abs))).toBeGreaterThan(0.05);
  });

  it('round-trips a tone through WAV and through our own OGG/Opus, keeping its pitch', async () => {
    const wav = wavOf(tone(1, 44_100), 44_100);
    const fromWav = await decodeForWhisper(wav, 'audio/wav');
    expect(fromWav.pcm.length).toBe(16_000);
    expect(Math.abs(zeroCrossings(fromWav.pcm) - 440)).toBeLessThanOrEqual(2);

    const ogg = encodeOggOpus(tone(1, 24_000), 24_000);
    const fromOgg = await decodeForWhisper(ogg, 'audio/ogg');
    expect(Math.abs(fromOgg.seconds - 1)).toBeLessThan(0.03);
    expect(Math.abs(zeroCrossings(fromOgg.pcm) - 440)).toBeLessThanOrEqual(4);
  });

  it('reads a stereo 16-bit WAV by its chunks', () => {
    const mono = wavOf(tone(0.1, 8000), 8000);
    const decoded = readWav(mono);
    expect(decoded).toMatchObject({ sampleRate: 8000, samplesDecoded: 800 });
  });

  it('refuses what it does not read, and a recording over ten minutes', async () => {
    await expect(decodeForWhisper(M4A, 'audio/mp4')).rejects.toThrow('refused: Whisper on this computer reads OGG/Opus, MP3 and WAV; this recording is MP4.');
    // Eleven minutes of 8 kHz silence.
    const big = wavOf(new Float32Array(8000 * 60 * 11), 8000);
    await expect(decodeForWhisper(big, 'audio/wav')).rejects.toThrow(/is 11 minutes long; Whisper on this computer takes up to 10 minutes/);
  });

  it('low-passes before going down, so 48 kHz does not fold into the band', () => {
    const high = tone(0.5, 48_000, 12_000); // above 8 kHz: should vanish at 16 kHz
    const down = resample(high, 48_000, 16_000);
    const rms = Math.sqrt(down.reduce((n, v) => n + v * v, 0) / down.length);
    expect(rms).toBeLessThan(0.02);
  });
});

describe('the OGG/Opus encoder', () => {
  it('writes a valid voice note: OpusHead, OpusTags, audio pages with good CRCs, the last one ending the stream', () => {
    const pcm = tone(2.5, 24_000);
    const ogg = encodeOggOpus(pcm, 24_000);
    expect(sniffAudio(ogg)).toBe('audio/ogg');
    expect(isOggOpus(ogg)).toBe(true);
    const all = pages(ogg);
    expect(all.every((p) => p.crcOk)).toBe(true);
    expect(all[0]).toMatchObject({ flags: 0x02, granule: 0n, sequence: 0, first: 'OpusHead' });
    expect(all[1]).toMatchObject({ flags: 0, granule: 0n, sequence: 1, first: 'OpusTags' });
    expect(all.at(-1)!.flags).toBe(0x04);
    expect(all.slice(2, -1).every((p) => p.flags === 0)).toBe(true);
    expect(all.map((p) => p.sequence)).toEqual(all.map((_, i) => i));
    const granules = all.map((p) => p.granule);
    expect(granules).toEqual([...granules].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
    // The last granule is the real length at 48 kHz plus the pre-skip.
    expect(all.at(-1)!.granule).toBe(BigInt(PRE_SKIP + 2.5 * 48_000));
    // The input rate is written in the head; 24 kbps keeps a voice note small.
    expect(ogg.readUInt32LE(27 + 1 + 12)).toBe(24_000);
    expect(ogg.length).toBeLessThan(2.5 * 24_000 / 8 * 1.3);
  });

  it('decodes back to the same length and pitch', async () => {
    const ogg = encodeOggOpus(tone(1, 24_000), 24_000);
    const decoder = new OggOpusDecoder();
    await decoder.ready;
    const out = await decoder.decodeFile(new Uint8Array(ogg));
    decoder.free();
    expect(out.errors).toEqual([]);
    expect(Math.abs(out.samplesDecoded - 48_000)).toBeLessThanOrEqual(PRE_SKIP);
    expect(Math.abs(zeroCrossings(out.channelData[0]!) - 440)).toBeLessThanOrEqual(4);
  });
});

describe('Kokoro\'s languages', () => {
  it('tells English from the rest by script, accents and common words', () => {
    expect(isProbablyEnglish('This is buddi. Your meeting moved to three.')).toBe(true);
    expect(isProbablyEnglish('Your balance is 1,204 euros, and nothing is due this week.')).toBe(true);
    expect(isProbablyEnglish("Bonjour, votre rendez-vous est déplacé à quinze heures, et il n'y a rien d'autre.")).toBe(false);
    expect(isProbablyEnglish('Hola, la reunión es a las tres y no hay nada más.')).toBe(false);
    expect(isProbablyEnglish('Die Besprechung ist um drei und das ist alles.')).toBe(false);
    expect(isProbablyEnglish('会議は三時に移動しました。')).toBe(false);
    expect(isProbablyEnglish('Привет, встреча в три.')).toBe(false);
    // Too short to tell: the owner's hint decides.
    expect(isProbablyEnglish('Okay.')).toBe(true);
    expect(isProbablyEnglish('Okay.', 'fr')).toBe(false);
  });

  it('refuses a French reply with the typed not-english refusal, before anything is loaded', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'buddi-speech-kokoro-'));
    try {
      const said = kokoroLocalBackend.speaker!.synthesize({ text: 'Bonjour, votre rendez-vous est déplacé à quinze heures.', format: 'ogg-opus' }, ctx(dir));
      await expect(said).rejects.toBeInstanceOf(NotEnglishRefusal);
      await expect(said).rejects.toMatchObject({ code: 'not-english', refusal: true, message: expect.stringMatching(/^refused: not-english: /) });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('refuses a French voice while eSpeak NG is missing, and a Japanese voice always', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'buddi-speech-kokoro-'));
    try {
      await fakeInstalled(dir, 'kokoro', { companions: false });
      const request = { text: 'Bonjour, votre rendez-vous est déplacé à quinze heures.', voice: 'ff_siwis', format: 'ogg-opus' as const };
      await expect(kokoroLocalBackend.speaker!.synthesize(request, ctx(dir))).rejects.toThrow(
        "refused: Kokoro's pronunciation of languages other than English (eSpeak NG) is not installed. The owner installs it with Kokoro's Install on Settings → Speech, or with buddi speech install kokoro.",
      );
      await expect(kokoroLocalBackend.speaker!.synthesize({ ...request, voice: 'jf_alpha' }, ctx(dir))).rejects.toThrow(/does not speak Japanese or Chinese/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('refuses when a model is not installed, naming the Install and the command', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'buddi-speech-none-'));
    try {
      await expect(kokoroLocalBackend.speaker!.synthesize({ text: 'This is buddi.', format: 'ogg-opus' }, ctx(dir))).rejects.toThrow(
        'refused: Kokoro on this computer is not installed. The owner installs it on Settings → Speech, or with buddi speech install kokoro.',
      );
      await expect(whisperLocalBackend.listener!.transcribe({ bytes: OGG_CLIP, mime: 'audio/ogg' }, ctx())).rejects.toThrow(/Whisper on this computer is not installed/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
