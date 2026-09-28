/** Shared by the tests: real audio headers, the bundled clip, and a fake audio server. */
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, open, writeFile } from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import { COMPANIONS, LOCAL_MODELS, type LocalKind, type LocalModel } from '../local/models.js';
import { TEST_CLIP } from '../settings.js';

/** The two-second OGG/Opus clip the page's listening Test sends. */
export const OGG_CLIP = readFileSync(TEST_CLIP);

/**
 * A voice as a speaker would send it: the clip with a random tail, so two
 * utterances are two files (the library keeps one copy of identical bytes).
 */
export function freshVoice(): Buffer {
  return Buffer.concat([OGG_CLIP, randomBytes(16)]);
}

/** An MP3 that starts with an ID3 tag, and one that starts at a frame sync. */
export const MP3_ID3 = Buffer.concat([Buffer.from('ID3'), Buffer.from([3, 0, 0, 0, 0, 0, 0]), Buffer.alloc(32)]);
export const MP3_SYNC = Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x64]), Buffer.alloc(32)]);
/** Raw ADTS AAC, which OpenAI's `aac` format is. */
export const AAC_ADTS = Buffer.concat([Buffer.from([0xff, 0xf1, 0x50, 0x80]), Buffer.alloc(32)]);
/** An MP4/M4A box header. */
export const M4A = Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from('ftypM4A '), Buffer.alloc(24)]);
export const WAV = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x24, 0, 0, 0]), Buffer.from('WAVEfmt '), Buffer.alloc(24)]);

export interface Seen {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

export interface FakeAudioServer {
  base: string;
  seen: Seen[];
  answer: (req: Seen) => { status: number; type?: string; body: string | Buffer; delayMs?: number };
  close(): Promise<void>;
}

/** A local server that speaks `/audio/transcriptions` and `/audio/speech` as the test says. */
export async function fakeAudioServer(): Promise<FakeAudioServer> {
  const state: FakeAudioServer = {
    base: '',
    seen: [],
    answer: (req) => req.url.endsWith('/audio/speech')
      ? { status: 200, type: 'audio/ogg', body: freshVoice() }
      : { status: 200, body: JSON.stringify({ text: 'Hello from buddi. This is a test.' }) },
    close: async () => {},
  };
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const entry = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks) };
      state.seen.push(entry);
      const out = state.answer(entry);
      const reply = () => {
        res.statusCode = out.status;
        res.setHeader('content-type', out.type ?? 'application/json');
        res.end(out.body);
      };
      if (out.delayMs) setTimeout(reply, out.delayMs);
      else reply();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  state.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  state.close = () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); });
  return state;
}

/* ------------------------------------------------------------------ *
 * Local models without the models
 * ------------------------------------------------------------------ */

/**
 * A model directory that `isInstalled` accepts: the marker and every file at
 * its manifest size, sparse, so a 150 MB file costs nothing. Nothing can run
 * on it; it is for the page, the defaults and Remove.
 */
export async function fakeInstalled(dir: string, kind: LocalKind, options: { companions?: boolean } = {}): Promise<void> {
  const parts = [LOCAL_MODELS[kind], ...(options.companions === false ? [] : COMPANIONS[kind])];
  for (const model of parts) {
    const target = path.join(dir, model.dir);
    for (const file of model.unpack ?? model.files) {
      const out = path.join(target, file.path);
      await mkdir(path.dirname(out), { recursive: true });
      const handle = await open(out, 'w');
      await handle.truncate(file.bytes);
      await handle.close();
    }
    await writeFile(path.join(target, '.installed.json'), JSON.stringify({ repo: model.repo, commit: model.commit, bytes: 0, installedAt: 'test' }));
  }
}

export interface FakeModelServer {
  base: string;
  model: LocalModel;
  /** Requests seen, by path. */
  seen: string[];
  /** Serve these bytes for this path instead (a tampered file). */
  tamper: Map<string, Buffer>;
  close(): Promise<void>;
}

/** A local server with small fake model files, and a manifest pointing at it with their real hashes. */
export async function fakeModelServer(kind: LocalKind = 'kokoro'): Promise<FakeModelServer> {
  const files = new Map<string, Buffer>([
    ['config.json', Buffer.from('{"model_type":"fake"}')],
    ['tokenizer.json', Buffer.from('{"fake":true}')],
    ['onnx/model_quantized.onnx', randomBytes(300_000)],
  ]);
  const state: FakeModelServer = { base: '', model: undefined as unknown as LocalModel, seen: [], tamper: new Map(), close: async () => {} };
  const server = http.createServer((req, res) => {
    const name = decodeURIComponent((req.url ?? '').replace(/^\/files\//, ''));
    state.seen.push(name);
    const body = state.tamper.get(name) ?? files.get(name);
    if (!body) { res.statusCode = 404; res.end('no'); return; }
    res.setHeader('content-length', String(body.length));
    // In two pieces, so progress moves within a file.
    const half = Math.floor(body.length / 2);
    res.write(body.subarray(0, half));
    setTimeout(() => res.end(body.subarray(half)), 5);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  state.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  state.model = {
    kind,
    label: 'Fake model',
    repo: 'test/fake',
    commit: 'c0ffee',
    dir: LOCAL_MODELS[kind].dir,
    files: [...files].map(([name, bytes]) => ({
      path: name,
      url: `${state.base}/files/${encodeURIComponent(name)}`,
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    })),
  };
  state.close = () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); });
  return state;
}

/** A gzipped ustar tarball holding these files, as an npm package is packed. */
export function fakeTarball(files: Record<string, Buffer>): Buffer {
  const blocks: Buffer[] = [];
  for (const [name, body] of Object.entries(files)) {
    const header = Buffer.alloc(512);
    header.write(name, 0, 100, 'utf8');
    header.write('0000644\0', 100);
    header.write('0000000\0', 108);
    header.write('0000000\0', 116);
    header.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124);
    header.write('00000000000\0', 136);
    header.write('        ', 148);
    header.write('0', 156);
    header.write('ustar\0' + '00', 257);
    let sum = 0;
    for (const b of header) sum += b;
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
    blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}
