/**
 * Text into features, for telling whether two articles tell one story. Pure.
 *
 * A title and the start of its lead become a sequence of terms: lower-cased,
 * accents gone, stop words (English and French) out, plurals folded, and a
 * small lexicon of news words mapping French and English synonyms onto one
 * concept (`taux` and `rates` are `rate`; `abaisse`, `baisse`, `lowers` and
 * `cuts` are `cut`), so the same story in two languages shares terms. A term
 * that names something — a proper noun in running text, a number, a place in
 * the lexicon — is an entity, written with a leading `!`; it weighs more, and
 * two articles that each name things but none in common are not one story.
 */

const STOP = new Set(
  (
    // English
    'a an the and or but if then than of to in on at by for from with without into onto over under about after before ' +
    'as is are was were be been being has have had do does did will would shall should can could may might must not no ' +
    'it its this that these those there here he she they them his her their we our you your i me my who whom whose which ' +
    'what when where why how all any both each few more most other some such only own same so too very just also ' +
    'up down out off again further once new says say said year years week day days time amid via vs per ' +
    'after while during since until against between through ' +
    // French
    'le la les un une des du de d l au aux et ou mais donc or ni car que qu qui quoi dont ou ce cet cette ces se s sa son ses ' +
    'leur leurs y en ne pas plus moins tres sur sous dans par pour avec sans chez entre vers contre apres avant pendant ' +
    'est sont ete etre a ont avait avaient sera seront fait faire il elle ils elles on nous vous je tu me te lui eux ' +
    'mon ma mes ton ta tes notre nos votre vos comme aussi tout tous toute toutes deja encore selon face lors ' +
    'c j n m t ans an jour jours semaine annee nouveau nouvelle nouveaux nouvelles'
  ).split(/\s+/),
);

/** Capitalised words that name no thing: weekdays and months, both languages. */
const NOT_NAMES = new Set(
  ('monday tuesday wednesday thursday friday saturday sunday lundi mardi mercredi jeudi vendredi samedi dimanche ' +
    'january february march april may june july august september october november december janvier fevrier mars avril ' +
    'mai juin juillet aout septembre octobre novembre decembre breaking live update exclusive watch video analysis opinion'
  ).split(' '),
);

/**
 * concept: words (already normalised: lower case, no accents). A concept
 * starting with `!` is an entity (a place or a body the story is about).
 */
