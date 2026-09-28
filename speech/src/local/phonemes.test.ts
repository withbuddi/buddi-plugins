/**
 * Kokoro's phonemes for French, Spanish, Italian, Portuguese and Hindi, from
 * eSpeak NG's recorded output (`testing/espeak-fixtures.ts`): the pieces cut
 * at the marks, misaki's substitutions, the vocabulary check. The voices by
 * language, the reply's language, and the voice a reply is said with.
 */
import { describe, expect, it } from 'vitest';
import { kokoroVoiceForText } from '../backends/local.js';
import { ESPEAK_RAW, ESPEAK_SENTENCES } from '../testing/espeak-fixtures.js';
import { guessLanguage } from './english.js';
import { fromEspeak, kokoroOnly, KOKORO_SYMBOLS, phonemize, resetDropped, type EspeakLike } from './phonemes.js';
import { FIRST_VOICE, OTHER_VOICES, otherVoiceLabel, voiceLanguage } from './voices.js';

/** eSpeak as recorded; a piece it was not recorded with fails the test. */
const recorded: EspeakLike = {
  raw(text, voice) {
    const got = ESPEAK_RAW[`${voice}|${text}`];
    if (got === undefined) throw new Error(`not recorded: ${voice}|${text}`);
    return got;
  },
};

describe('phonemize', () => {
  it('says one sentence per language as Kokoro\'s phonemes, the marks kept', () => {
    const said = Object.fromEntries(Object.entries(ESPEAK_SENTENCES).map(([lang, text]) => [lang, phonemize(text, lang as never, recorded)]));
    expect(said).toEqual({
      fr: 'bɔ̃ʒˈuʁ, ʒə syˌi sjwˈi. votʁ ʁɑ̃dˈevuz ɛt a kˈɛ̃z ˈœʁ tʁˈɑ̃t, dakˈɔʁ ?',
      es: 'ˈola, sˈoɪ ðˈoɾa. kˈomo estˈas ˈoɪ? la θˈita ˈes a las tɾˈes.',
      it: 'ʧˈao, sˌono sˈaɾa. il trˈɛno pˈarte ˌalle nˈɔve e mˈɛʣːa.',
      pt: 'olˈa, eʊ sow a dˈɔɾæ. ʊ trˈAŋ sˈI aːz nˈɔvy ˈɔɾæs, tˈudʊ bˈAŋ?',
      hi: 'nəmˈʌsteː, mɛ̃ ˈʌlpʰaː hu\u0303. ˌaːpkˌi bˈɛːʈʰək tˈiːn bˈʌɟeː hɛː.',
    });
    // Everything said is in Kokoro's vocabulary.
    for (const s of Object.values(said)) expect([...s].every((c) => KOKORO_SYMBOLS.has(c))).toBe(true);
  });

  it('keeps a time or a decimal whole, and cuts at the marks around it', () => {
    const pieces: string[] = [];
    const spy: EspeakLike = { raw: (text) => { pieces.push(text); return 'a'; } };
    phonemize('Rendez-vous à 15:30, soit 3,5 heures. (Oui !)', 'fr', spy);
    expect(pieces).toEqual(['Rendez-vous à 15:30', 'soit 3,5 heures', 'Oui']);
    expect(phonemize('« Oui », dit-il… [ok]', 'fr', { raw: () => 'w_ˈi' })).toBe('“ wˈi ”, wˈi… (wˈi)');
    expect(phonemize('   ', 'es', spy)).toBe('');
  });

  it('folds eSpeak\'s two-letter phonemes to Kokoro\'s one symbol, as misaki does', () => {
    // A phoneme is what sits between separators: "tʃ" is one (Italian "ciao"), "t_ʃ" two (French "tchèque").
    expect(fromEspeak('tʃ_ˈa_o')).toBe('ʧˈao');
    expect(fromEspeak('t_ʃ_ˈɛ_k')).toBe('tʃˈɛk');
    expect(fromEspeak('dʒ_ˈaɪ_v eɪ oʊ əʊ ɔɪ aʊ dz ts ss')).toBe('ʤˈIv A O Q Y W ʣ ʦ S');
    // misaki deletes eSpeak's "-"; language-switch flags and clause bars go.
    expect(fromEspeak('ʒ_ə- s_y_ˌi | (en)h_ə_l_ˈoʊ(fr)')).toBe('ʒə syˌi həlˈO');
  });

  it('drops what Kokoro has no symbol for, logging each symbol once', () => {
    resetDropped();
    const lines: string[] = [];
    const log = (l: string) => lines.push(l);
    expect(kokoroOnly('ab̩c̩', log)).toBe('abc');
    // A precomposed nasal vowel is a vowel and U+0303, both known.
    expect(kokoroOnly('ã', log)).toBe('ã');
    expect(lines).toEqual(['speech: Kokoro has no symbol for "̩" (U+0329); it is left out.']);
  });
});

