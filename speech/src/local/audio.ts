/**
 * A recording to 16 kHz mono float PCM, which is what Whisper hears.
 *
 * All in WebAssembly or plain code, so nothing is compiled on install and
 * ffmpeg is never assumed: OGG/Opus (Telegram's voice notes) through
 * `ogg-opus-decoder`, MP3 through `mpg123-decoder`, WAV (PCM or float) read
 * here. Anything else is one sentence naming what is read.
 */
import { SpeechRefusal } from '../backends/types.js';
import type { AudioMime } from '../magic.js';

export const WHISPER_RATE = 16_000;
/** The longest recording the local listener takes. */
export const MAX_LOCAL_SECONDS = 10 * 60;

export const LOCAL_FORMATS = 'OGG/Opus, MP3 and WAV';

export interface DecodedAudio {
  /** Mono, at `WHISPER_RATE`. */
  pcm: Float32Array;
  /** How long the recording is. */
  seconds: number;
}

interface Decoded {
  channelData: Float32Array[];
  samplesDecoded: number;
  sampleRate: number;
}

/** Decode, mix to mono, resample to 16 kHz; refuse over ten minutes. */
export async function decodeForWhisper(bytes: Buffer, mime: AudioMime | string): Promise<DecodedAudio> {
  const decoded = await decode(bytes, mime);
  if (decoded.samplesDecoded === 0 || decoded.channelData.length === 0) {
    throw new SpeechRefusal('refused: the recording holds no sound that could be decoded.');
  }
  const seconds = decoded.samplesDecoded / decoded.sampleRate;
  if (seconds > MAX_LOCAL_SECONDS) {
    throw new SpeechRefusal(
      `refused: the recording is ${Math.round(seconds / 60)} minutes long; Whisper on this computer takes up to ${MAX_LOCAL_SECONDS / 60} minutes.`,
    );
  }
  const mono = downmix(decoded.channelData, decoded.samplesDecoded);
  return { pcm: resample(mono, decoded.sampleRate, WHISPER_RATE), seconds };
}

async function decode(bytes: Buffer, mime: AudioMime | string): Promise<Decoded> {
  const data = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (mime === 'audio/wav') return readWav(bytes);
  if (mime === 'audio/ogg') {
    const { OggOpusDecoder } = await import('ogg-opus-decoder');
    const decoder = new OggOpusDecoder();
    await decoder.ready;
    try {
      const out = await decoder.decodeFile(data);
      if (out.samplesDecoded === 0) throw new SpeechRefusal('refused: the OGG recording is not Opus, or holds no sound; Whisper on this computer reads OGG/Opus.');
      return out;
    } finally {
      decoder.free();
    }
  }
  if (mime === 'audio/mpeg') {
    const { MPEGDecoder } = await import('mpg123-decoder');
    const decoder = new MPEGDecoder();
    await decoder.ready;
    try {
      return decoder.decode(data);
    } finally {
      decoder.free();
    }
  }
  throw new SpeechRefusal(`refused: Whisper on this computer reads ${LOCAL_FORMATS}; this recording is ${mime.replace('audio/', '').toUpperCase()}.`);
}

