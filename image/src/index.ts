/**
 * @buddi/tool-image — one picture from a prompt, with a provider account the
 * owner chose, kept in the Files library and drawn on the canvas.
 *
 * `image.generate` is the one model-facing tool (see `generate.ts` for the
 * tier and why). Which account and model draw is the owner's choice on
 * Settings → Image; each account has a backend (`backends/`): a ChatGPT
 * subscription through the host's image call on the owner's Codex account,
 * the OpenAI Images API for `openai` and `openai-compatible` accounts, and
 * Imagen for a Gemini account. Core reaches the
 * accounts for it (`ctx.buddi.accounts`, the one the owner bound by choosing
 * it on Settings → Image); this plugin never reads a
 * key from the environment or a login from `~/.codex`.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PluginManifest } from '@buddi/core/plugin';
import { VERSION } from './version.js';
import { chooseAccount, generateTool } from './generate.js';
import { ImageRefusal } from './backends/index.js';
import { imagePages, imageQueries, setSettingsTool } from './settings.js';
import { imageViews } from './views.js';
import { imageSkills } from './skills.js';

export const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

export const manifest: PluginManifest = {
  name: 'image',
  version: VERSION,
  schema: 'image',
  migrationsDir: MIGRATIONS_DIR,
  author: { name: 'withbuddi', url: 'https://withbuddi.com' },
  description:
    'Makes one image from a prompt with the provider account you choose (ChatGPT subscription, OpenAI, ' +
    'Gemini, or an OpenAI-compatible server) and keeps it in the Files library.',
  network: [
    { host: 'chatgpt.com', why: 'ChatGPT subscription accounts: buddi sends the prompt and references to ChatGPT\'s image tool and gets the picture back.' },
    { host: 'api.openai.com', why: 'OpenAI accounts: the prompt and references go to the Images API; the picture comes back.' },
    { host: 'generativelanguage.googleapis.com', why: 'Gemini accounts: the prompt goes to Imagen through Google\'s OpenAI-compatible endpoint; the picture comes back.' },
  ],
  tools: [generateTool, setSettingsTool],
  views: imageViews,
  pages: imagePages,
  queries: imageQueries,
  skills: imageSkills,
  uses: ['accounts', 'files:library'],
  // Nothing to draw with until an account is chosen (host API 1.18): the Plugins row says so and opens Settings → Image.
  setup: {
    async produce(ctx) {
      try {
        await chooseAccount(ctx);
        return { ready: true };
      } catch (err) {
        if (!(err instanceof ImageRefusal)) throw err;
        return { ready: false, note: 'Choose the account it draws with.', page: 'settings' };
      }
    },
  },
};

export default manifest;

export * from './magic.js';
export * from './backends/index.js';
export * from './store.js';
export * from './generate.js';
export * from './settings.js';
export * from './views.js';
export * from './skills.js';
