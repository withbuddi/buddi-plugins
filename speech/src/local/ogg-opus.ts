/**
 * PCM to an OGG/Opus voice note, with no ffmpeg and no native build.
 *
 * libopus is `opusscript` (libopus 1.4 compiled to WebAssembly, ~310 KB); the
 * OGG container is written here (RFC 3533 pages, RFC 7845 for Opus in OGG):
 * an `OpusHead` page, an `OpusTags` page, then the audio packets, about a
 * second per page, the last one flagged end-of-stream. Telegram plays the
 * result as a voice note.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/** The rates libopus takes as input. Kokoro speaks at 24 kHz. */
export type OpusRate = 8000 | 12000 | 16000 | 24000 | 48000;

export interface OggOpusOptions {
  /** Bits per second; 24 kbps mono is a clear voice note. */
  bitrate?: number;
  /** The encoder name written into `OpusTags`. */
  vendor?: string;
}

/** Granule positions and pre-skip are counted at 48 kHz whatever the input rate (RFC 7845 §4). */
const GRANULE_RATE = 48_000;
/** libopus's look-ahead at 48 kHz for the VoIP and audio applications: 6.5 ms. */
export const PRE_SKIP = 312;
const FRAME_MS = 20;
const OPUS_APPLICATION_VOIP = 2048;
const OPUS_SET_BITRATE = 4002;
const OPUS_SET_SIGNAL = 4024;
const OPUS_SIGNAL_VOICE = 3001;

/* ------------------------------------------------------------------ *
 * The OGG page writer
 * ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let j = 0; j < 8; j++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
    table[i] = r >>> 0;
  }
  return table;
})();

/** OGG's CRC-32: polynomial 0x04c11db7, not reflected, initial value 0. */
export function oggCrc(bytes: Uint8Array): number {
  let crc = 0;
  for (let i = 0; i < bytes.length; i++) crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ bytes[i]!) & 0xff]!) >>> 0;
  return crc >>> 0;
}

export const PAGE_BOS = 0x02;
export const PAGE_EOS = 0x04;

/** One OGG page holding whole packets (none continued across pages). */
export function oggPage(packets: Uint8Array[], opts: { serial: number; sequence: number; granule: bigint; flags: number }): Buffer {
  const lacing: number[] = [];
  for (const packet of packets) {
    let left = packet.length;
    while (left >= 255) { lacing.push(255); left -= 255; }
    lacing.push(left);
  }
  if (lacing.length > 255) throw new Error('an OGG page holds at most 255 segments');
  const bodyLength = packets.reduce((n, p) => n + p.length, 0);
  const page = Buffer.alloc(27 + lacing.length + bodyLength);
  page.write('OggS', 0, 'latin1');
  page[4] = 0; // version
  page[5] = opts.flags;
  page.writeBigInt64LE(opts.granule, 6);
  page.writeUInt32LE(opts.serial >>> 0, 14);
  page.writeUInt32LE(opts.sequence >>> 0, 18);
  // CRC at 22, zero while it is computed.
  page[26] = lacing.length;
  for (let i = 0; i < lacing.length; i++) page[27 + i] = lacing[i]!;
  let at = 27 + lacing.length;
  for (const packet of packets) { page.set(packet, at); at += packet.length; }
  page.writeUInt32LE(oggCrc(page), 22);
  return page;
}

/** The segments a packet takes in a page's lacing table. */
function segmentsOf(packet: Uint8Array): number {
  return Math.floor(packet.length / 255) + 1;
}

export function opusHead(inputRate: number, channels = 1): Buffer {
  const head = Buffer.alloc(19);
  head.write('OpusHead', 0, 'latin1');
  head[8] = 1; // version
  head[9] = channels;
  head.writeUInt16LE(PRE_SKIP, 10);
  head.writeUInt32LE(inputRate, 12);
  head.writeInt16LE(0, 16); // output gain
  head[18] = 0; // channel mapping family 0: mono or stereo
  return head;
}

