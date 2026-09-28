/**
 * The local models buddi fetches itself, pinned: each file's Hugging Face
 * `resolve/<commit>` URL, its size and its SHA-256. The runtime never
 * fetches; it reads these files from the plugin's directory.
 *
 * Whisper small (multilingual) at q8: the encoder, the merged decoder, and
 * the tokenizer and config JSONs Transformers.js reads. Kokoro-82M v1.0 at q8:
 * the model and its tokenizer; its voice pack ships inside `kokoro-js`.
 *
 * Sizes, from the files below: Whisper 251,846,613 bytes (about 252 MB),
 * Kokoro 92,364,770 bytes (about 92 MB).
 *
 * eSpeak NG comes with Kokoro (`COMPANIONS`): the pronunciation of French,
 * Spanish, Italian, Portuguese and Hindi (`phonemes.ts`). It is GPL-3.0, so it
 * is not a dependency of this Apache-2.0 plugin: `buddi speech install kokoro`
 * fetches Echogarden's Emscripten build from the npm registry, one pinned
 * tarball (12,528,264 bytes) checked by its SHA-256, and unpacks the module,
 * its language data and its licence into `<dir>/espeak`.
 */
export type LocalKind = 'whisper' | 'kokoro';
/** What `install.ts` can put in place: a model, or a part that comes with one. */
export type LocalPart = LocalKind | 'espeak';

export const LOCAL_KINDS: readonly LocalKind[] = ['whisper', 'kokoro'];

export interface ModelFile {
  /** Where it goes under the model's directory, as the runtime looks for it. */
  path: string;
  url: string;
  bytes: number;
  sha256: string;
}

/** A file taken out of a downloaded tarball, with the size it must have. */
export interface UnpackedFile {
  /** Its path inside the tarball. */
  from: string;
  /** Where it goes under the part's directory. */
  path: string;
  bytes: number;
}

export interface LocalModel {
  kind: LocalPart;
  /** What the page and the CLI call it. */
  label: string;
  /** The Hugging Face repository and the commit every URL is pinned to. */
  repo: string;
  commit: string;
  /** Its directory under the plugin's own (`<data>/plugins-data/speech/<dir>`). */
  dir: string;
  files: ModelFile[];
  /**
   * When set, `files` is one gzipped tarball: these are taken out of it, the
   * tarball is not kept, and these (not `files`) are what an install is.
   */
  unpack?: UnpackedFile[];
}

const hf = (repo: string, commit: string, path: string) => `https://huggingface.co/${repo}/resolve/${commit}/${path}`;

const WHISPER_REPO = 'onnx-community/whisper-small';
const WHISPER_COMMIT = '36050c46d777d46dc4b5f43f6d90574fc38f8732';
const KOKORO_REPO = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const KOKORO_COMMIT = '1939ad2a8e416c0acfeecc08a694d14ef25f2231';

export const LOCAL_MODELS: Readonly<Record<LocalKind, LocalModel>> = {
  whisper: {
    kind: 'whisper',
    label: 'Whisper small',
    repo: WHISPER_REPO,
    commit: WHISPER_COMMIT,
    dir: 'whisper',
    files: [
      ['config.json', 2227, '457854d452f17661e197d74aee12b8e74fb75ba30ebfaa7426d0d61ea1e08a18'],
      ['generation_config.json', 3893, 'f538b28220c6a6d6f1af1458d4141cacb4ef4963df3de98a19490440c412ddf0'],
      ['preprocessor_config.json', 339, 'a6a76d28c93edb273669eb9e0b0636a2bddbb1272c3261e47b7ca6dfdbac1b8d'],
      ['tokenizer.json', 2480466, '27fc476bfe7f17299480be2273fc0608e4d5a99aba2ab5dec5374b4482d1a566'],
      ['tokenizer_config.json', 282683, '2a4c4281cf9f51ac6ccc406fdc711a087afe6530f671fa7b80953edc498275ce'],
      ['onnx/encoder_model_quantized.onnx', 92326160, 'a43a83f3c5361cd591cfa7c36f14b43cf7cb22f47a415cc14a8d557be800fa92'],
      ['onnx/decoder_model_merged_quantized.onnx', 156750845, 'ec07c3cbb64172c39791e26ee870a65ac22b458c36722bfe2776b3dbf741e0c9'],
    ].map(([path, bytes, sha256]) => ({ path: path as string, url: hf(WHISPER_REPO, WHISPER_COMMIT, path as string), bytes: bytes as number, sha256: sha256 as string })),
  },
  kokoro: {
    kind: 'kokoro',
    label: 'Kokoro 82M',
    repo: KOKORO_REPO,
    commit: KOKORO_COMMIT,
    dir: 'kokoro',
    files: [
      ['config.json', 44, 'df34b4f930b23447cd4dc410fabfb42eb3f24e803e6c3f97d618fb359380a36f'],
      ['tokenizer.json', 3497, '77a02c8e164413299b4b4c403b14f8e0e1c1b727db4d46a09d6327b861060a34'],
      ['tokenizer_config.json', 113, 'be1cb066d6ef6b074b3f15e6a6dd21ac88ff3cdaedf325f0aaed686c70f75d20'],
      ['onnx/model_quantized.onnx', 92361116, 'fbae9257e1e05ffc727e951ef9b9c98418e6d79f1c9b6b13bd59f5c9028a1478'],
    ].map(([path, bytes, sha256]) => ({ path: path as string, url: hf(KOKORO_REPO, KOKORO_COMMIT, path as string), bytes: bytes as number, sha256: sha256 as string })),
  },
};

const ESPEAK_PACKAGE = '@echogarden/espeak-ng-emscripten';
const ESPEAK_VERSION = '0.3.5';

export const ESPEAK_MODEL: LocalModel = {
  kind: 'espeak',
  label: 'eSpeak NG',
  repo: ESPEAK_PACKAGE,
  commit: ESPEAK_VERSION,
  dir: 'espeak',
  files: [{
    path: `espeak-ng-emscripten-${ESPEAK_VERSION}.tgz`,
    url: `https://registry.npmjs.org/${ESPEAK_PACKAGE}/-/espeak-ng-emscripten-${ESPEAK_VERSION}.tgz`,
    bytes: 12_528_264,
    sha256: '6b0bac048e123de9a690e3fe79346ed377c18797e9b09c3e0d8761a3ac00abe6',
  }],
  unpack: [
    { from: 'package/espeak-ng.js', path: 'espeak-ng.js', bytes: 841_996 },
    { from: 'package/espeak-ng.data', path: 'espeak-ng.data', bytes: 24_014_553 },
    { from: 'package/COPYING', path: 'COPYING', bytes: 35_147 },
  ],
};

/** The parts fetched, checked and removed with a model. */
export const COMPANIONS: Readonly<Record<LocalKind, readonly LocalModel[]>> = {
  whisper: [],
  kokoro: [ESPEAK_MODEL],
};

export function totalBytes(model: LocalModel): number {
  return model.files.reduce((n, f) => n + f.bytes, 0);
}

/** "252 MB": decimal megabytes, as a download is usually counted. */
export function megabytes(bytes: number): string {
  return `${Math.max(1, Math.round(bytes / 1_000_000))} MB`;
}
