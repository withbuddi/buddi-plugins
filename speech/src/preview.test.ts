/**
 * The sample's five-second cap: whole Ogg pages, the last marked end-of-stream.
 */
import { describe, expect, it } from 'vitest';
import { muxOggOpus, oggCrc, PAGE_EOS, PRE_SKIP } from './local/ogg-opus.js';
import { trimOgg } from './preview.js';

/** Twelve seconds of 20 ms "frames": a page a second, 50 frames each. */
const twelveSeconds = (): Buffer =>
  muxOggOpus(Array.from({ length: 600 }, () => new Uint8Array([0xfc, 1, 2])), {
    inputRate: 24000, frameSamples48k: 960, totalSamples48k: 600 * 960, vendor: 'test', serial: 7,
  });

/** Each page's granule, flags and whether its CRC holds. */
function pages(bytes: Buffer): Array<{ granule: bigint; flags: number; crcOk: boolean }> {
  const out: Array<{ granule: bigint; flags: number; crcOk: boolean }> = [];
  let at = 0;
  while (at < bytes.length) {
    const segments = bytes[at + 26]!;
    let body = 0;
    for (let i = 0; i < segments; i++) body += bytes[at + 27 + i]!;
    const page = Buffer.from(bytes.subarray(at, at + 27 + segments + body));
    const crc = page.readUInt32LE(22);
    page.writeUInt32LE(0, 22);
    out.push({ granule: bytes.readBigInt64LE(at + 6), flags: bytes[at + 5]!, crcOk: oggCrc(page) === crc });
    at += 27 + segments + body;
  }
  return out;
}

describe('trimOgg', () => {
  it('keeps the pages that end by five seconds, and ends the stream on the last one', () => {
    const trimmed = pages(trimOgg(twelveSeconds(), 5));
    expect(trimmed.at(-1)!.granule).toBe(BigInt(PRE_SKIP + 5 * 48_000));
    expect(trimmed.at(-1)!.flags & PAGE_EOS).toBe(PAGE_EOS);
    expect(trimmed.every((p) => p.crcOk)).toBe(true);
    // The two header pages and five seconds of audio.
    expect(trimmed).toHaveLength(7);
  });

  it('leaves a short sample, and anything that is not Ogg, as it came', () => {
    const short = muxOggOpus([new Uint8Array([0xfc, 1])], { inputRate: 24000, frameSamples48k: 960, totalSamples48k: 960, vendor: 'test', serial: 7 });
    expect(trimOgg(short, 5)).toBe(short);
    const mp3 = Buffer.from('ID3 not ogg at all');
    expect(trimOgg(mp3, 5)).toBe(mp3);
  });
});
