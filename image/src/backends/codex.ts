/**
 * A ChatGPT subscription, through the owner's buddi Codex account.
 *
 * The host makes the picture (`ctx.buddi.accounts.generateCodexImage`, host
 * API 1.8): one Responses request to ChatGPT's Codex backend whose only tool
 * is the hosted `image_generation`, under the account's lock and refresh. The
 * token never reaches this plugin, and no `codex` binary is involved.
 *
 * The prompt goes as the agent wrote it; the host fences it as the picture's
 * description. The shape is the tool's `size`. References go as images.
 */
import { ImageRefusal, SIZES, refusalFrom, type ImageBackend } from './types.js';

export { MAX_IMAGE_BYTES } from './types.js';

/**
 * The Responses model that calls the hosted image tool when the owner left the
 * model blank. Not the account's own default: a ChatGPT account's stored
 * default can be one ChatGPT's backend no longer lists (an account made
 * before codex-direct still says \`gpt-5\`), so the plugin names its own,
 * the same one buddi's Codex adapter defaults to.
 */
export const DEFAULT_CODEX_IMAGE_MODEL = 'gpt-5.5';

export const CODEX_TOO_OLD =
  'refused: this buddi is too old to make pictures with a ChatGPT subscription (it needs host API 1.8). Update buddi. Nothing was stored.';

export const codexBackend: ImageBackend = {
  kind: 'codex',
  label: 'ChatGPT subscription',
  serves: (account) => account.kind === 'codex',
  defaultModel: () => DEFAULT_CODEX_IMAGE_MODEL,
  async generate(request, context) {
    const draw = context.accounts.generateCodexImage;
    if (typeof draw !== 'function') throw new ImageRefusal(CODEX_TOO_OLD);
    const timeout = AbortSignal.timeout(context.timeoutMs);
    const signal = AbortSignal.any([context.signal, timeout]);
    try {
      const out = await draw.call(context.accounts, context.account.id, {
        prompt: request.prompt,
        references: request.references.map((r) => ({ bytes: r.bytes, mime: r.mime })),
        size: SIZES[request.aspect],
        ...(context.model ? { model: context.model } : {}),
        signal,
      });
      return { bytes: out.bytes, mime: out.mime };
    } catch (error) {
      if (timeout.aborted) {
        throw new ImageRefusal(`refused: the image took longer than ${Math.round(context.timeoutMs / 1000)} seconds and was stopped. Nothing was stored.`);
      }
      if (context.signal.aborted) throw new ImageRefusal('refused: the image was cancelled. Nothing was stored.');
      throw refusalFrom(error);
    }
  },
};
