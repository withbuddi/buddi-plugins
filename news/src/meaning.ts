/**
 * The meaning model: a small multilingual sentence model on this computer,
 * which turns an article's title and lead into a vector, so stories cluster
 * by what they say and not only by the words they share (`cluster.ts`).
 *
 * paraphrase-multilingual-MiniLM-L12-v2 at int8 (Xenova's ONNX export,
 * `model_quantized.onnx`), 384 dimensions, mean pooled and normalised: about
 * 135 MB with its tokenizer. Chosen over multilingual-e5-small, the same size:
 * on this plugin's fixtures e5 put two different stories told in the same
 * words (0.85–0.94) above one story told by six outlets (0.88), while MiniLM,
 * trained on paraphrases across fifty languages, kept them at 0.35–0.50
 * against 0.75 and more, and an English and a French report of one event at
 * 0.76–0.91.
 *
 * Like the speech plugin's models: every file pinned to a commit, its size and
 * SHA-256 checked as it arrives, into a temporary directory renamed into place
 * only when all match, under the plugin's own directory
 * (`<data>/plugins-data/news/meaning`). Nothing is fetched until the owner
 * presses Download on Settings → News (the size is on the button, and a
 * confirmation before it starts). The runtime is onnxruntime-node, the
 * tokenizer Hugging Face's own JavaScript one, both loaded only when the
 * model is: an install without it never loads either.
 *
 * Nothing here blocks the poller: `ready()` answers the loaded model or
 * nothing at once, starting the load in the background the first time.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { HttpArea } from '@buddi/core/plugin';
import type { Embedder } from './embed.js';

export interface ModelFile {
  path: string;
  url: string;
  bytes: number;
  sha256: string;
}

const REPO = 'Xenova/paraphrase-multilingual-MiniLM-L12-v2';
const COMMIT = '2c4055b12046f11709e9df2c122e59ffbdc2f900';
const hf = (file: string): string => `https://huggingface.co/${REPO}/resolve/${COMMIT}/${file}`;

export const MEANING_MODEL = {
  /** What a stored vector names, so a vector from another model is never compared. */
  id: 'minilm-l12-multilingual-q8',
  label: 'Multilingual MiniLM',
  repo: REPO,
  commit: COMMIT,
  dir: 'meaning',
  dims: 384,
  /** The model was trained on 128 tokens; a title and a 600-character lead fit. */
  maxTokens: 128,
  files: [
    ['tokenizer_config.json', 496, '3f5961b9ac86288cccdb97f32fb848d6187c78e1603958c53f3ea1f296b7d8a2'],
    ['tokenizer.json', 17_082_913, 'b60b6b43406a48bf3638526314f3d232d97058bc93472ff2de930d43686fa441'],
    ['onnx/model_quantized.onnx', 118_308_126, '66fc00f5f29afcaff34092e1bdd20008ca3918265a82fb9695a551e510cc4ebc'],
  ].map(([file, bytes, sha256]) => ({ path: file as string, url: hf(file as string), bytes: bytes as number, sha256: sha256 as string })) as ModelFile[],
} as const;

export type MeaningModel = Omit<typeof MEANING_MODEL, 'files'> & { files: readonly ModelFile[] };

const MARKER = '.installed.json';
/** The most one file may be; the model is 118 MB. */
const DOWNLOAD_CAP = 200 * 1024 * 1024;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

export function modelBytes(model: MeaningModel = MEANING_MODEL): number {
  return model.files.reduce((n, f) => n + f.bytes, 0);
}

/** "135 MB": decimal megabytes, as a download is counted. */
export function megabytes(bytes: number): string {
  return `${Math.max(1, Math.round(bytes / 1_000_000))} MB`;
}

export function modelDir(dir: string, model: MeaningModel = MEANING_MODEL): string {
  return path.join(dir, model.dir);
}

/** In place: the marker names the pinned commit and every file has its size. */
export function isDownloaded(dir: string, model: MeaningModel = MEANING_MODEL): boolean {
  const target = modelDir(dir, model);
  try {
    const marker = JSON.parse(readFileSync(path.join(target, MARKER), 'utf8')) as { repo: string; commit: string };
    if (marker.repo !== model.repo || marker.commit !== model.commit) return false;
    return model.files.every((f) => {
      const file = path.join(target, f.path);
      return existsSync(file) && statSync(file).size === f.bytes;
    });
  } catch {
    return false;
  }
}

