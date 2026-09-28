/**
 * The language spoken in a recording, from Whisper itself: one encoder pass
 * and one decoder step after <|startoftranscript|>, whose token is the
 * language. Plain code over the pipeline it is handed, so it runs in the
 * speech worker (`worker.ts`) and is tested with a fake pipeline.
 */

export interface AsrPipeline {
  (audio: Float32Array, options: Record<string, unknown>): Promise<{ text: string } | Array<{ text: string }>>;
  model: {
    generate: (args: Record<string, unknown>) => Promise<{ tolist(): unknown[] }>;
    generation_config?: { decoder_start_token_id?: number };
  };
  processor: (audio: Float32Array) => Promise<{ input_features: unknown }>;
  tokenizer: { decode(ids: number[], options?: Record<string, unknown>): string; model?: { tokens_to_ids?: Map<string, number> } };
  dispose?: () => unknown;
}

/**
 * Transformers.js 3 does not detect the language itself (it assumes English
 * when none is given), so a French voice note with no hint would come back
 * as English.
 *
 * With the owner's languages (`allowed`), every other token is masked out of
 * that one step, so the answer is the likeliest of theirs: a French speaker's
 * accent is never heard as Portuguese. Codes Whisper does not know are
 * dropped; none left, and the detection is free.
 */
export async function detectLanguage(pipe: AsrPipeline, pcm: Float32Array, allowed: readonly string[] = []): Promise<string | undefined> {
  const start = pipe.model.generation_config?.decoder_start_token_id;
  if (start === undefined) return undefined;
  const { input_features } = await pipe.processor(pcm.subarray(0, 30 * 16_000));
  const ids = languageTokenIds(pipe, allowed);
  const out = await pipe.model.generate({
    inputs: input_features,
    decoder_input_ids: [start],
    max_new_tokens: 1,
    ...(ids.length > 0 ? { logits_processor: [onlyTokens(ids)] } : {}),
  });
  return languageToken(pipe, out);
}

/** `['fr', 'en']` → the ids of `<|fr|>` and `<|en|>`, those the tokenizer has. */
function languageTokenIds(pipe: AsrPipeline, codes: readonly string[]): number[] {
  const vocab = pipe.tokenizer.model?.tokens_to_ids;
  if (!vocab) return [];
  return codes.map((c) => vocab.get(`<|${c}|>`)).filter((id): id is number => typeof id === 'number');
}

/** A logits processor keeping only `ids`: everything else is -Infinity. */
export function onlyTokens(ids: readonly number[]): (inputIds: unknown, logits: LogitsBatch) => LogitsBatch {
  const keep = new Set(ids);
  return (_inputIds, logits) => {
    for (let b = 0; b < logits.dims[0]!; b++) {
      const row = logits[b]!.data;
      for (let i = 0; i < row.length; i++) if (!keep.has(i)) row[i] = -Infinity;
    }
    return logits;
  };
}

/** What Transformers.js hands a logits processor: `[batch, vocab]`, indexable by batch. */
export interface LogitsBatch {
  dims: number[];
  [batch: number]: { data: Float32Array };
}

/** `<|fr|>` → `fr`. */
function languageToken(pipe: AsrPipeline, output: { tolist(): unknown[] }): string | undefined {
  try {
    const rows = output.tolist() as unknown[][];
    const id = rows[0]?.[1];
    if (id === undefined) return undefined;
    const token = pipe.tokenizer.decode([Number(id)], { skip_special_tokens: false });
    return /^<\|([a-z]{2,3})\|>$/.exec(token)?.[1];
  } catch {
    return undefined;
  }
}
