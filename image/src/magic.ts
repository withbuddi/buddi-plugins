/**
 * What a file is, read from its first bytes and never from its name or from
 * what a backend said it was. Only the four raster formats the canvas and the
 * Files library draw are accepted; anything else — an SVG, an HTML page, a
 * text file a model wrote instead of a picture — is not an image here.
 */
export type ImageMime = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';

export interface Sniffed {
  mime: ImageMime;
  width?: number;
  height?: number;
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export const EXTENSIONS: Record<ImageMime, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

/** The image type and, when the header says, its size. `null`: not an image. */
export function sniffImage(bytes: Buffer): Sniffed | null {
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(PNG)) {
    // IHDR is always the first chunk: width and height at 16 and 20.
    return { mime: 'image/png', ...(bytes.toString('latin1', 12, 16) === 'IHDR' ? { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) } : {}) };
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { mime: 'image/jpeg', ...jpegSize(bytes) };
  }
  if (bytes.length >= 16 && bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP') {
    return { mime: 'image/webp', ...webpSize(bytes) };
  }
  if (bytes.length >= 10 && /^GIF8[79]a$/.test(bytes.toString('latin1', 0, 6))) {
    return { mime: 'image/gif', width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
  }
  return null;
}

function jpegSize(bytes: Buffer): { width?: number; height?: number } {
  let at = 2;
  while (at + 9 < bytes.length) {
    if (bytes[at] !== 0xff) return {};
    const marker = bytes[at + 1]!;
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { at += 2; continue; }
    const length = bytes.readUInt16BE(at + 2);
    // SOF0..SOF15, except DHT (C4), JPG (C8) and DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { height: bytes.readUInt16BE(at + 5), width: bytes.readUInt16BE(at + 7) };
    }
    at += 2 + length;
  }
  return {};
}

function webpSize(bytes: Buffer): { width?: number; height?: number } {
  const chunk = bytes.toString('latin1', 12, 16);
  if (chunk === 'VP8X' && bytes.length >= 30) {
    return { width: 1 + bytes.readUIntLE(24, 3), height: 1 + bytes.readUIntLE(27, 3) };
  }
  if (chunk === 'VP8L' && bytes.length >= 25) {
    const bits = bytes.readUInt32LE(21);
    return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
  }
  if (chunk === 'VP8 ' && bytes.length >= 30) {
    return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
  }
  return {};
}
