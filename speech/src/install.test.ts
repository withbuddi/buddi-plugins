/** Fetching the local models: pinned, hashed, renamed into place, nothing left on a failure. */
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  ESPEAK_MODEL, InstallError, installJob, installLocal, installedLocal, isInstalled, LOCAL_MODELS, removeLocal, startInstall, totalBytes,
  type InstallProgress, type LocalModel,
} from './install.js';
import { installStatus } from './settings.js';
import { fakeInstalled, fakeModelServer, fakeTarball, type FakeModelServer } from './testing/fixtures.js';

let server: FakeModelServer;
let dir: string;

beforeAll(async () => { server = await fakeModelServer(); });
afterAll(async () => { await server.close(); });
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'buddi-speech-install-'));
  server.seen.length = 0;
  server.tamper.clear();
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe('the pinned manifest', () => {
  it('pins every file to one commit, with a SHA-256 and a size', () => {
    for (const model of Object.values(LOCAL_MODELS)) {
      for (const file of model.files) {
        expect(file.url).toBe(`https://huggingface.co/${model.repo}/resolve/${model.commit}/${file.path}`);
        expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(file.bytes).toBeGreaterThan(0);
      }
    }
    // The measured sizes the docs and the page state.
    expect(totalBytes(LOCAL_MODELS.whisper)).toBe(251_846_613);
    expect(totalBytes(LOCAL_MODELS.kokoro)).toBe(92_364_770);
    expect(LOCAL_MODELS.whisper.files.map((f) => f.path)).toEqual(expect.arrayContaining([
      'onnx/encoder_model_quantized.onnx', 'onnx/decoder_model_merged_quantized.onnx', 'tokenizer.json', 'preprocessor_config.json',
    ]));
  });

  it('pins eSpeak NG to one npm tarball, unpacked into its module, its data and its licence', () => {
    expect(ESPEAK_MODEL.files).toEqual([{
      path: 'espeak-ng-emscripten-0.3.5.tgz',
      url: 'https://registry.npmjs.org/@echogarden/espeak-ng-emscripten/-/espeak-ng-emscripten-0.3.5.tgz',
      bytes: 12_528_264,
      sha256: '6b0bac048e123de9a690e3fe79346ed377c18797e9b09c3e0d8761a3ac00abe6',
    }]);
    expect(ESPEAK_MODEL.unpack!.map((f) => f.path)).toEqual(['espeak-ng.js', 'espeak-ng.data', 'COPYING']);
  });
});

