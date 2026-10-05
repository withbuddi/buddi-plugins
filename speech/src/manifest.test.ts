/** The manifest through core's own validation: tools, tiers, the page, the registry. */
import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '@buddi/core/testing';
import { manifest } from './index.js';
import { BACKENDS, backendFor, COMING_BACKENDS } from './backends/index.js';
import type { Field } from '@buddi/core/plugin';
import { accountLabel, capabilityWords, kokoroNotice, rowAccount, voiceRowsOf, whatLeaves } from './settings.js';
import { LANGUAGES, namesOf } from './languages.js';
import { backendForAccount, capabilitiesOf, languageHint, offeredFor, whyNot } from './choose.js';
import type { ProviderAccountListing } from '@buddi/core/plugin';
import type { Settings } from './store.js';

describe('speech manifest', () => {
  it('registers, namespaced, with the settings and test tools kept from models', () => {
    const registry = new ToolRegistry();
    expect(() => registry.register(manifest)).not.toThrow();
    expect(registry.list().map((t) => t.name).sort()).toEqual(['speech.say', 'speech.transcribe']);
    expect(manifest.network?.map((n) => n.host)).toEqual(['api.openai.com', 'generativelanguage.googleapis.com', 'huggingface.co', '*.hf.co', 'registry.npmjs.org']);
    for (const tool of manifest.tools) expect(tool.name.startsWith('speech.')).toBe(true);
    for (const name of ['speech.transcribe', 'speech.say']) {
      const tool = manifest.tools.find((t) => t.name === name)!;
      expect(tool.tier).toBe('auto');
      expect(typeof tool.tierFor).toBe('function');
      expect(typeof tool.describe).toBe('function');
      expect(tool.description).toMatch(/leaves this machine/);
    }
    expect(manifest.tools.find((t) => t.name === 'speech.say')!.producesArtifacts).toBe(true);
    for (const name of ['speech.set_settings', 'speech.test', 'speech.preview', 'speech.install', 'speech.remove', 'speech.telegram_voice']) expect(manifest.tools.find((t) => t.name === name)!.ownerOnly).toBe(true);
    expect(manifest.uses).toEqual(['http', 'accounts', 'files:library']);
  });

  it('puts one Speech page under Settings, drawn by the registry as it will be served', () => {
    const registry = new ToolRegistry();
    registry.register(manifest);
    const page = registry.pages().find((p) => p.plugin === 'speech')!;
    expect(page).toMatchObject({ id: 'settings', title: 'Speech', place: 'settings', icon: 'bell' });
    const text = JSON.stringify(page);
    for (const tool of ['speech.set_settings', 'speech.test', 'speech.preview', 'speech.install', 'speech.remove', 'speech.telegram_voice', 'install_status']) expect(text).toContain(tool);
    expect(text).toContain('"poll":{"seconds":2');
    // No Service selector: each row picks an account; What leaves is folded away.
    expect(text).not.toContain('Backend');
    expect(page.body.some((c) => c.kind === 'expand' && c.label === 'What leaves this computer')).toBe(true);
  });

  it('proposes one skill and no agent', () => {
    expect(manifest.agents).toBeUndefined();
    expect(manifest.skills?.map((s) => s.name)).toEqual(['speaking-for-the-ear']);
    expect(manifest.skills![0]!.body).toMatch(/No tables/);
  });
});

