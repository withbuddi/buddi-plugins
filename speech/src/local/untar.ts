/**
 * The few files wanted from a gzipped tarball (an npm package), read in
 * memory: ustar headers of 512 bytes, each followed by its data padded to
 * 512. Regular files only; pax and GNU long-name records are skipped (an npm
 * tarball's short paths need neither).
 */
import { gunzipSync } from 'node:zlib';

export function untarFiles(tgz: Buffer, wanted: readonly string[]): Map<string, Buffer> {
  const tar = gunzipSync(tgz);
  const want = new Set(wanted);
  const out = new Map<string, Buffer>();
  let at = 0;
  while (at + 512 <= tar.length) {
    const header = tar.subarray(at, at + 512);
    if (header.every((b) => b === 0)) break;
    const field = (start: number, length: number) => header.toString('utf8', start, start + length).replace(/\0.*$/s, '');
    const name = field(0, 100);
    const prefix = field(345, 155);
    const size = parseInt(field(124, 12).trim() || '0', 8);
    const type = String.fromCharCode(header[156]!);
    const full = prefix ? `${prefix}/${name}` : name;
    const start = at + 512;
    if ((type === '0' || type === '\0') && want.has(full)) out.set(full, Buffer.from(tar.subarray(start, start + size)));
    at = start + Math.ceil(size / 512) * 512;
  }
  return out;
}
