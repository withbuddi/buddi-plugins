/**
 * Fetching the local models: `installLocal`, `installedLocal`, `removeLocal`.
 *
 * Each file of the pinned manifest (`local/models.ts`) is downloaded into a
 * temporary directory inside the plugin's own, hashed as it streams, checked
 * against its SHA-256 and size, and only when every file matches is the
 * directory renamed into place (`<dir>/whisper`, `<dir>/kokoro`). A failed
 * hash, a cut connection or a cancel leaves nothing behind. The runtime then
 * reads these files and never fetches (`env.allowRemoteModels = false`).
 *
 * A model's companions (`COMPANIONS`: eSpeak NG with Kokoro) come with it:
 * installed, checked and removed together, each in its own directory with
 * its own marker, so an install made before a companion existed keeps
 * working (Kokoro speaks English) and the next install fetches only what is
 * missing.
 *
 * Two ways in, one code path: the Speech page's Install button
 * (`speech.install`, in the background, with `install_status` polled for the
 * progress line) and `buddi speech install`, which imports this function from
 * the installed plugin.
 */
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, readFileSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  COMPANIONS, ESPEAK_MODEL, LOCAL_KINDS, LOCAL_MODELS, megabytes, totalBytes, type LocalKind, type LocalModel, type LocalPart,
} from './local/models.js';
import { untarFiles } from './local/untar.js';
import type { HttpArea } from '@buddi/core/plugin';
import { DOWNLOAD_CAP, hostFetch } from './net.js';

export {
  COMPANIONS, ESPEAK_MODEL, LOCAL_KINDS, LOCAL_MODELS, megabytes, totalBytes, type LocalKind, type LocalModel, type LocalPart,
} from './local/models.js';

const MARKER = '.installed.json';

export interface InstallProgress {
  kind: LocalKind;
  /** 0…1 over every file of the model. */
  fraction: number;
  bytes: number;
  total: number;
  /** The file now downloading. */
  file: string;
}

export interface InstallOptions {
  /** The plugin's own directory (`ctx.buddi.dir.path`): `<data>/plugins-data/speech`. */
  dir: string;
  onProgress?: (progress: InstallProgress) => void;
  signal?: AbortSignal;
  /** A transport for tests, or the page's `hostFetch(ctx.buddi.http)`. */
  fetch?: typeof fetch;
  /**
   * The host's `http` area, when the caller has one and no `fetch`: what
   * `buddi speech install` hands in (an area that refuses a host the manifest
   * does not declare). With neither, the global `fetch` (an older buddi CLI).
   */
  http?: HttpArea;
  /** Another manifest, for tests. */
  model?: LocalModel;
  /** Other companions, for tests; with `model` given and these not, none. */
  companions?: readonly LocalModel[];
}

export interface InstallResult {
  kind: LocalKind;
  path: string;
  bytes: number;
  /** False when it was already there and nothing was fetched. */
  fetched: boolean;
}

/** A download that did not end in a verified model: one sentence. */
export class InstallError extends Error {}

export interface LocalState {
  kind: LocalKind;
  label: string;
  /** The model and its companions, all in place. */
  installed: boolean;
  /** The model itself in place, so it runs (Kokoro: English), companions or not. */
  usable: boolean;
  /** On disk when installed; the download size otherwise (companions included). */
  bytes: number;
  /** What is left to download: 0 once installed. */
  missing: number;
  path: string;
}

interface Marker {
  repo: string;
  commit: string;
  bytes: number;
  installedAt: string;
}

function manifestOf(kind: LocalPart): LocalModel {
  return kind === 'espeak' ? ESPEAK_MODEL : LOCAL_MODELS[kind];
}

export function modelDir(dir: string, kind: LocalPart, model: LocalModel = manifestOf(kind)): string {
  return path.join(dir, model.dir);
}

/** Whether a model or a part is in place: its marker names the pinned commit and every file has its size. */
export function isInstalled(dir: string, kind: LocalPart, model: LocalModel = manifestOf(kind)): boolean {
  const target = modelDir(dir, kind, model);
  try {
    // Synchronous on purpose: the page and the backends ask often and the marker is tiny.
    const marker = JSON.parse(readFileSync(path.join(target, MARKER), 'utf8')) as Marker;
    if (marker.commit !== model.commit || marker.repo !== model.repo) return false;
    return (model.unpack ?? model.files).every((f) => {
      const file = path.join(target, f.path);
      return existsSync(file) && statSync(file).size === f.bytes;
    });
  } catch {
    return false;
  }
}