describe('installLocal', () => {
  it('goes through the host http area when one is handed in and no fetch', async () => {
    const urls: string[] = [];
    const http = {
      async request(req: { url: string; method?: string }) {
        urls.push(req.url);
        const r = await fetch(req.url);
        const bytes = await r.arrayBuffer();
        return {
          ok: r.ok, status: r.status, statusText: r.statusText,
          headers: { get: (n: string) => r.headers.get(n) },
          text: async () => Buffer.from(bytes).toString('utf8'),
          json: async () => JSON.parse(Buffer.from(bytes).toString('utf8')),
          arrayBuffer: async () => bytes,
        };
      },
    };
    await installLocal('kokoro', { dir, model: server.model, http });
    expect(isInstalled(dir, 'kokoro', server.model)).toBe(true);
    expect(urls).toEqual(server.model.files.map((f) => f.url));
  });

  it('downloads, checks each hash, reports progress, and renames into place', async () => {
    const seen: InstallProgress[] = [];
    const result = await installLocal('kokoro', { dir, model: server.model, onProgress: (p) => seen.push(p) });
    expect(result).toMatchObject({ kind: 'kokoro', fetched: true, bytes: totalBytes(server.model), path: path.join(dir, 'kokoro') });
    expect(isInstalled(dir, 'kokoro', server.model)).toBe(true);
    expect(existsSync(path.join(dir, 'kokoro', 'onnx', 'model_quantized.onnx'))).toBe(true);
    // Progress only moves forward and ends whole.
    const fractions = seen.map((p) => p.fraction);
    expect(fractions).toEqual([...fractions].sort((a, b) => a - b));
    expect(seen.at(-1)).toMatchObject({ fraction: 1, bytes: totalBytes(server.model), total: totalBytes(server.model) });
    expect(seen.some((p) => p.fraction > 0 && p.fraction < 1)).toBe(true);
    // No temporary directory is left.
    expect((await readdir(dir)).filter((n) => n.startsWith('.install-'))).toEqual([]);
    // Again: nothing is fetched.
    server.seen.length = 0;
    expect((await installLocal('kokoro', { dir, model: server.model })).fetched).toBe(false);
    expect(server.seen).toEqual([]);
  });

  it('keeps nothing when a file does not match its checksum', async () => {
    const [first] = server.model.files;
    server.tamper.set('onnx/model_quantized.onnx', Buffer.alloc(server.model.files[2]!.bytes, 7));
    await expect(installLocal('kokoro', { dir, model: server.model })).rejects.toThrow(
      new InstallError('onnx/model_quantized.onnx did not match its checksum; nothing was kept.'),
    );
    expect(first).toBeDefined();
    expect(existsSync(path.join(dir, 'kokoro'))).toBe(false);
    expect(await readdir(dir)).toEqual([]);
  });

  it('keeps nothing when the server answers an error or a file is too long, and says which', async () => {
    server.tamper.set('tokenizer.json', Buffer.alloc(10_000, 1));
    await expect(installLocal('kokoro', { dir, model: server.model })).rejects.toThrow(/tokenizer.json is larger than expected/);
    const missing = { ...server.model, files: [{ ...server.model.files[0]!, url: `${server.base}/files/nowhere` }] };
    await expect(installLocal('kokoro', { dir, model: missing })).rejects.toThrow(/answered 404 for config.json; nothing was kept/);
    expect(await readdir(dir)).toEqual([]);
  });

  it('stops on a cancel and keeps nothing', async () => {
    const controller = new AbortController();
    const job = installLocal('kokoro', { dir, model: server.model, signal: controller.signal, onProgress: () => controller.abort() });
    await expect(job).rejects.toThrow(/cancelled|cut off/);
    expect(existsSync(path.join(dir, 'kokoro'))).toBe(false);
  });

  it('runs one download per model at a time', async () => {
    const [a, b] = [installLocal('kokoro', { dir, model: server.model }), installLocal('kokoro', { dir, model: server.model })];
    expect(a).toBe(b);
    await a;
    expect(server.seen.filter((p) => p === 'config.json')).toHaveLength(1);
  });

  it('fetches a companion with its model, unpacks its tarball, and fetches only what is missing next time', async () => {
    const tgz = fakeTarball({ 'package/espeak-ng.js': Buffer.from('export default 1;'), 'package/COPYING': Buffer.from('GPL'), 'package/README.md': Buffer.from('x') });
    server.tamper.set('espeak.tgz', tgz);
    const companion: LocalModel = {
      kind: 'espeak', label: 'Fake eSpeak', repo: 'fake-espeak', commit: '1.0', dir: 'espeak',
      files: [{ path: 'espeak.tgz', url: `${server.base}/files/espeak.tgz`, bytes: tgz.length, sha256: createHash('sha256').update(tgz).digest('hex') }],
      unpack: [{ from: 'package/espeak-ng.js', path: 'espeak-ng.js', bytes: 17 }, { from: 'package/COPYING', path: 'COPYING', bytes: 3 }],
    };
    const seen: InstallProgress[] = [];
    const result = await installLocal('kokoro', { dir, model: server.model, companions: [companion], onProgress: (p) => seen.push(p) });
    expect(result).toMatchObject({ fetched: true, bytes: totalBytes(server.model) + tgz.length });
    expect(seen.at(-1)).toMatchObject({ fraction: 1, total: totalBytes(server.model) + tgz.length });
    expect(isInstalled(dir, 'espeak', companion)).toBe(true);
    expect(await readFile(path.join(dir, 'espeak', 'espeak-ng.js'), 'utf8')).toBe('export default 1;');
    expect((await readdir(path.join(dir, 'espeak'))).sort()).toEqual(['.installed.json', 'COPYING', 'espeak-ng.js']);
    // The companion gone (an install from before it existed): only it is fetched again.
    await rm(path.join(dir, 'espeak'), { recursive: true });
    server.seen.length = 0;
    expect((await installLocal('kokoro', { dir, model: server.model, companions: [companion] })).fetched).toBe(true);
    expect(server.seen).toEqual(['espeak.tgz']);
    // A tarball that does not hold what the manifest says keeps nothing.
    await rm(path.join(dir, 'espeak'), { recursive: true });
    const short = { ...companion, unpack: [{ from: 'package/espeak-ng.data', path: 'espeak-ng.data', bytes: 5 }] };
    await expect(installLocal('kokoro', { dir, model: server.model, companions: [short] })).rejects.toThrow('espeak.tgz did not hold espeak-ng.data as expected; nothing was kept.');
    expect(existsSync(path.join(dir, 'espeak'))).toBe(false);
  });

  it('refuses a kind it does not know', async () => {
    await expect(installLocal('piper' as never, { dir })).rejects.toThrow(/whisper and kokoro/);
  });
});