/** A download that did not end in a verified model: one sentence. */
export class DownloadError extends Error {}

function hostOf(url: string): string {
  try { return new URL(url).host; } catch { return 'the model host'; }
}

/** One file through the host's `http` area, following Hugging Face's redirect to its download servers. */
async function getFile(http: HttpArea, url: string): Promise<Buffer> {
  let at = url;
  for (let hop = 0; hop < 5; hop++) {
    let response;
    try {
      response = await http.request({ url: at, idleTimeoutMs: 60_000, maxBytes: DOWNLOAD_CAP });
    } catch (err) {
      throw new DownloadError(`Could not reach ${hostOf(at)}: ${err instanceof Error ? err.message : String(err)}. Nothing was kept.`);
    }
    const location = response.headers.get('location');
    if (REDIRECTS.has(response.status) && location) {
      at = new URL(location, at).toString();
      continue;
    }
    if (!response.ok) throw new DownloadError(`${hostOf(at)} answered ${response.status}. Nothing was kept.`);
    return Buffer.from(await response.arrayBuffer());
  }
  throw new DownloadError(`${hostOf(url)} redirected too many times. Nothing was kept.`);
}

/** Every file into a temporary directory, checked, then renamed into place. */
export async function downloadModel(
  dir: string,
  http: HttpArea,
  onProgress: (bytes: number, total: number) => void = () => {},
  model: MeaningModel = MEANING_MODEL,
): Promise<void> {
  if (isDownloaded(dir, model)) return;
  await mkdir(dir, { recursive: true });
  const target = modelDir(dir, model);
  const temp = await mkdtemp(path.join(dir, '.download-meaning-'));
  const total = modelBytes(model);
  let done = 0;
  try {
    for (const file of model.files) {
      const body = await getFile(http, file.url);
      const digest = createHash('sha256').update(body).digest('hex');
      if (body.length !== file.bytes || digest !== file.sha256) throw new DownloadError(`${file.path} did not match its checksum. Nothing was kept.`);
      const out = path.join(temp, file.path);
      await mkdir(path.dirname(out), { recursive: true });
      await writeFile(out, body);
      done += body.length;
      onProgress(done, total);
    }
    await writeFile(path.join(temp, MARKER), JSON.stringify({ repo: model.repo, commit: model.commit, bytes: total, installedAt: new Date().toISOString() }, null, 2));
    if (existsSync(target)) await rm(target, { recursive: true, force: true });
    await rename(temp, target);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

/**
 * The model, loaded: onnxruntime-node on the CPU (two threads, so a tick does
 * not take the machine), the tokenizer from its JSON. Mean pooling over the
 * attention mask, then normalised, as sentence-transformers does.
 */
export async function loadEmbedder(dir: string, model: MeaningModel = MEANING_MODEL): Promise<Embedder> {
  const target = modelDir(dir, model);
  const [{ Tokenizer }, ort] = await Promise.all([import('@huggingface/tokenizers'), import('onnxruntime-node')]);
  const tokenizer = new Tokenizer(
    JSON.parse(await readFile(path.join(target, 'tokenizer.json'), 'utf8')),
    JSON.parse(await readFile(path.join(target, 'tokenizer_config.json'), 'utf8')),
  );
  const session = await ort.InferenceSession.create(path.join(target, 'onnx/model_quantized.onnx'), {
    intraOpNumThreads: 2,
    interOpNumThreads: 1,
    graphOptimizationLevel: 'all',
  });
  const wantsTypes = session.inputNames.includes('token_type_ids');
  return {
    model: model.id,
    async embed(texts: string[]): Promise<Float32Array[]> {
      if (texts.length === 0) return [];
      const encoded: number[][] = texts.map((t) => {
        const ids = tokenizer.encode(t).ids;
        // Too long: the first tokens, and the closing one.
        return ids.length <= model.maxTokens ? ids : [...ids.slice(0, model.maxTokens - 1), ids[ids.length - 1]!];
      });
      const width = Math.max(...encoded.map((e) => e.length));
      const ids = new BigInt64Array(texts.length * width);
      const mask = new BigInt64Array(texts.length * width);
      encoded.forEach((e, row) => e.forEach((id, i) => {
        ids[row * width + i] = BigInt(id);
        mask[row * width + i] = 1n;
      }));
      const dims = [texts.length, width];
      const feeds: Record<string, InstanceType<typeof ort.Tensor>> = {
        input_ids: new ort.Tensor('int64', ids, dims),
        attention_mask: new ort.Tensor('int64', mask, dims),
      };
      if (wantsTypes) feeds.token_type_ids = new ort.Tensor('int64', new BigInt64Array(texts.length * width), dims);
      const output = (await session.run(feeds))[session.outputNames[0]!]!;
      const hidden = output.data as Float32Array;
      const size = output.dims[2]!;
      return encoded.map((e, row) => {
        const v = new Float32Array(size);
        for (let i = 0; i < e.length; i++) {
          const at = (row * width + i) * size;
          for (let d = 0; d < size; d++) v[d]! += hidden[at + d]!;
        }
        let norm = 0;
        for (let d = 0; d < size; d++) norm += v[d]! * v[d]!;
        norm = Math.sqrt(norm) || 1;
        for (let d = 0; d < size; d++) v[d]! /= norm;
        return v;
      });
    },
  };
}

/* ------------------------------------------------------------------ *
 * The process's model: its state for the settings line, its download in
 * the background, its load on first use
 * ------------------------------------------------------------------ */

export type MeaningState =
  | { state: 'absent'; bytes: number }
  | { state: 'downloading'; bytes: number; total: number }
  | { state: 'ready'; bytes: number; loaded: boolean }
  | { state: 'failed'; bytes: number; reason: string };

export interface MeaningOptions {
  /** Another loader, for tests. */
  load?: (dir: string) => Promise<Embedder>;
  model?: MeaningModel;
}

export class Meaning {
  private downloading: { bytes: number; total: number } | undefined;
  private loading: Promise<void> | undefined;
  private embedder: Embedder | undefined;
  private failure: string | undefined;

  constructor(readonly dir: string, private readonly options: MeaningOptions = {}) {}

  private get model(): MeaningModel {
    return this.options.model ?? MEANING_MODEL;
  }

  state(): MeaningState {
    const bytes = modelBytes(this.model);
    if (this.downloading) return { state: 'downloading', ...this.downloading };
    if (this.failure) return { state: 'failed', bytes, reason: this.failure };
    if (isDownloaded(this.dir, this.model)) return { state: 'ready', bytes, loaded: !!this.embedder };
    return { state: 'absent', bytes };
  }

  /** The loaded model, or nothing yet: never waits. The first call with the files in place starts the load. */
  ready(): Embedder | undefined {
    if (this.embedder) return this.embedder;
    if (this.loading || this.downloading || this.failure || !isDownloaded(this.dir, this.model)) return undefined;
    this.loading = (this.options.load ?? ((d) => loadEmbedder(d, this.model)))(this.dir)
      .then((e) => {
        this.embedder = e;
      })
      .catch((err: unknown) => {
        this.failure = `The model did not load: ${err instanceof Error ? err.message : String(err)}`;
      })
      .finally(() => {
        this.loading = undefined;
      });
    return undefined;
  }

  /** Wait for a load `ready()` started (tests, and Download's own end). */
  async settled(): Promise<void> {
    await this.loading;
  }

  /** Fetch the files in the background (or try the load again after a failure). Answers at once. */
  start(http: HttpArea): MeaningState {
    if (this.downloading) return this.state();
    this.failure = undefined;
    if (isDownloaded(this.dir, this.model)) {
      this.ready();
      return this.state();
    }
    this.downloading = { bytes: 0, total: modelBytes(this.model) };
    void downloadModel(this.dir, http, (bytes, total) => {
      this.downloading = { bytes, total };
    }, this.model)
      .then(() => {
        this.downloading = undefined;
        this.ready();
      })
      .catch((err: unknown) => {
        this.downloading = undefined;
        this.failure = err instanceof DownloadError ? err.message : `The download failed: ${err instanceof Error ? err.message : String(err)}`;
      });
    return this.state();
  }

  /** The download job, for tests. */
  get busy(): boolean {
    return !!this.downloading || !!this.loading;
  }
}

const models = new Map<string, Meaning>();

/** The one `Meaning` for a plugin directory in this process. */
export function meaningFor(dir: string, options?: MeaningOptions): Meaning {
  let m = models.get(dir);
  if (!m) models.set(dir, (m = new Meaning(dir, options)));
  return m;
}

/** For tests: forget every process model. */
export function resetMeaning(): void {
  models.clear();
}