const LEXICON_SOURCE = `
cut: cut cuts slash slashes lower lowers lowered lowering reduce reduces reduced baisse baisser abaisse abaisser reduit reduire diminue
raise: raise raises raised hike hikes hiked increase increases augmente augmenter hausse relevement releve
rate: rate rates taux
interest: interest interet interets
inflation: inflation
price: price prices prix
election: election elections vote votes voting scrutin presidentielle presidential legislative legislatives polls poll
win: win wins won victory victoire gagne remporte remporter elu elected
lose: lose loses lost defeat defaite perd perdu
president: president presidente presidency presidence
minister: minister ministre ministers ministres
prime: prime premier
government: government gouvernement governments cabinet
parliament: parliament parlement assemblee congress congres senate senat lawmakers deputes
law: law laws bill loi lois legislation
court: court tribunal cour justice judge juge
ban: ban bans banned interdit interdiction interdire
war: war guerre conflict conflit
peace: peace paix ceasefire treve
attack: attack attacks attaque attaques strike strikes frappe frappes assault
kill: kill kills killed dead death deaths tue tues mort morts deces victimes victims
injure: injured wounded blesse blesses
protest: protest protests protesters manifestation manifestations manifestants
strike_work: walkout greve
talk: talk talks negotiation negotiations negociations pourparlers
deal: deal agreement accord accords pact pacte
sign: sign signs signed signe signer
summit: summit sommet
meet: meet meets meeting rencontre reunion
visit: visit visite
announce: announce announces announced annonce annoncer unveil unveils unveiled devoile
launch: launch launches launched lance lancer lancement
release: release releases sortie publie
company: company companies entreprise entreprises firm societe groupe
market: market markets marche marches bourse stocks stock actions
bank: bank banks banque banques
central: central centrale
growth: growth croissance
job: job jobs emploi emplois employment chomage unemployment
tariff: tariff tariffs droits douane douanes
trade: trade commerce commercial
tax: tax taxes impot impots taxe
budget: budget budgets
debt: debt dette
oil: oil petrole crude brut
earthquake: earthquake seisme tremblement
flood: flood floods flooding inondation inondations
storm: storm storms tempete ouragan hurricane cyclone typhoon
fire: fire fires wildfire wildfires incendie incendies blaze
arrest: arrest arrests arrested arrete arrestation interpelle
fire_job: fired sack sacked oust ousts ousted limoge limoger renvoie
resign: resign resigns resigned resignation demission demissionne
appoint: appoint appoints appointed nomme nomination
chief: chief head director directeur chef patron
sworn: sworn investiture investi inauguration inaugurated
term: term mandat
report: report rapport
study: study etude
model: model models modele modeles
intelligence: intelligence
artificial: artificial artificielle
ai: ai ia
chip: chip chips puce puces semiconductor semiconductors semiconducteurs
phone: phone phones smartphone smartphones telephone
data: data donnees
security: security securite cybersecurity cybersecurite
hack: hack hacked hackers piratage pirates cyberattack cyberattaque breach
user: user users utilisateurs utilisateur
quarter: quarter trimestre
percent: percent pourcent
point: point points
billion: billion billions milliard milliards
million: million millions
record: record records
first: first premiere
second: second deuxieme seconde
!usa: us usa u.s united states etats unis americain americaine americains americaines american americans
!france: france francais francaise french
!uk: uk britain british royaume uni britannique
!eu: eu european union ue europeenne union europeenne
!china: china chinese chine chinois chinoise
!russia: russia russian russie russe
!ukraine: ukraine ukrainian ukrainien ukrainienne
!israel: israel israeli israelien israelienne
!gaza: gaza
!iran: iran iranian iranien
!togo: togo togolese togolais togolaise
!lome: lome
!ghana: ghana ghanaian ghaneen
!nigeria: nigeria nigerian nigerian
!benin: benin beninese beninois
!senegal: senegal senegalese senegalais
!mali: mali malian malien
!burkina: burkina faso burkinabe
!ivory_coast: ivory coast ivoire ivoirien ivorian
!ecowas: ecowas cedeao
!africa: africa african afrique africain africaine
!fed: fed
!ecb: ecb bce
!un: un onu nations unies
!nato: nato otan
!white_house: white house maison blanche
`;

const LEXICON = new Map<string, string>();
const PHRASES: Array<[string[], string]> = [];
for (const line of LEXICON_SOURCE.trim().split('\n')) {
  const [concept, words] = line.split(':').map((s) => s.trim()) as [string, string];
  for (const word of words.split(/\s+/)) {
    if (!LEXICON.has(word)) LEXICON.set(word, concept);
  }
}
/** Multi-word names, matched before single words: "federal reserve", "etats unis". */
const PHRASE_SOURCE: Array<[string, string]> = [
  ['federal reserve', '!fed'], ['reserve federale', '!fed'], ['united states', '!usa'], ['etats unis', '!usa'],
  ['united nations', '!un'], ['nations unies', '!un'], ['white house', '!white_house'], ['maison blanche', '!white_house'],
  ['european union', '!eu'], ['union europeenne', '!eu'], ['ivory coast', '!ivory_coast'], ['cote d ivoire', '!ivory_coast'],
  ['burkina faso', '!burkina'], ['royaume uni', '!uk'], ['united kingdom', '!uk'], ['central bank', 'central_bank'],
  ['banque centrale', 'central_bank'], ['artificial intelligence', 'ai'], ['intelligence artificielle', 'ai'],
  ['interest rates', 'rate'], ['interest rate', 'rate'], ['taux d interet', 'rate'], ['taux directeurs', 'rate'], ['taux directeur', 'rate'],
  ['quarter point', 'quarter_point'], ['quart de point', 'quarter_point'], ['0.25 point', 'quarter_point'], ['0.25 percentage point', 'quarter_point'],
  ['prime minister', 'prime_minister'], ['premier ministre', 'prime_minister'],
];
for (const [phrase, concept] of PHRASE_SOURCE) PHRASES.push([phrase.split(' '), concept]);
PHRASES.sort((a, b) => b[0].length - a[0].length);

