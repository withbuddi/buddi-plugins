/** Audio is what its first bytes say, never what a name or a backend claims. */
import { describe, expect, it } from 'vitest';
import { isOggOpus, sniffAudio } from './magic.js';
import { AAC_ADTS, M4A, MP3_ID3, MP3_SYNC, OGG_CLIP, WAV } from './testing/fixtures.js';

describe('sniffAudio', () => {
  it('knows the containers the services send and take', () => {
    expect(sniffAudio(OGG_CLIP)).toBe('audio/ogg');
    expect(isOggOpus(OGG_CLIP)).toBe(true);
    expect(sniffAudio(MP3_ID3)).toBe('audio/mpeg');
    expect(sniffAudio(MP3_SYNC)).toBe('audio/mpeg');
    expect(sniffAudio(AAC_ADTS)).toBe('audio/aac');
    expect(sniffAudio(M4A)).toBe('audio/mp4');
    expect(sniffAudio(WAV)).toBe('audio/wav');
    expect(sniffAudio(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0]))).toBe('audio/webm');
    expect(sniffAudio(Buffer.from('fLaC\0\0\0\x22'))).toBe('audio/flac');
  });

  it('refuses what is not audio: an error page, JSON, a picture, too little', () => {
    expect(sniffAudio(Buffer.from('<!doctype html><title>502</title>'))).toBeNull();
    expect(sniffAudio(Buffer.from('{"error":{"message":"no"}}'))).toBeNull();
    expect(sniffAudio(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBeNull();
    expect(sniffAudio(Buffer.from([0xff]))).toBeNull();
    expect(isOggOpus(MP3_ID3)).toBe(false);
  });
});