export function opusTags(vendor: string): Buffer {
  const v = Buffer.from(vendor, 'utf8');
  const tags = Buffer.alloc(8 + 4 + v.length + 4);
  tags.write('OpusTags', 0, 'latin1');
  tags.writeUInt32LE(v.length, 8);
  v.copy(tags, 12);
  tags.writeUInt32LE(0, 12 + v.length); // no comments
  return tags;
}

/** Mux Opus packets of `frameSamples48k` each (at 48 kHz) into an OGG stream. */
export function muxOggOpus(packets: Uint8Array[], opts: { inputRate: number; frameSamples48k: number; totalSamples48k: number; vendor: string; serial?: number }): Buffer {
  const serial = opts.serial ?? ((Math.random() * 0xffffffff) >>> 0);
  const pages: Buffer[] = [
    oggPage([opusHead(opts.inputRate)], { serial, sequence: 0, granule: 0n, flags: PAGE_BOS }),
    oggPage([opusTags(opts.vendor)], { serial, sequence: 1, granule: 0n, flags: 0 }),
  ];
  let sequence = 2;
  let page: Uint8Array[] = [];
  let segments = 0;
  let done = 0;
  // The final granule is the real length plus pre-skip, so a player trims the padding of the last frame.
  const end = BigInt(PRE_SKIP + opts.totalSamples48k);
  const flush = (last: boolean) => {
    const reached = BigInt(PRE_SKIP + done * opts.frameSamples48k);
    const granule = last ? (reached < end ? reached : end) : reached;
    pages.push(oggPage(page, { serial, sequence: sequence++, granule, flags: last ? PAGE_EOS : 0 }));
    page = [];
    segments = 0;
  };
  for (let i = 0; i < packets.length; i++) {
    const packet = packets[i]!;
    // About one second a page at 20 ms frames, and never past 255 segments.
    if (page.length > 0 && (page.length >= 50 || segments + segmentsOf(packet) > 255)) flush(false);
    page.push(packet);
    segments += segmentsOf(packet);
    done += 1;
  }
  if (page.length > 0) flush(true);
  else pages.push(oggPage([], { serial, sequence: sequence++, granule: end, flags: PAGE_EOS }));
  return Buffer.concat(pages);
}

/* ------------------------------------------------------------------ *
 * The encoder
 * ------------------------------------------------------------------ */

interface OpusScriptInstance {
  encode(pcm: Buffer, frameSize: number): Buffer;
  encoderCTL(ctl: number, arg: number): void;
  delete(): void;
}
type OpusScriptClass = new (rate: number, channels: number, application: number) => OpusScriptInstance;

let OpusScript: OpusScriptClass | undefined;

/** Float PCM (−1…1, mono) at `rate` to an OGG/Opus file. */
export function encodeOggOpus(pcm: Float32Array, rate: OpusRate, options: OggOpusOptions = {}): Buffer {
  OpusScript ??= require('opusscript') as OpusScriptClass;
  const encoder = new OpusScript(rate, 1, OPUS_APPLICATION_VOIP);
  try {
    encoder.encoderCTL(OPUS_SET_BITRATE, options.bitrate ?? 24_000);
    encoder.encoderCTL(OPUS_SET_SIGNAL, OPUS_SIGNAL_VOICE);
    const frame = (rate * FRAME_MS) / 1000;
    const packets: Uint8Array[] = [];
    const block = Buffer.alloc(frame * 2);
    for (let start = 0; start < pcm.length; start += frame) {
      block.fill(0);
      const end = Math.min(start + frame, pcm.length);
      for (let i = start; i < end; i++) {
        const s = Math.max(-1, Math.min(1, pcm[i]!));
        block.writeInt16LE(Math.round(s < 0 ? s * 0x8000 : s * 0x7fff), (i - start) * 2);
      }
      packets.push(Uint8Array.from(encoder.encode(block, frame)));
    }
    const factor = GRANULE_RATE / rate;
    return muxOggOpus(packets, {
      inputRate: rate,
      frameSamples48k: frame * factor,
      totalSamples48k: pcm.length * factor,
      vendor: options.vendor ?? 'buddi speech (libopus 1.4)',
    });
  } finally {
    encoder.delete();
  }
}