/** Lower case, accents gone, apostrophes and punctuation as spaces, decimal commas as points. */
export function normalise(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/(\d)[,.](\d)/g, '$1.$2')
    .replace(/[’'`´]/g, ' ')
    .replace(/[^a-z0-9.\s]+/g, ' ')
    .replace(/(^|\s)\.+|\.+(?=\s|$)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Fold a plural and a few English endings: `rates` → `rate`, `cities` → `city`. */
function stem(word: string): string {
  if (/^\d/.test(word) || word.length <= 3) return word;
  if (word.endsWith('ies') && word.length > 4) return `${word.slice(0, -3)}y`;
  if (word.endsWith('aux') && word.length > 4) return `${word.slice(0, -3)}al`;
  if ((word.endsWith('s') || word.endsWith('x')) && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

/**
 * The names in a text: a word capitalised where it stands and not at the start
 * of a sentence, a word with a capital inside (`iPhone`), a short acronym, or
 * a word capitalised in two places (the title and the lead both start with
 * "Apple"). A Title Case sentence says nothing about which of its words are
 * names, and only counts towards the last rule.
 */
function capitalisedWords(text: string): Set<string> {
  const names = new Set<string>();
  const seen = new Map<string, number>();
  const add = (w: string): void => {
    for (const part of normalise(w).split(' ')) if (part && !STOP.has(part)) names.add(part);
  };
  const sentences = text.split(/(?<=[.!?:«»"“”])\s+|\s[-–—|]\s/);
  for (const sentence of sentences) {
    const words = sentence.split(/[\s,;()«»"“”]+/).filter(Boolean);
    const caps = words.filter((w) => /^\p{Lu}/u.test(w)).length;
    const titleCase = words.length >= 4 && caps / words.length > 0.6;
    words.forEach((w, i) => {
      const letters = w.replace(/[^\p{L}]/gu, '');
      if (/^\p{Lu}/u.test(letters)) {
        const key = normalise(letters);
        seen.set(key, (seen.get(key) ?? 0) + 1);
      }
      if (/^\p{Ll}+\p{Lu}/u.test(letters)) add(w);
      if (titleCase) return;
      if (i > 0 && /^\p{Lu}/u.test(letters)) add(w);
      if (/^\p{Lu}{2,6}$/u.test(letters)) add(w);
    });
  }
  for (const [key, count] of seen) if (count >= 2) add(key);
  return names;
}

/** The term sequence of a text: concepts and words, entities marked with a leading `!`. */
export function terms(text: string, names: Set<string> = capitalisedWords(text)): string[] {
  const words = normalise(text).split(' ').filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < words.length; ) {
    const phrase = PHRASES.find(([parts]) => parts.every((p, k) => words[i + k] === p));
    if (phrase) {
      out.push(phrase[1]);
      i += phrase[0].length;
      continue;
    }
    const word = words[i]!;
    i += 1;
    if (STOP.has(word)) continue;
    const concept = LEXICON.get(word) ?? LEXICON.get(stem(word));
    if (concept) {
      out.push(concept);
      continue;
    }
    if (/^\d+(\.\d+)?$/.test(word)) {
      // A year or a count names the story; a lone digit says little.
      if (word.length >= 2) out.push(`!${word}`);
      continue;
    }
    if (word.length < 2) continue;
    const s = stem(word);
    out.push(names.has(word) && !NOT_NAMES.has(word) ? `!${s}` : s);
  }
  return out;
}

/** The terms of one stretch of text, compared. */
export interface TermSet {
  /** Term → weight (an entity weighs `ENTITY_WEIGHT`). */
  weights: Map<string, number>;
  /** Three-term shingles of the sequence. */
  shingles: Set<string>;
  /** The entities alone. */
  entities: Set<string>;
}

/** What two articles are compared by: title and lead together, and the title alone. */
export interface Features extends TermSet {
  hasLead: boolean;
  title: TermSet;
}

export const ENTITY_WEIGHT = 3;
/** How many terms of the lead count beside the title's. */
export const LEAD_TERMS = 24;
/** Between the title's terms and the lead's in a stored sequence. */
export const LEAD_MARK = '|';

/** The stored term sequence of an article: its title's terms, then (after `LEAD_MARK`) the first of its lead's. */
export function articleSequence(title: string, lead: string): string[] {
  // Names are read from both together: the title and the lead both starting with "Apple" is what says it is one.
  const names = capitalisedWords(lead ? `${title}. ${lead}` : title);
  const titleTerms = terms(title, names);
  const leadTerms = lead ? terms(lead, names).slice(0, LEAD_TERMS) : [];
  return leadTerms.length > 0 ? [...titleTerms, LEAD_MARK, ...leadTerms] : titleTerms;
}

function termSet(sequence: string[]): TermSet {
  const weights = new Map<string, number>();
  const entities = new Set<string>();
  for (const term of sequence) {
    const entity = term.startsWith('!');
    const key = entity ? term.slice(1) : term;
    if (entity) entities.add(key);
    weights.set(key, Math.max(weights.get(key) ?? 0, entity ? ENTITY_WEIGHT : 1));
  }
  const plain = sequence.map((t) => (t.startsWith('!') ? t.slice(1) : t));
  const shingles = new Set<string>();
  for (let i = 0; i + 3 <= plain.length; i++) shingles.add(plain.slice(i, i + 3).join(' '));
  return { weights, shingles, entities };
}

export function featuresOf(sequence: string[]): Features {
  const mark = sequence.indexOf(LEAD_MARK);
  const titleTerms = mark === -1 ? sequence : sequence.slice(0, mark);
  const leadTerms = mark === -1 ? [] : sequence.slice(mark + 1);
  const full = termSet([...titleTerms, ...leadTerms]);
  // Shingles do not run across the title's end into the lead.
  const shingles = new Set([...termSet(titleTerms).shingles, ...termSet(leadTerms).shingles]);
  return { ...full, shingles, hasLead: leadTerms.length > 0, title: termSet(titleTerms) };
}

/** Weighted Jaccard of two term maps. */
export function weightedJaccard(a: Map<string, number>, b: Map<string, number>): number {
  let inter = 0;
  let union = 0;
  for (const [k, w] of a) {
    const v = b.get(k) ?? 0;
    inter += Math.min(w, v);
    union += Math.max(w, v);
  }
  for (const [k, v] of b) if (!a.has(k)) union += v;
  return union === 0 ? 0 : inter / union;
}

export function jaccard<T>(a: Set<T>, b: Set<T>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  return inter / (a.size + b.size - inter);
}

/** Drop an outlet's name from the end of a title: "Headline - Le Monde", "Headline | BBC News". Empty when the title was only the name. */
export function stripOutletSuffix(title: string, outlet?: string): string {
  const t = title.trim();
  if (outlet) {
    const escaped = outlet.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const stripped = t.replace(new RegExp(`(^|\\s+)[-–—|:]\\s+${escaped}\\s*$`, 'i'), '').trim();
    if (stripped !== t) return stripped;
  }
  return t;
}

/** What a feed carries that is not news: shopping codes, legal notices, a section's own page ("Ukraine", "Accidents"). */
const NOT_NEWS_TITLE = /\b(promo codes?|coupon codes?|coupons?|discount codes?|annonces? légales?)\b/i;
const NOT_NEWS_OUTLET = /annonces légales|legal notices/i;

export function isNews(title: string, outlet = ''): boolean {
  if (NOT_NEWS_TITLE.test(title) || NOT_NEWS_OUTLET.test(outlet)) return false;
  return normalise(title).split(' ').filter(Boolean).length >= 3;
}

const OPINION_PATH = /\/(opinion|opinions|commentisfree|comment|editorial|editorials|op-ed|oped|tribunes?|idees|debats|chroniques?|editos?|editoriaux|blogs?|columns?|columnists?)(\/|$)/i;
const OPINION_TITLE = /^(opinion|op-ed|editorial|éditorial|edito|édito|tribune|chronique|column|commentary|point de vue|analysis|analyse)\s*[:|-–—]/i;
const OPINION_CATEGORY = /^(opinion|opinions|op-ed|editorial|éditorial|tribune|tribunes|chronique|chroniques|idées|commentary|columnists?|comment is free)$/i;

/** Whether an article reads as opinion rather than reporting: by its address, its title's label or its category. */
export function isOpinion(url: string, title: string, categories: string[] = []): boolean {
  let path = '';
  try {
    path = new URL(url).pathname;
  } catch {
    path = '';
  }
  return OPINION_PATH.test(path) || OPINION_TITLE.test(title.trim()) || categories.some((c) => OPINION_CATEGORY.test(c.trim()));
}
