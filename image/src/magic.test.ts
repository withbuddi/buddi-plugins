import { describe, expect, it } from 'vitest';
import { sniffImage } from './magic.js';
import { PNG_1x1, pngOf } from './testing/fixtures.js';

describe('sniffImage', () => {
  it('reads a PNG and its size from IHDR', () => {
    expect(sniffImage(PNG_1x1)).toEqual({ mime: 'image/png', width: 1, height: 1 });
    expect(sniffImage(pngOf(1536, 1024))).toEqual({ mime: 'image/png', width: 1536, height: 1024 });
  });

  it('reads JPEG, GIF and WebP headers', () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0xe0, 0x02, 0x80, 0x03]);
    expect(sniffImage(jpeg)).toEqual({ mime: 'image/jpeg', width: 640, height: 480 });
    const gif = Buffer.from('GIF89a\x10\x00\x20\x00', 'latin1');
    expect(sniffImage(gif)).toEqual({ mime: 'image/gif', width: 16, height: 32 });
    const webp = Buffer.alloc(30);
    webp.write('RIFF', 0, 'latin1'); webp.write('WEBPVP8X', 8, 'latin1');
    webp.writeUIntLE(99, 24, 3); webp.writeUIntLE(49, 27, 3);
    expect(sniffImage(webp)).toEqual({ mime: 'image/webp', width: 100, height: 50 });
  });

  it('refuses anything else, whatever it is called', () => {
    expect(sniffImage(Buffer.from('I could not draw that'))).toBeNull();
    expect(sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
    expect(sniffImage(Buffer.alloc(0))).toBeNull();
  });
});
