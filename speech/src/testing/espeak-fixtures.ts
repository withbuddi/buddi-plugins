/**
 * eSpeak NG's raw output (Echogarden's build 0.3.5, `text_to_phonemes` in IPA),
 * recorded for one sentence per language, so `phonemize` is tested without
 * eSpeak installed. `local.real.test.ts` checks the real eSpeak still answers
 * the same.
 */
export const ESPEAK_SENTENCES = {
  "fr": "Bonjour, je suis Siwis. Votre rendez-vous est à 15:30, d'accord ?",
  "es": "Hola, soy Dora. ¿Cómo estás hoy? La cita es a las tres.",
  "it": "Ciao, sono Sara. Il treno parte alle nove e mezza.",
  "pt": "Olá, eu sou a Dora. O trem sai às nove horas, tudo bem?",
  "hi": "नमस्ते, मैं अल्फा हूँ। आपकी बैठक तीन बजे है।"
} as const;

/** `<eSpeak voice>|<piece>` → what eSpeak answered. */
export const ESPEAK_RAW: Readonly<Record<string, string>> = {
  "fr|Bonjour": "b_ɔ̃_ʒ_ˈu_ʁ",
  "fr|je suis Siwis": "ʒ_ə- s_y_ˌi s_j_w_ˈi",
  "fr|Votre rendez-vous est à 15:30": "v_o_t_ʁ ʁ_ɑ̃_d_ˈe_v_u_z ɛ_t a k_ˈɛ̃_z ˈœ_ʁ t_ʁ_ˈɑ̃_t",
  "fr|d'accord": "d_a_k_ˈɔ_ʁ",
  "es|Hola": "ˈo_l_a",
  "es|soy Dora": "s_ˈoɪ ð_ˈo_ɾ_a",
  "es|Cómo estás hoy": "k_ˈo_m_o e_s_t_ˈa_s ˈoɪ",
  "es|La cita es a las tres": "l_a θ_ˈi_t_a ˈe_s a l_a_s t_ɾ_ˈe_s",
  "it|Ciao": "tʃ_ˈa_o",
  "it|sono Sara": "s_ˌo_n_o s_ˈa_ɾ_a",
  "it|Il treno parte alle nove e mezza": "i_l t__r_ˈɛ_n_o p_ˈa__r_t_e_ ˌa_l_l_e n_ˈɔ_v_e_ e m_ˈɛ_dzː_a",
  "pt-br|Olá": "o_l_ˈa",
  "pt-br|eu sou a Dora": "eʊ s_o_w a d_ˈɔ_ɾ_æ",
  "pt-br|O trem sai às nove horas": "ʊ t_r_ˈeɪ_ŋ s_ˈaɪ_ aː_z n_ˈɔ_v_y_ ˈɔ_ɾ_æ_s",
  "pt-br|tudo bem": "t_ˈu_d_ʊ b_ˈeɪ_ŋ",
  "hi|नमस्ते": "n_ə_m_ˈʌ_s_t_eː",
  "hi|मैं अल्फा हूँ": "m_ɛ̃ ˈʌ_l_pʰ_aː h_ũ",
  "hi|आपकी बैठक तीन बजे है": "ˌaː_p_k_ˌi b_ˈɛː_ʈʰ_ə_k t_ˈiː_n b_ˈʌ_ɟ_eː h_ɛː"
};