/** A RIFF/WAVE file: 8, 16, 24 or 32-bit PCM, or 32-bit float. */
export function readWav(bytes: Buffer): Decoded {
  const bad = () => new SpeechRefusal('refused: the WAV file could not be read.');
  if (bytes.length < 12 || bytes.toString('latin1', 0, 4) !== 'RIFF' || bytes.toString('latin1', 8, 12) !== 'WAVE') throw bad();
  let at = 12;
  let format = 0;
  let channels = 0;
  let rate = 0;
  let bits = 0;
  while (at + 8 <= bytes.length) {
    const id = bytes.toString('latin1', at, at + 4);
    const size = bytes.readUInt32LE(at + 4);
    const body = at + 8;
    if (id === 'fmt ') {
      if (size < 16 || body + 16 > bytes.length) throw bad();
      format = bytes.readUInt16LE(body);
      channels = bytes.readUInt16LE(body + 2);
      rate = bytes.readUInt32LE(body + 4);
      bits = bytes.readUInt16LE(body + 14);
      if (format === 0xfffe && size >= 26) format = bytes.readUInt16LE(body + 24); // WAVE_FORMAT_EXTENSIBLE
    } else if (id === 'data') {
      if (!channels || !rate || !bits) throw bad();
      const width = bits / 8;
      const end = Math.min(bytes.length, body + size);
      const frames = Math.floor((end - body) / (width * channels));
      const channelData = Array.from({ length: channels }, () => new Float32Array(frames));
      for (let f = 0; f < frames; f++) {
        for (let c = 0; c < channels; c++) {
          const o = body + (f * channels + c) * width;
          let v: number;
          if (format === 3 && bits === 32) v = bytes.readFloatLE(o);
          else if (format === 1 && bits === 16) v = bytes.readInt16LE(o) / 0x8000;
          else if (format === 1 && bits === 24) v = bytes.readIntLE(o, 3) / 0x800000;
          else if (format === 1 && bits === 32) v = bytes.readInt32LE(o) / 0x80000000;
          else if (format === 1 && bits === 8) v = (bytes[o]! - 128) / 128;
          else throw new SpeechRefusal('refused: the WAV file is in an encoding Whisper on this computer does not read (PCM or float only).');
          channelData[c]![f] = v;
        }
      }
      return { channelData, samplesDecoded: frames, sampleRate: rate };
    }
    at = body + size + (size % 2);
  }
  throw bad();
}

function downmix(channels: Float32Array[], length: number): Float32Array {
  if (channels.length === 1) return channels[0]!.subarray(0, length);
  const out = new Float32Array(length);
  for (const channel of channels) for (let i = 0; i < length; i++) out[i]! += channel[i]! / channels.length;
  return out;
}

/**
 * Change the sample rate: a windowed-sinc low-pass at the lower Nyquist when
 * going down (so 48 kHz does not fold into the 16 kHz band), then linear
 * interpolation. Plenty for speech recognition.
 */
export function resample(input: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return input;
  let source = input;
  if (to < from) {
    const cutoff = to / from / 2;
    const half = 16;
    const taps = new Float32Array(half * 2 + 1);
    let sum = 0;
    for (let k = -half; k <= half; k++) {
      const sinc = k === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * k) / (Math.PI * k);
      const window = 0.54 + 0.46 * Math.cos((Math.PI * k) / half);
      taps[k + half] = sinc * window;
      sum += sinc * window;
    }
    for (let k = 0; k < taps.length; k++) taps[k]! /= sum;
    source = new Float32Array(input.length);
    for (let i = 0; i < input.length; i++) {
      let acc = 0;
      for (let k = -half; k <= half; k++) {
        const j = i + k;
        if (j >= 0 && j < input.length) acc += input[j]! * taps[k + half]!;
      }
      source[i] = acc;
    }
  }
  const length = Math.floor((source.length * to) / from);
  const out = new Float32Array(length);
  const step = from / to;
  for (let i = 0; i < length; i++) {
    const x = i * step;
    const j = Math.floor(x);
    const t = x - j;
    const a = source[j] ?? 0;
    const b = source[j + 1] ?? a;
    out[i] = a + (b - a) * t;
  }
  return out;
}

/** Mono float PCM as a 16-bit WAV file. For tests and debugging. */
export function wavOf(pcm: Float32Array, rate: number): Buffer {
  const out = Buffer.alloc(44 + pcm.length * 2);
  out.write('RIFF', 0, 'latin1');
  out.writeUInt32LE(36 + pcm.length * 2, 4);
  out.write('WAVEfmt ', 8, 'latin1');
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(1, 22);
  out.writeUInt32LE(rate, 24);
  out.writeUInt32LE(rate * 2, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write('data', 36, 'latin1');
  out.writeUInt32LE(pcm.length * 2, 40);
  for (let i = 0; i < pcm.length; i++) {
    const s = Math.max(-1, Math.min(1, pcm[i]!));
    out.writeInt16LE(Math.round(s < 0 ? s * 0x8000 : s * 0x7fff), 44 + i * 2);
  }
  return out;
}
