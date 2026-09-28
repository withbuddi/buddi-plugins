/**
 * A zip of a folder, for the owner's "Download as archive".
 *
 * Written here rather than pulled in: the format needed is the plain one —
 * a local header and the bytes per file, a central directory, an end record —
 * and it is fifty lines against a dependency and its own transitive ones.
 * Deflate comes from `node:zlib`, and so does the CRC.
 *
 * No zip64: the archive is capped far below what needs it (`ARCHIVE_LIMITS`),
 * and a folder over either cap is refused with the cap named rather than cut
 * short.
 */
import { crc32, deflateRawSync } from 'node:zlib';

/**
 * What one archive may hold before it is refused: 100 MB of files,
 * uncompressed, and 5,000 of them. An object so a test can lower it.
 */
export const ARCHIVE_LIMITS = { bytes: 100 * 1024 * 1024, files: 5_000 };

export interface ZipEntry {
  /** The path inside the archive, forward slashes, no leading slash. */
  name: string;
  data: Buffer;
  mtime: Date;
}

/** MS-DOS time and date, which is what a zip header holds. */
function dosTime(date: Date): { time: number; date: number } {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

export function zip(entries: readonly ZipEntry[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const crc = crc32(entry.data) >>> 0;
    const deflated = deflateRawSync(entry.data);
    // Stored when deflate does not help: an image or an archive inside one.
    const stored = deflated.length >= entry.data.length;
    const body = stored ? entry.data : deflated;
    const method = stored ? 0 : 8;
    const { time, date } = dosTime(entry.mtime);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // names are UTF-8
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    parts.push(local, name, body);

    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(0x0800, 8);
    record.writeUInt16LE(method, 10);
    record.writeUInt16LE(time, 12);
    record.writeUInt16LE(date, 14);
    record.writeUInt32LE(crc, 16);
    record.writeUInt32LE(body.length, 20);
    record.writeUInt32LE(entry.data.length, 24);
    record.writeUInt16LE(name.length, 28);
    record.writeUInt32LE(offset, 42);
    central.push(record, name);

    offset += local.length + name.length + body.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, end]);
}
