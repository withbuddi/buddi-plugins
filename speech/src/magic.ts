/**
 * What an audio file is, read from its first bytes and never from its name or
 * from what a backend or a surface said it was.
 *
 * Two uses. A recording handed to `speech.transcribe` must be audio a
 * listening service accepts (OGG, MP3, M4A/MP4, AAC, WAV, WebM, FLAC). What a
 * speaker sends back must be the container that was asked for: an HTML error
 * page or a JSON body with a 200 is a failure, not a voice note.
 */
export type AudioMime =
  | 'audio/ogg'
  | 'audio/mpeg'
  | 'audio/mp4'
  | 'audio/aac'
  | 'audio/wav'
  | 'audio/webm'
  | 'audio/flac';

export const AUDIO_EXTENSIONS: Record<AudioMime, string> = {
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'audio/wav': 'wav',
  'audio/webm': 'webm',
  'audio/flac': 'flac',
};

/** The audio container, or `null`: not audio this plugin knows. */
export function sniffAudio(bytes: Buffer): AudioMime | null {
  if (bytes.length < 4) return null;
  const ascii = (from: number, to: number): string => bytes.toString('latin1', from, to);
  if (ascii(0, 4) === 'OggS') return 'audio/ogg';
  if (ascii(0, 4) === 'fLaC') return 'audio/flac';
  if (ascii(0, 3) === 'ID3') return 'audio/mpeg';
  if (bytes.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE') return 'audio/wav';
  if (bytes.length >= 12 && ascii(4, 8) === 'ftyp') return 'audio/mp4';
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return 'audio/webm';
  if (bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0) {
    // A frame sync. The two layer bits tell MPEG audio (01, 10, 11) from ADTS AAC (00).
    const layer = (bytes[1]! >> 1) & 0x03;
    if (layer === 0) return (bytes[1]! & 0xf0) === 0xf0 ? 'audio/aac' : null;
    return 'audio/mpeg';
  }
  return null;
}

/** The format a speaker is asked for. */
export type SpeakFormat = 'ogg-opus' | 'mp3' | 'm4a';

/** Whether an OGG stream carries Opus: the first page's packet starts `OpusHead`. */
export function isOggOpus(bytes: Buffer): boolean {
  if (sniffAudio(bytes) !== 'audio/ogg' || bytes.length < 28) return false;
  const segments = bytes[26]!;
  const start = 27 + segments;
  return bytes.length >= start + 8 && bytes.toString('latin1', start, start + 8) === 'OpusHead';
}