/** A model and its companions, in the order they are fetched. */
function partsOf(kind: LocalKind, options: Pick<InstallOptions, 'model' | 'companions'> = {}): LocalModel[] {
  return [options.model ?? LOCAL_MODELS[kind], ...(options.companions ?? (options.model ? [] : COMPANIONS[kind]))];
}

/** A model's download with its companions. */
export function downloadBytes(kind: LocalKind): number {
  return partsOf(kind).reduce((n, m) => n + totalBytes(m), 0);
}

export function installedLocal(dir: string): Record<LocalKind, LocalState> {
  const out = {} as Record<LocalKind, LocalState>;
  for (const kind of LOCAL_KINDS) {
    const parts = partsOf(kind);
    const missing = parts.filter((m) => !isInstalled(dir, m.kind, m)).reduce((n, m) => n + totalBytes(m), 0);
    out[kind] = {
      kind,
      label: LOCAL_MODELS[kind].label,
      installed: missing === 0,
      usable: isInstalled(dir, kind),
      bytes: downloadBytes(kind),
      missing,
      path: modelDir(dir, kind),
    };
  }
  return out;
}

const running = new Map<string, Promise<InstallResult>>();

/** Download, verify and put a model in place. One at a time per model and directory. */
export function installLocal(kind: LocalKind, options: InstallOptions): Promise<InstallResult> {
  if (!LOCAL_KINDS.includes(kind)) return Promise.reject(new InstallError(`There is no local model called "${kind}"; the choices are whisper and kokoro.`));
  const key = `${options.dir}\0${kind}`;
  const current = running.get(key);
  if (current) return current;
  const job = doInstall(kind, options).finally(() => running.delete(key));
  running.set(key, job);
  return job;
}

async function doInstall(kind: LocalKind, options: InstallOptions): Promise<InstallResult> {
  const parts = partsOf(kind, options);
  const target = modelDir(options.dir, kind, parts[0]);
  const total = parts.reduce((n, m) => n + totalBytes(m), 0);
  const todo = parts.filter((m) => !isInstalled(options.dir, m.kind, m));
  if (todo.length === 0) return { kind, path: target, bytes: total, fetched: false };
  await mkdir(options.dir, { recursive: true });
  // What is already in place counts as done, so the bar starts where it is.
  let before = total - todo.reduce((n, m) => n + totalBytes(m), 0);
  for (const model of todo) {
    await installPart(model, options, (got) => {
      options.onProgress?.({ kind, fraction: total ? Math.min(1, (before + got.bytes) / total) : 1, bytes: before + got.bytes, total, file: got.file });
    });
    before += totalBytes(model);
  }
  options.onProgress?.({ kind, fraction: 1, bytes: total, total, file: '' });
  return { kind, path: target, bytes: total, fetched: true };
}