describe('Kokoro\'s voices by language', () => {
  it('lists the voices beyond English with their language, and no Japanese or Chinese', () => {
    expect(OTHER_VOICES.map((v) => v.id)).toEqual([
      'ff_siwis', 'ef_dora', 'em_alex', 'em_santa', 'if_sara', 'im_nicola', 'pf_dora', 'pm_alex', 'pm_santa',
      'hf_alpha', 'hf_beta', 'hm_omega', 'hm_psi',
    ]);
    expect(otherVoiceLabel(OTHER_VOICES[0]!)).toBe('Siwis (French, female)');
    expect(otherVoiceLabel(OTHER_VOICES.find((v) => v.id === 'pm_alex')!)).toBe('Alex (Portuguese, male)');
    expect(OTHER_VOICES.some((v) => /^[jz]/.test(v.id))).toBe(false);
  });

  it('reads a voice\'s language from its first letter', () => {
    expect(['af_heart', 'bm_george', 'ff_siwis', 'em_alex', 'if_sara', 'pf_dora', 'hm_psi', 'jf_alpha', 'zf_xiaobei', 'alloy'].map(voiceLanguage))
      .toEqual(['en', 'en', 'fr', 'es', 'it', 'pt', 'hi', 'ja', 'zh', undefined]);
  });

  it('tells a reply\'s language by script and common words, or says it cannot', () => {
    expect(guessLanguage("Bonjour, votre rendez-vous est déplacé à quinze heures, et il n'y a rien d'autre.")).toBe('fr');
    expect(guessLanguage('Hola, la reunión es a las tres y no hay nada más.')).toBe('es');
    expect(guessLanguage('Ciao, il treno parte alle nove e non è in ritardo.')).toBe('it');
    expect(guessLanguage('Olá, a reunião é às três e não há mais nada.')).toBe('pt');
    expect(guessLanguage('Your meeting moved to three, and there is nothing else.')).toBe('en');
    expect(guessLanguage('Die Besprechung ist um drei und das ist alles.')).toBe('de');
    expect(guessLanguage('आपकी बैठक तीन बजे है।')).toBe('hi');
    expect(guessLanguage('会議は三時に移動しました。')).toBe('ja');
    expect(guessLanguage('Okay.')).toBeUndefined();
  });

  it('says a reply with a voice of its language when the chosen one does not speak it', () => {
    expect(kokoroVoiceForText('Bonjour, votre rendez-vous est à quinze heures.', 'af_heart')).toBe('ff_siwis');
    expect(kokoroVoiceForText('Hola, la reunión es a las tres y no hay nada más.', 'ff_siwis')).toBe('ef_dora');
    expect(kokoroVoiceForText('Your meeting moved to three, and that is all.', 'pm_alex')).toBe(FIRST_VOICE.en);
    // The chosen voice speaks it: kept, whichever of the language's voices it is.
    expect(kokoroVoiceForText('Bonjour, votre rendez-vous est à quinze heures.', 'ff_siwis')).toBe('ff_siwis');
    expect(kokoroVoiceForText('Your meeting moved to three, and that is all.', 'bm_george')).toBe('bm_george');
    // Too short to tell: the owner's one spoken language decides; several, the chosen voice stays.
    expect(kokoroVoiceForText('Okay.', 'af_heart', ['it'])).toBe('if_sara');
    expect(kokoroVoiceForText('Okay.', 'af_heart', ['it', 'en'])).toBe('af_heart');
    // No Kokoro voice for German or Japanese: the chosen voice stays, and the English check refuses later.
    expect(kokoroVoiceForText('Die Besprechung ist um drei und das ist alles.', 'af_heart')).toBe('af_heart');
    expect(kokoroVoiceForText('会議は三時に移動しました。', 'af_heart')).toBe('af_heart');
  });

  it("says a reply with the owner's voice for its language, and a voice the call named when it speaks it", () => {
    const voices = { en: 'bm_george', fr: 'ff_siwis', es: 'em_alex' };
    const english = 'Your meeting moved to three, and that is all.';
    const spanish = 'Hola, la reunión es a las tres y no hay nada más.';
    expect(kokoroVoiceForText(english, 'af_heart', ['en', 'fr'], { voices })).toBe('bm_george');
    expect(kokoroVoiceForText(spanish, 'af_heart', [], { voices })).toBe('em_alex');
    // No voice mapped for it: the chosen one when it speaks it, else the language's first.
    expect(kokoroVoiceForText('Ciao, il treno parte alle nove e non è in ritardo.', 'af_heart', [], { voices })).toBe('if_sara');
    // A mapped voice of another language is passed over.
    expect(kokoroVoiceForText(english, 'af_heart', [], { voices: { en: 'ff_siwis' } })).toBe('af_heart');
    // The call's own voice wins when it speaks the reply's language, and not otherwise.
    expect(kokoroVoiceForText(english, 'am_adam', [], { voices, asked: true })).toBe('am_adam');
    expect(kokoroVoiceForText(spanish, 'am_adam', [], { voices, asked: true })).toBe('em_alex');
    // No Kokoro voice for German: the not-in-this-language route, as before.
    expect(kokoroVoiceForText('Die Besprechung ist um drei und das ist alles.', 'af_heart', [], { voices })).toBe('af_heart');
  });
});
