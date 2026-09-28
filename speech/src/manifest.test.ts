/** The manifest through core's own validation: tools, tiers, the page, the registry. */
import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '@buddi/core/testing';
import { manifest } from './index.js';
import { BACKENDS, backendFor, COMING_BACKENDS } from './backends/index.js';
import type { Field } from '@buddi/core/plugin';
import { backendChoices, kokoroNotice, NOT_INSTALLED_LABEL, voiceRowsOf, whatLeaves } from './settings.js';
import { LANGUAGES, namesOf } from './languages.js';
import { languageHint } from './choose.js';
import type { Settings } from './store.js';

describe('speech manifest', () => {
  it('registers, namespaced, with the settings and test tools kept from models', () => {
    const registry = new ToolRegistry();
    expect(() => registry.register(manifest)).not.toThrow();
    expect(registry.list().map((t) => t.name).sort()).toEqual(['speech.say', 'speech.transcribe']);
    expect(manifest.network?.map((n) => n.host)).toEqual(['api.openai.com', 'huggingface.co', '*.hf.co', 'registry.npmjs.org']);
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
    expect(text).toContain('ChatGPT subscription');
    expect(text).toContain('"poll":{"seconds":2');
  });

  it('proposes one skill and no agent', () => {
    expect(manifest.agents).toBeUndefined();
    expect(manifest.skills?.map((s) => s.name)).toEqual(['speaking-for-the-ear']);
    expect(manifest.skills![0]!.body).toMatch(/No tables/);
  });
});

describe('backends', () => {
  it('has openai and openai-compatible on both sides, and the local ones each on theirs, offered as installable', () => {
    expect(Object.keys(BACKENDS).sort()).toEqual(['kokoro-local', 'openai', 'openai-compatible', 'whisper-local']);
    for (const b of Object.values(BACKENDS)) {
      expect(b.listener?.stream).toBeUndefined();
      expect(b.speaker?.stream).toBeUndefined();
    }
    expect(BACKENDS.openai!.listener!.defaultModel).toBe('gpt-4o-mini-transcribe');
    expect(BACKENDS.openai!.speaker!.defaultModel).toBe('gpt-4o-mini-tts');
    expect(backendFor('whisper-local')?.local).toBe('whisper');
    expect(backendFor('constructor')).toBeUndefined();
    expect(COMING_BACKENDS).toEqual([]);
    expect(backendChoices('listening')).toEqual([
      { id: 'openai', label: 'OpenAI', available: true },
      { id: 'openai-compatible', label: 'OpenAI-compatible', available: true },
      { id: 'whisper-local', label: `Whisper on this computer — ${NOT_INSTALLED_LABEL}`, available: false },
      { id: 'off', label: 'Off', available: true },
    ]);
    expect(backendChoices('speaking').map((b) => b.id).slice(-2)).toEqual(['kokoro-local', 'off']);
  });

  it('says what leaves for each choice', () => {
    const s = (listen: string | null, speak: string | null): Settings => ({
      listening: { backend: listen, accountId: null, model: null, languages: [] },
      speaking: { backend: speak, accountId: null, model: null, voice: null, voices: {} },
      transcribeCap: 200, sayCap: 200,
    });
    expect(whatLeaves(s('openai', null), 'listening')).toBe('Listening: The recording goes to OpenAI (api.openai.com), which sends back the text.');
    expect(whatLeaves(s(null, 'openai-compatible'), 'speaking')).toMatch(/^Speaking: The text to say goes to your OpenAI-compatible/);
    expect(whatLeaves(s(null, null), 'speaking')).toBe('Speaking: nothing, because no service is chosen.');
    expect(whatLeaves(s('whisper-local', null), 'listening')).toBe('Listening: nothing yet; Whisper on this computer is not installed.');
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
    // Service and the voices sit three to a row; Listening keeps the default two.
    expect(form.columns).toBe(3);
    const listening = manifest.pages![0]!.body.find((c) => c.kind === 'section' && c.title === 'Listening') as { body: Array<{ kind: string; columns?: number }> };
    expect(listening.body.find((c) => c.kind === 'form')!.columns).toBeUndefined();
    const names = form.fields!.map((f) => f.name);
    expect(names).toEqual(['speakBackend', 'account', 'model', 'modelOther', 'voice', 'voice_en', 'voice_fr', 'voice_es', 'voice_it', 'voice_pt', 'voice_hi']);
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
