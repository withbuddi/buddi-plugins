/**
 * @buddi/tool-speech — agents listen to a recording and answer with a voice,
 * through the service the owner chose on Settings → Speech, with daily caps.
 *
 * Two model-facing tools (`tools.ts`): `speech.transcribe` and `speech.say`.
 * Which service listens and which speaks is the owner's choice on the page
 * (`settings.ts`); each service is a backend behind two ports
 * (`backends/types.ts`: `Listener`, `Speaker`), so the tools and Telegram
 * know no vendor. The backend registry is exported from here for another
 * plugin (telephony) to use directly. Core reaches the model accounts for it
 * (`ctx.buddi.accounts`, only the ones the owner bound by choosing them on
 * the page); this plugin never reads a key from the environment.
 *
 * Whisper and Kokoro run on this computer from files buddi fetches itself
 * (`install.ts`: pinned URLs, SHA-256 checked); `installLocal` is exported
 * for `buddi speech install`.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PluginManifest } from '@buddi/core/plugin';
import { VERSION } from './version.js';
import { sayTool, transcribeTool } from './tools.js';
import { installTool, removeTool, setSettingsTool, speechPages, speechQueries, telegramVoiceTool, testTool } from './settings.js';
import { speechSkills } from './skills.js';
import { previewTool } from './preview.js';

export const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

export const manifest: PluginManifest = {
  name: 'speech',
  version: VERSION,
  schema: 'speech',
  migrationsDir: MIGRATIONS_DIR,
  author: { name: 'withbuddi', url: 'https://withbuddi.com' },
  description:
    'Lets agents listen to an audio file and answer with a voice, through the OpenAI or OpenAI-compatible ' +
    'account you choose on Settings → Speech, or Whisper and Kokoro on this computer, with daily limits.',
  network: [
    { host: 'api.openai.com', why: 'OpenAI accounts: a recording goes to be transcribed, or a text to be spoken; the text or the audio comes back.' },
    { host: 'huggingface.co', why: 'Install on Settings → Speech: the Whisper and Kokoro model files, pinned and checked; nothing is sent.' },
    { host: '*.hf.co', why: "Hugging Face's download servers (us.aws.cdn.hf.co and its like), where huggingface.co sends those files." },
    { host: 'registry.npmjs.org', why: 'Install of Kokoro: the eSpeak NG package (12.5 MB, GPL-3.0), pinned and checked, which pronounces the languages other than English; nothing is sent.' },
  ],
  tools: [transcribeTool, sayTool, setSettingsTool, testTool, previewTool, installTool, removeTool, telegramVoiceTool],
  pages: speechPages,
  queries: speechQueries,
  skills: speechSkills,
  uses: ['http', 'accounts', 'files:library'],
};

export default manifest;

export * from './magic.js';
export * from './backends/index.js';
export * from './store.js';
export * from './choose.js';
export * from './tools.js';
export * from './settings.js';
export * from './preview.js';
export * from './skills.js';
export * from './spoken.js';
export * from './install.js';
export { encodeOggOpus } from './local/ogg-opus.js';
export { decodeForWhisper } from './local/audio.js';
export { isProbablyEnglish } from './local/english.js';