/** One part: every file into a temporary directory, checked, unpacked when it is a tarball, then renamed into place. */
async function installPart(model: LocalModel, options: InstallOptions, progress: (p: { bytes: number; file: string }) => void): Promise<void> {
  const target = modelDir(options.dir, model.kind, model);
  const temp = await mkdtemp(path.join(options.dir, `.install-${model.kind}-`));
  const doFetch = options.fetch ?? (options.http ? hostFetch(options.http, { maxBytes: DOWNLOAD_CAP }) : fetch);
  let before = 0;
  try {
    for (const file of model.files) {
      if (options.signal?.aborted) throw new InstallError('The download was cancelled; nothing was kept.');
      const out = path.join(temp, file.path);
      await mkdir(path.dirname(out), { recursive: true });
      let response: Response;
      try {
        response = await doFetch(file.url, { redirect: 'follow', ...(options.signal ? { signal: options.signal } : {}) });
      } catch {
        if (options.signal?.aborted) throw new InstallError('The download was cancelled; nothing was kept.');
        throw new InstallError(`Could not reach ${hostOf(file.url)} to fetch ${model.label}; nothing was kept.`);
      }
      if (!response.ok || !response.body) {
        throw new InstallError(`${hostOf(file.url)} answered ${response.status} for ${file.path}; nothing was kept.`);
      }
      const hash = createHash('sha256');
      let got = 0;
      const counted = Readable.fromWeb(response.body as import('node:stream/web').ReadableStream<Uint8Array>);
      counted.on('data', (chunk: Buffer) => {
        hash.update(chunk);
        got += chunk.length;
        if (got > file.bytes) counted.destroy(new InstallError(`${file.path} is larger than expected; nothing was kept.`));
        progress({ bytes: before + got, file: file.path });
      });
      try {
        await pipeline(counted, createWriteStream(out));
      } catch (error) {
        if (error instanceof InstallError) throw error;
        if (options.signal?.aborted) throw new InstallError('The download was cancelled; nothing was kept.');
        throw new InstallError(`The download of ${file.path} was cut off; nothing was kept.`);
      }
      const digest = hash.digest('hex');
      if (got !== file.bytes || digest !== file.sha256) {
        throw new InstallError(`${file.path} did not match its checksum; nothing was kept.`);
      }
      before += got;
    }
    if (model.unpack) await unpackInto(temp, model);
    const marker: Marker = { repo: model.repo, commit: model.commit, bytes: totalBytes(model), installedAt: new Date().toISOString() };
    await writeFile(path.join(temp, MARKER), JSON.stringify(marker, null, 2));
    // Out of the way first: a half-old directory, then the verified one in its place.
    if (existsSync(target)) {
      const old = `${target}.old-${process.pid}-${Date.now()}`;
      await rename(target, old);
      await rm(old, { recursive: true, force: true });
    }
    await rename(temp, target);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

/** The checked tarball's wanted files, each at its size, and the tarball gone. */
async function unpackInto(temp: string, model: LocalModel): Promise<void> {
  const tarball = path.join(temp, model.files[0]!.path);
  const wanted = model.unpack!;
  let files: Map<string, Buffer>;
  try {
    files = untarFiles(await readFile(tarball), wanted.map((f) => f.from));
  } catch {
    throw new InstallError(`${model.files[0]!.path} could not be unpacked; nothing was kept.`);
  }
  for (const f of wanted) {
    const body = files.get(f.from);
    if (!body || body.length !== f.bytes) throw new InstallError(`${model.files[0]!.path} did not hold ${f.path} as expected; nothing was kept.`);
    await mkdir(path.dirname(path.join(temp, f.path)), { recursive: true });
    await writeFile(path.join(temp, f.path), body);
  }
  await rm(tarball, { force: true });
}

/** Delete a model's directory, and its companions'. */
export async function removeLocal(kind: LocalKind, dir: string): Promise<boolean> {
  let removed = false;
  for (const model of partsOf(kind)) {
    const target = modelDir(dir, model.kind, model);
    if (!existsSync(target)) continue;
    await rm(target, { recursive: true, force: true });
    removed = true;
  }
  return removed;
}

function hostOf(url: string): string {
  try { return new URL(url).host; } catch { return 'the model host'; }
}

/* ------------------------------------------------------------------ *
 * The page's background job, one per model, polled by `install_status`
 * ------------------------------------------------------------------ */

export interface InstallJob {
  kind: LocalKind;
  state: 'running' | 'failed' | 'done';
  fraction: number;
  bytes: number;
  total: number;
  error?: string;
}

const jobs = new Map<string, InstallJob>();

/** Start a download in the background, or answer with the one running. */
export function startInstall(kind: LocalKind, options: InstallOptions & { onDone?: (result: InstallResult) => void | Promise<void> }): InstallJob {
  const key = `${options.dir}\0${kind}`;
  const existing = jobs.get(key);
  if (existing?.state === 'running') return existing;
  const job: InstallJob = { kind, state: 'running', fraction: 0, bytes: 0, total: partsOf(kind, options).reduce((n, m) => n + totalBytes(m), 0) };
  jobs.set(key, job);
  installLocal(kind, {
    ...options,
    onProgress: (p) => {
      job.fraction = p.fraction;
      job.bytes = p.bytes;
      job.total = p.total;
      options.onProgress?.(p);
    },
  })
    .then(async (result) => {
      job.state = 'done';
      job.fraction = 1;
      job.bytes = result.bytes;
      await options.onDone?.(result);
    })
    .catch((error: unknown) => {
      job.state = 'failed';
      job.error = error instanceof InstallError ? error.message : 'The download failed; nothing was kept.';
    });
  return job;
}

export function installJob(dir: string, kind: LocalKind): InstallJob | undefined {
  return jobs.get(`${dir}\0${kind}`);
}

/** Forget a finished job (after Remove, so the page does not say "failed" forever). */
export function clearInstallJob(dir: string, kind: LocalKind): void {
  const job = jobs.get(`${dir}\0${kind}`);
  if (job && job.state !== 'running') jobs.delete(`${dir}\0${kind}`);
}

/** The progress line: "Downloading: 41 of 92 MB (45%)". */
export function progressLine(job: Pick<InstallJob, 'bytes' | 'total' | 'fraction'>): string {
  return `Downloading: ${Math.round(job.bytes / 1_000_000)} of ${megabytes(job.total)} (${Math.floor(job.fraction * 100)}%)`;
}
