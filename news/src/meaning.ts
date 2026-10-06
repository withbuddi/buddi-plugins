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
 * Since host API 1.32 buddi keeps both the engine and the model: the model is
 * a shared model (`ctx.buddi.models`, one folder per id, every file pinned to a
 * commit and checked by its size and SHA-256), and it runs on buddi's ONNX
 * engine (`ctx.buddi.onnx`), downloaded for this platform only on first need.
 * Nothing is fetched until the owner presses Download on Settings → News and
 * approves the one card that covers the engine and the model. The plugin
 * carries only the tokenizer (Hugging Face's own JavaScript one), loaded when
 * the model is.
 *
 * Nothing here blocks the poller: `ready()` answers the loaded model or
 * nothing at once, starting the load in the background the first time.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { BuddiHost, OnnxTensor } from '@buddi/core/plugin';
import type { Embedder } from './embed.js';

export interface ModelFile {
  /** Its path inside the model's folder. */
  path: string;
  url: string;
  bytes: number;
  sha256: string;
}

const REPO = 'Xenova/paraphrase-multilingual-MiniLM-L12-v2';
const COMMIT = '2c4055b12046f11709e9df2c122e59ffbdc2f900';
const hf = (file: string): string => `https://huggingface.co/${REPO}/resolve/${COMMIT}/${file}`;

export const MEANING_MODEL = {
  /** What a stored vector names, so a vector from another model is never compared; also the shared model's folder. */
  id: 'minilm-l12-multilingual-q8',
  label: 'Multilingual MiniLM',
  repo: REPO,
  commit: COMMIT,
  dims: 384,
  /** The model was trained on 128 tokens; a title and a 600-character lead fit. */
  maxTokens: 128,
  onnx: 'onnx/model_quantized.onnx',
  files: [
    ['tokenizer_config.json', 496, '3f5961b9ac86288cccdb97f32fb848d6187c78e1603958c53f3ea1f296b7d8a2'],
    ['tokenizer.json', 17_082_913, 'b60b6b43406a48bf3638526314f3d232d97058bc93472ff2de930d43686fa441'],
    ['onnx/model_quantized.onnx', 118_308_126, '66fc00f5f29afcaff34092e1bdd20008ca3918265a82fb9695a551e510cc4ebc'],
  ].map(([file, bytes, sha256]) => ({ path: file as string, url: hf(file as string), bytes: bytes as number, sha256: sha256 as string })) as ModelFile[],
} as const;

export type MeaningModel = Omit<typeof MEANING_MODEL, 'files'> & { files: readonly ModelFile[] };

/** What the meaning model needs of the host: its engine and its shared models (1.32, `uses: ['onnx']`). */
export type MeaningHost = Pick<BuddiHost, 'onnx' | 'models'>;

export const MEANING_REASON = 'to group news stories by what they say';

export function modelBytes(model: MeaningModel = MEANING_MODEL): number {
  return model.files.reduce((n, f) => n + f.bytes, 0);
}

/** "135 MB": decimal megabytes, as a download is counted. */
export function megabytes(bytes: number): string {
  return `${Math.max(1, Math.round(bytes / 1_000_000))} MB`;
}

/** The model as `models.ensure` and `onnx.ensure` take it. */
export function modelRequest(model: MeaningModel = MEANING_MODEL): { id: string; name: string; files: Array<{ url: string; sha256: string; bytes: number; name: string }> } {
  return { id: model.id, name: `${model.label} model`, files: model.files.map((f) => ({ url: f.url, sha256: f.sha256, bytes: f.bytes, name: f.path })) };
}

/**
 * The model, loaded: a session on buddi's engine (two threads, so a tick does
 * not take the machine), the tokenizer from its JSON. Mean pooling over the
 * attention mask, then normalised, as sentence-transformers does.
 */
export async function loadEmbedder(host: MeaningHost, folder: string, model: MeaningModel = MEANING_MODEL): Promise<Embedder> {
  if (!host.onnx) throw new Error('This buddi has no engine for local models.');
  const { Tokenizer } = await import('@huggingface/tokenizers');
  const tokenizer = new Tokenizer(
    JSON.parse(await readFile(path.join(folder, 'tokenizer.json'), 'utf8')),
    JSON.parse(await readFile(path.join(folder, 'tokenizer_config.json'), 'utf8')),
  );
  const session = await host.onnx.createSession(path.join(folder, model.onnx), { threads: 2 });
  const { inputs, outputs } = await session.names();
  const wantsTypes = inputs.includes('token_type_ids');
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
      const feeds: Record<string, OnnxTensor> = {
        input_ids: { type: 'int64', data: ids, dims },
        attention_mask: { type: 'int64', data: mask, dims },
      };
      if (wantsTypes) feeds.token_type_ids = { type: 'int64', data: new BigInt64Array(texts.length * width), dims };
      const output = (await session.run(feeds))[outputs[0]!];
      if (!output || output.type !== 'float32') throw new Error('The model answered no float32 output.');
      const hidden = output.data as Float32Array;
      const size = Number(output.dims[2]);
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
 * The process's model: its state for the settings line (the engine's and
 * the model's, from the host), the owner's one card, its load on first use
 * ------------------------------------------------------------------ */

export type MeaningState =
  /** `pending`: the download card raised and not answered yet. */
  | { state: 'absent'; bytes: number; pending?: string }
  | { state: 'downloading'; bytes: number; total: number }
  | { state: 'ready'; bytes: number; loaded: boolean }
  | { state: 'failed'; bytes: number; reason: string };

export interface MeaningOptions {
  /** Another loader, for tests. */
  load?: (host: MeaningHost, folder: string) => Promise<Embedder>;
  model?: MeaningModel;
}

const NO_ENGINE = 'This buddi has no engine for local models: update buddi to use the meaning model.';

export class Meaning {
  private loading: Promise<void> | undefined;
  private embedder: Embedder | undefined;
  private failure: string | undefined;
  /** The card `start` raised, until the host says otherwise. */
  private pending: string | undefined;

  constructor(private readonly options: MeaningOptions = {}) {}

  private get model(): MeaningModel {
    return this.options.model ?? MEANING_MODEL;
  }

  /** Where the engine and the model stand together, from the host. */
  async state(host: MeaningHost): Promise<MeaningState> {
    const model = this.model;
    const bytes = modelBytes(model);
    if (!host.onnx || !host.models) return { state: 'failed', bytes, reason: NO_ENGINE };
    const [engine, files] = await Promise.all([host.onnx.state(), host.models.state(model.id)]);
    if (engine.state === 'failed') return { state: 'failed', bytes, reason: engine.reason ?? 'The engine did not download.' };
    if (files.state === 'failed') return { state: 'failed', bytes, reason: files.reason ?? 'The model did not download.' };
    if (this.failure) return { state: 'failed', bytes, reason: this.failure };
    const engineLeft = engine.state === 'ready' ? 0 : engine.downloadBytes;
    if (engine.state === 'downloading' || files.state === 'downloading') {
      const got = (engine.state === 'downloading' ? engine.receivedBytes ?? 0 : 0) + (files.state === 'downloading' ? files.receivedBytes ?? 0 : files.state === 'ready' ? bytes : 0);
      return { state: 'downloading', bytes: got, total: bytes + engineLeft };
    }
    if (engine.state === 'ready' && files.state === 'ready') {
      this.pending = undefined;
      return { state: 'ready', bytes, loaded: !!this.embedder };
    }
    const pending = engine.pending ?? files.pending ?? this.pending;
    return { state: 'absent', bytes: bytes + engineLeft, ...(pending ? { pending } : {}) };
  }

  /** The loaded model, or nothing yet: never waits. The first call with the engine and the files in place starts the load. */
  ready(host: MeaningHost): Embedder | undefined {
    if (this.embedder) return this.embedder;
    if (this.loading || this.failure || !host.onnx || !host.models) return undefined;
    this.loading = (async () => {
      const [engine, files] = await Promise.all([host.onnx!.state(), host.models!.state(this.model.id)]);
      if (engine.state !== 'ready' || files.state !== 'ready' || !files.path) return;
      this.embedder = await (this.options.load ?? ((h, f) => loadEmbedder(h, f, this.model)))(host, files.path);
    })()
      .catch((err: unknown) => {
        this.failure = `The model did not load: ${err instanceof Error ? err.message : String(err)}`;
      })
      .finally(() => {
        this.loading = undefined;
      });
    return undefined;
  }

  /** Wait for a load `ready()` started (tests). */
  async settled(): Promise<void> {
    await this.loading;
  }

  /**
   * Ask buddi for the engine and the model, on one card the owner answers
   * (or try the load again after a failure). Answers at once: nothing is
   * fetched before the owner approves; buddi downloads, the settings line polls.
   */
  async start(host: MeaningHost): Promise<MeaningState> {
    this.failure = undefined;
    if (!host.onnx || !host.models) return this.state(host);
    const engine = await host.onnx.ensure({ reason: MEANING_REASON, model: modelRequest(this.model) });
    // One card for what is missing: the engine and the model, or the model alone once the engine is here.
    if (engine.pending) this.pending = engine.pending;
    const state = await this.state(host);
    if (state.state === 'ready') this.ready(host);
    return state;
  }

  /** A load in flight, for tests. */
  get busy(): boolean {
    return !!this.loading;
  }
}

let meaning: Meaning | undefined;

/** The process's one `Meaning`. */
export function meaningFor(options?: MeaningOptions): Meaning {
  return (meaning ??= new Meaning(options));
}

/** For tests: forget the process model. */
export function resetMeaning(): void {
  meaning = undefined;
}