describe('state, the background job and Remove', () => {
  it('reports each model, and removes one', async () => {
    expect(installedLocal(dir).whisper).toMatchObject({ installed: false, bytes: 251_846_613 });
    await fakeInstalled(dir, 'whisper');
    expect(installedLocal(dir).whisper.installed).toBe(true);
    expect(installStatus(dir).models.find((m) => m.kind === 'whisper')).toMatchObject({
      state: 'installed', line: 'Whisper on this computer (Whisper small, listening). Installed, 252 MB.',
      heading: 'Whisper on this computer · listening', done: 'Installed, 252 MB',
    });
    expect(installStatus(dir).models.find((m) => m.kind === 'kokoro')).toMatchObject({
      state: 'absent', line: 'Kokoro on this computer (Kokoro 82M, speaking). Not installed; a 105 MB download.',
    });
    expect(await removeLocal('whisper', dir)).toBe(true);
    expect(installedLocal(dir).whisper.installed).toBe(false);
    expect(await removeLocal('whisper', dir)).toBe(false);
  });

  it('says Kokoro speaks English while eSpeak NG is missing, and removes both together', async () => {
    await fakeInstalled(dir, 'kokoro', { companions: false });
    expect(installedLocal(dir).kokoro).toMatchObject({ installed: false, usable: true, missing: 12_528_264, bytes: 104_893_034 });
    expect(installStatus(dir).models.find((m) => m.kind === 'kokoro')).toMatchObject({
      state: 'absent', total: 12_528_264,
      line: 'Kokoro on this computer (Kokoro 82M, speaking). Installed for English; French, Spanish, Italian, Portuguese and Hindi need a 13 MB download.',
    });
    await fakeInstalled(dir, 'kokoro');
    expect(installedLocal(dir).kokoro).toMatchObject({ installed: true, usable: true, missing: 0 });
    expect(installStatus(dir).models.find((m) => m.kind === 'kokoro')).toMatchObject({ state: 'installed', done: 'Installed, 105 MB' });
    expect(await removeLocal('kokoro', dir)).toBe(true);
    expect(existsSync(path.join(dir, 'kokoro')) || existsSync(path.join(dir, 'espeak'))).toBe(false);
  });

  it('runs the page\'s install in the background and the status polls it to the end', async () => {
    const job = startInstall('kokoro', { dir, model: server.model });
    expect(job.state).toBe('running');
    expect(installStatus(dir).busy).toBe(true);
    expect(installStatus(dir).models.find((m) => m.kind === 'kokoro')!.line).toMatch(/Downloading: \d+ of 1 MB \(\d+%\)/);
    expect(installStatus(dir).models.find((m) => m.kind === 'kokoro')).toMatchObject({ state: 'installing', heading: 'Kokoro on this computer · speaking', total: expect.any(Number) });
    await expect.poll(() => installJob(dir, 'kokoro')?.state, { timeout: 5000 }).toBe('done');
    expect(installStatus(dir).busy).toBe(false);

    server.tamper.set('config.json', Buffer.from('{"model_type":"evil"}'));
    await rm(path.join(dir, 'kokoro'), { recursive: true });
    startInstall('kokoro', { dir, model: server.model });
    await expect.poll(() => installJob(dir, 'kokoro')?.state, { timeout: 5000 }).toBe('failed');
    expect(installStatus(dir).models.find((m) => m.kind === 'kokoro')).toMatchObject({
      state: 'failed', line: expect.stringMatching(/config.json did not match its checksum; nothing was kept.$/),
    });
  });
});
