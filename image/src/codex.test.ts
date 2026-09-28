/**
 * The ChatGPT subscription backend: what it asks the host
 * (`accounts.generateCodexImage`), what it brings back, and what it refuses.
 */
import { describe, expect, it } from 'vitest';
import type { CodexImageOptions, ProviderAccountListing } from '@buddi/core/plugin';
import { CODEX_TOO_OLD, DEFAULT_CODEX_IMAGE_MODEL, codexBackend } from './backends/codex.js';
import type { BackendContext } from './backends/types.js';
import { PNG_1x1 } from './testing/fixtures.js';

const ACCOUNT: ProviderAccountListing = { id: 'codex-1', label: 'ChatGPT Plus', kind: 'codex', enabled: true, configured: true, defaultModel: 'gpt-5.5' };
const request = { prompt: 'A red fox asleep on a mossy stone.', references: [], aspect: 'landscape' as const };

function context(draw: BackendContext['accounts']['generateCodexImage'], over: Partial<BackendContext> = {}): BackendContext {
  return {
    accounts: { resolve: async () => { throw new Error('not an HTTP account'); }, ...(draw ? { generateCodexImage: draw } : {}) },
    account: ACCOUNT, model: 'gpt-5.5', signal: new AbortController().signal, timeoutMs: 5_000, ...over,
  };
}

describe('ChatGPT subscription backend', () => {
  it('asks the host for one picture with the prompt, size, model and references, and returns its bytes', async () => {
    const calls: Array<[string, CodexImageOptions]> = [];
    const result = await codexBackend.generate(
      { ...request, references: [{ bytes: PNG_1x1, mime: 'image/png', filename: 'fox.png' }] },
      context(async (id, options) => { calls.push([id, options]); return { bytes: PNG_1x1, mime: 'image/png', revisedPrompt: 'a fox' }; }),
    );
    expect(result.bytes.equals(PNG_1x1)).toBe(true);
    expect(calls).toHaveLength(1);
    const [id, options] = calls[0]!;
    expect(id).toBe('codex-1');
    expect(options).toMatchObject({ prompt: request.prompt, size: '1536x1024', model: 'gpt-5.5' });
    expect(options.references).toEqual([{ bytes: PNG_1x1, mime: 'image/png' }]);
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });

  it('defaults to its own image model, not the account\'s stored one, and is labelled as a subscription', () => {
    expect(codexBackend.defaultModel(ACCOUNT)).toBe(DEFAULT_CODEX_IMAGE_MODEL);
    // An account made before codex-direct still stores gpt-5: not what is shown or sent.
    expect(codexBackend.defaultModel({ ...ACCOUNT, defaultModel: 'gpt-5' })).toBe('gpt-5.5');
    expect(codexBackend.label).toBe('ChatGPT subscription');
    expect(codexBackend.serves({ kind: 'codex' })).toBe(true);
  });

  it('turns a host refusal into one sentence', async () => {
    const unbound = context(async () => { throw new Error('The owner has not given image that model account; pick one on its settings page.'); });
    await expect(codexBackend.generate(request, unbound)).rejects.toThrow(/^refused: The owner has not given image that model account; pick one on its settings page\. Nothing was stored\.$/);
    const limit = context(async () => { throw new Error('Your ChatGPT plan’s limit is reached.\nWait for it to reset'); });
    await expect(codexBackend.generate(request, limit)).rejects.toThrow(/limit is reached\. Wait for it to reset\. Nothing was stored\.$/);
  });

  it('stops at the time limit, and on cancel', async () => {
    const hang: BackendContext['accounts']['generateCodexImage'] = (_id, options) =>
      new Promise((_resolve, reject) => options.signal!.addEventListener('abort', () => reject(new Error('aborted'))));
    await expect(codexBackend.generate(request, context(hang, { timeoutMs: 50 }))).rejects.toThrow(/took longer than \d+ seconds and was stopped/);
    const controller = new AbortController();
    const running = codexBackend.generate(request, context(hang, { signal: controller.signal }));
    controller.abort();
    await expect(running).rejects.toThrow(/cancelled/);
  });

  it('refuses on a buddi without the host call', async () => {
    await expect(codexBackend.generate(request, context(undefined))).rejects.toThrow(CODEX_TOO_OLD);
  });
});