describe('backends', () => {
  it('has openai, openai-compatible and gemini on both sides, and the local ones each on theirs', () => {
    expect(Object.keys(BACKENDS).sort()).toEqual(['gemini', 'kokoro-local', 'openai', 'openai-compatible', 'whisper-local']);
    for (const b of Object.values(BACKENDS)) {
      expect(b.listener?.stream).toBeUndefined();
      expect(b.speaker?.stream).toBeUndefined();
    }
    expect(BACKENDS.openai!.listener!.defaultModel).toBe('gpt-4o-mini-transcribe');
    expect(BACKENDS.openai!.speaker!.defaultModel).toBe('gpt-4o-mini-tts');
    expect(BACKENDS.gemini!.listener!.defaultModel).toBe('gemini-2.5-flash');
    expect(BACKENDS.gemini!.speaker!.defaultModel).toBe('gemini-2.5-flash-preview-tts');
    expect(backendFor('whisper-local')?.local).toBe('whisper');
    expect(backendFor('constructor')).toBeUndefined();
    expect(COMING_BACKENDS).toEqual([]);
  });

  it('reads what each account does with audio: the host\'s hint, else its kind and address', () => {
    const a = (over: Partial<ProviderAccountListing>): ProviderAccountListing => ({ id: 'x', label: 'X', kind: 'openai-compatible', enabled: true, configured: true, defaultModel: 'm', ...over });
    const openai = a({ label: 'OpenAI key', kind: 'openai', baseUrl: 'https://api.openai.com/v1' });
    const gemini = a({ label: 'Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/' });
    const ollama = a({ label: 'Ollama Cloud', baseUrl: 'https://ollama.com/v1' });
    const codex = a({ label: 'ChatGPT Plus', kind: 'codex' });
    const claude = a({ label: 'Claude', kind: 'anthropic' });
    expect(capabilitiesOf(openai)).toEqual({ audioIn: true, audioOut: true, source: 'known' });
    expect(capabilitiesOf(gemini)).toEqual({ audioIn: true, audioOut: true, source: 'known' });
    expect(capabilitiesOf(ollama)).toEqual({ audioIn: false, audioOut: false, source: 'probe' });
    expect(capabilitiesOf(codex).source).toBe('none');
    // The host's hint (1.30) wins over the guess.
    expect(capabilitiesOf({ ...ollama, capabilities: { audioIn: false, audioOut: true, source: 'known' } } as ProviderAccountListing)).toEqual({ audioIn: false, audioOut: true, source: 'known' });
    expect(accountLabel(gemini, 'listening')).toBe('Gemini · listens and speaks');
    expect(accountLabel(openai, 'speaking')).toBe('OpenAI key · listens and speaks');
    expect(accountLabel(ollama, 'speaking')).toBe('Ollama Cloud · speaks (untested)');
    expect(accountLabel(ollama, 'listening', true)).toBe('Ollama Cloud · listens (tried)');
    expect(accountLabel({ ...openai, configured: false }, 'speaking')).toBe('OpenAI key · listens and speaks (not connected)');
    expect(capabilityWords(codex, 'speaking')).toBe('no audio');
    expect(offeredFor(ollama, 'listening')).toBe(true);
    expect(offeredFor(codex, 'listening')).toBe(false);
    expect(whyNot(codex, 'speaking')).toBe('ChatGPT subscription: its backend has no audio');
    expect(whyNot(claude, 'listening')).toMatch(/^Claude: /);
    expect(backendForAccount(openai)?.kind).toBe('openai');
    expect(backendForAccount(gemini)?.kind).toBe('gemini');
    expect(backendForAccount(ollama)?.kind).toBe('openai-compatible');
    expect(backendForAccount(codex)).toBeUndefined();
  });

  it('says what leaves for each choice, and which account each row starts on', () => {
    const s = (listen: string | null, speak: string | null, listenAccount: string | null = null): Settings => ({
      listening: { backend: listen, accountId: listenAccount, model: null, languages: [] },
      speaking: { backend: speak, accountId: null, model: null, voice: null, voices: {} },
      transcribeCap: 200, sayCap: 200,
    });
    expect(whatLeaves(s('openai', null), 'listening')).toBe('Listening: The recording goes to OpenAI (api.openai.com), which sends back the text.');
    expect(whatLeaves(s(null, 'openai-compatible'), 'speaking')).toMatch(/^Speaking: The text to say goes to your OpenAI-compatible/);
    expect(whatLeaves(s(null, null), 'speaking')).toBe('Speaking: nothing, because nothing is chosen.');
    expect(whatLeaves(s('whisper-local', null), 'listening')).toBe('Listening: nothing yet; Whisper on this computer is not installed.');
    // A Gemini account saved as compatible: the account decides.
    const gemini = { id: 'g', label: 'Gemini', kind: 'openai-compatible' as const, enabled: true, configured: true, defaultModel: 'm', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/' };
    expect(whatLeaves(s('openai-compatible', null, 'g'), 'listening', undefined, [gemini])).toMatch(/Google's Gemini API/);
    expect(rowAccount(s('off', null), 'listening')).toBe('off');
    expect(rowAccount(s('openai', null, 'oa'), 'listening')).toBe('oa');
    expect(rowAccount(s('whisper-local', null), 'listening')).toBe('local');
    expect(rowAccount(s(null, null), 'listening')).toBe('');
  });

  it('offers about 25 languages by name, and warns about Kokoro only for one no Kokoro voice speaks', () => {
    expect(LANGUAGES.length).toBeGreaterThanOrEqual(25);
    expect(LANGUAGES.every((l) => /^[a-z]{2}$/.test(l.code))).toBe(true);
    expect(namesOf(['fr', 'es', 'de'])).toBe('French, Spanish and German');
    // French, Spanish, Italian, Portuguese and Hindi have Kokoro voices: no warning for them.
    expect(kokoroNotice('kokoro-local', ['en', 'fr', 'es', 'it', 'pt', 'hi'])).toBe('');
    expect(kokoroNotice('kokoro-local', ['en', 'fr', 'de'])).toBe(
      'No German voice on this computer; German replies use the cloud speaker when one is set, else text.',
    );
    expect(kokoroNotice('kokoro-local', ['fr', 'zh', 'de', 'ja'])).toBe(
      'No Chinese, German or Japanese voice on this computer; Chinese, German and Japanese replies use the cloud speaker when one is set, else text.',
    );
    expect(kokoroNotice('kokoro-local', ['en'])).toBe('');
    expect(kokoroNotice('kokoro-local', [])).toBe('');
    expect(kokoroNotice('openai', ['fr'])).toBe('');
  });

  it('draws a voice row per Kokoro language on the Speaking form, each with its play button in its language', () => {
    const speaking = manifest.pages![0]!.body.find((c) => c.kind === 'section' && c.title === 'Speaking') as { body: Array<{ kind: string; columns?: number; fields?: Field[]; submit?: { args: Record<string, unknown> } }> };
    const form = speaking.body.find((c) => c.kind === 'form')!;
    // Account, model and voice sit three to a row; Listening keeps the default two.
    expect(form.columns).toBe(3);
    const listening = manifest.pages![0]!.body.find((c) => c.kind === 'section' && c.title === 'Listening') as { body: Array<{ kind: string; columns?: number }> };
    expect(listening.body.find((c) => c.kind === 'form')!.columns).toBeUndefined();
    const names = form.fields!.map((f) => f.name);
    expect(names).toEqual(['account', 'model', 'modelOther', 'voice', 'voice_en', 'voice_fr', 'voice_es', 'voice_it', 'voice_pt', 'voice_hi']);
    // Test beside the Account: says one sentence with what is on the form.
    expect(form.fields![0]!.action).toMatchObject({ tool: 'speech.test', label: 'Test', icon: 'play', args: { side: { const: 'speaking' }, account: { field: 'account' } } });
    expect(form.fields!.find((f) => f.name === 'model')!.when).toEqual({ path: 'account', in: ['', 'local', 'off'], not: true });
    expect(form.fields!.find((f) => f.name === 'voice')!.when).toEqual({ path: 'voiceByLanguage', equals: false });
    const fr = form.fields!.find((f) => f.name === 'voice_fr')!;
    expect(fr).toMatchObject({
      label: 'French voice', from: 'speakVoices.fr', when: { path: 'voiceRows.fr', equals: true },
      optionsFrom: { query: { query: 'voices', params: { lang: { const: 'fr' } } } },
      action: { tool: 'speech.preview', icon: 'play', args: { voice: { field: 'voice_fr' }, lang: { const: 'fr' } } },
    });
    expect(form.submit!.args).toMatchObject({ voice_fr: { field: 'voice_fr' }, voice_hi: { field: 'voice_hi' } });
  });

  it('shows the voice rows for the languages the owner speaks that the speaker has voices for, else the one field', () => {
    const s = (speak: string, languages: string[], voice: string | null = null, voices: Record<string, string> = {}): Settings => ({
      listening: { backend: null, accountId: null, model: null, languages },
      speaking: { backend: speak, accountId: null, model: null, voice, voices },
      transcribeCap: 200, sayCap: 200,
    });
    const kokoro = voiceRowsOf(s('kokoro-local', ['fr', 'en', 'de'], 'bf_emma', { fr: 'ff_siwis' }), 'kokoro-local');
    expect(kokoro.voiceByLanguage).toBe(true);
    expect(Object.entries(kokoro.voiceRows).filter(([, on]) => on).map(([l]) => l)).toEqual(['en', 'fr']);
    expect(kokoro.speakVoices).toMatchObject({ en: 'bf_emma', fr: 'ff_siwis', es: 'ef_dora' });
    // A mapped voice of another language is not that language's voice.
    expect(voiceRowsOf(s('kokoro-local', ['fr'], null, { fr: 'af_heart' }), 'kokoro-local').speakVoices.fr).toBe('ff_siwis');
    // OpenAI's voices carry no language; no language listed; only languages Kokoro has no voice for: the one field.
    expect(voiceRowsOf(s('openai', ['en', 'fr']), 'openai').voiceByLanguage).toBe(false);
    expect(voiceRowsOf(s('kokoro-local', []), 'kokoro-local').voiceByLanguage).toBe(false);
    expect(voiceRowsOf(s('kokoro-local', ['de']), 'kokoro-local').voiceByLanguage).toBe(false);
    expect(Object.values(voiceRowsOf(s('openai', ['en']), 'openai').voiceRows).some(Boolean)).toBe(false);
  });

  it('reads a language hint from a tag or a name, and nothing else', () => {
    expect(languageHint('en')).toBe('en');
    expect(languageHint('pt-BR')).toBe('pt');
    expect(languageHint('French')).toBe('fr');
    expect(languageHint('Klingon')).toBeUndefined();
    expect(languageHint('')).toBeUndefined();
    expect(languageHint(null)).toBeUndefined();
  });
});
