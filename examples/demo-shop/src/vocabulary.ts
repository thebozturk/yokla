// What the scripted model understands. All terms are folded (see fold()).

import type { Language } from './language.ts';

export type Color = 'black' | 'blue' | 'red' | 'green' | 'grey' | 'orange';
export type Gender = 'women' | 'men';
export type PolicyTopic = 'returns' | 'shipping' | 'warranty';

/** A list's words in each language (ADR-0107). */
export type Terms = Readonly<Record<Language, readonly string[]>>;

export interface TypeVocabulary {
  readonly key: string;
  /** Display names; English uses the plural. */
  readonly names: Readonly<Record<Language, string>>;
  readonly terms: Terms;
}

export interface AbsentTypeVocabulary extends TypeVocabulary {
  /** The catalog type offered instead. */
  readonly substitute: string;
}

export const PRODUCT_TYPES: readonly TypeVocabulary[] = [
  { key: 'tent', names: { tr: 'çadır', en: 'tents' }, terms: { tr: ['cadir'], en: ['tent'] } },
  {
    key: 'sleeping-bag',
    names: { tr: 'uyku tulumu', en: 'sleeping bags' },
    terms: { tr: ['uyku tulum'], en: ['sleeping bag'] },
  },
  {
    key: 'backpack',
    names: { tr: 'sırt çantası', en: 'backpacks' },
    terms: { tr: ['sirt canta', 'canta'], en: ['backpack', 'rucksack', 'daypack'] },
  },
  {
    key: 'jacket',
    names: { tr: 'mont ve ceket', en: 'jackets' },
    terms: {
      tr: ['mont', 'ceket', 'yagmurluk', 'ruzgarlik'],
      en: ['jacket', 'coat', 'windbreaker'],
    },
  },
  {
    key: 'footwear',
    names: { tr: 'ayakkabı ve bot', en: 'shoes and boots' },
    terms: { tr: ['ayakkabi', 'bot'], en: ['shoe', 'boot', 'footwear'] },
  },
  {
    key: 'headlamp',
    names: { tr: 'kafa lambası', en: 'headlamps' },
    terms: { tr: ['kafa lamba'], en: ['headlamp', 'head torch'] },
  },
  {
    key: 'water-bottle',
    names: { tr: 'matara', en: 'water bottles' },
    terms: { tr: ['matara', 'termos'], en: ['water bottle', 'bottle'] },
  },
  {
    key: 'camping-stove',
    names: { tr: 'kamp ocağı', en: 'camping stoves' },
    terms: { tr: ['kamp ocag', 'ocak', 'ocag'], en: ['stove'] },
  },
  {
    key: 'trekking-pole',
    names: { tr: 'baton', en: 'trekking poles' },
    terms: { tr: ['baton'], en: ['trekking pole', 'hiking pole'] },
  },
];

/** Product types the catalog deliberately lacks. */
export const ABSENT_TYPES: readonly AbsentTypeVocabulary[] = [
  {
    key: 'sleeping-pad',
    names: { tr: 'uyku matı', en: 'sleeping pads' },
    terms: { tr: ['uyku mat', 'kamp mat'], en: ['sleeping pad', 'sleeping mat'] },
    substitute: 'sleeping-bag',
  },
  {
    key: 'hammock',
    names: { tr: 'hamak', en: 'hammocks' },
    terms: { tr: ['hamak'], en: ['hammock'] },
    substitute: 'tent',
  },
  {
    key: 'gaiters',
    names: { tr: 'tozluk', en: 'gaiters' },
    terms: { tr: ['tozluk'], en: ['gaiter'] },
    substitute: 'footwear',
  },
];

export const COLORS: readonly {
  readonly key: Color;
  readonly names: Readonly<Record<Language, string>>;
  readonly terms: Terms;
}[] = [
  { key: 'black', names: { tr: 'siyah', en: 'black' }, terms: { tr: ['siyah'], en: ['black'] } },
  { key: 'blue', names: { tr: 'mavi', en: 'blue' }, terms: { tr: ['mavi'], en: ['blue'] } },
  { key: 'red', names: { tr: 'kırmızı', en: 'red' }, terms: { tr: ['kirmizi'], en: ['red'] } },
  { key: 'green', names: { tr: 'yeşil', en: 'green' }, terms: { tr: ['yesil'], en: ['green'] } },
  { key: 'grey', names: { tr: 'gri', en: 'grey' }, terms: { tr: ['gri'], en: ['grey', 'gray'] } },
  {
    key: 'orange',
    names: { tr: 'turuncu', en: 'orange' },
    terms: { tr: ['turuncu'], en: ['orange'] },
  },
];

export const GENDERS: readonly {
  readonly key: Gender;
  readonly names: Readonly<Record<Language, string>>;
  readonly terms: Terms;
}[] = [
  {
    key: 'women',
    names: { tr: 'kadın', en: "women's" },
    terms: { tr: ['kadin', 'bayan'], en: ['women', 'woman'] },
  },
  {
    key: 'men',
    names: { tr: 'erkek', en: "men's" },
    terms: { tr: ['erkek', 'bay'], en: ['men', 'man'] },
  },
];

export const POLICY_TOPICS: readonly {
  readonly key: PolicyTopic;
  readonly terms: Terms;
}[] = [
  { key: 'returns', terms: { tr: ['iade', 'geri gonder'], en: ['return', 'refund'] } },
  {
    key: 'shipping',
    terms: { tr: ['kargo', 'teslimat', 'gonderim'], en: ['shipping', 'delivery'] },
  },
  { key: 'warranty', terms: { tr: ['garanti'], en: ['warranty', 'guarantee'] } },
];

export const OUT_OF_SCOPE_TERMS: Terms = {
  tr: ['yatirim', 'hisse', 'kredi', 'ilac', 'doktor', 'avukat'],
  en: ['invest', 'shares', 'loan', 'medicine', 'doctor', 'lawyer'],
};

export const CHEAPER_TERMS: Terms = { tr: ['daha ucuz', 'en ucuz'], en: ['cheaper', 'cheapest'] };

/** Words that name the cart; with an add word, a sentence asks to add (ADR-0105). */
export const CART_TERMS: Terms = { tr: ['sepet'], en: ['cart', 'basket'] };

/**
 * Words that ask to add, on folded text (ADR-0105): add or put; ekle or koy in
 * a form that asks, not one that reports an addition ("ekledin", "eklenmis").
 */
export const ADD_WORDS: readonly RegExp[] = [
  /\badd\b/u,
  /\bput\b/u,
  /\bekle(?!di|mis|n)\w*/u,
  /\bkoy(?:\b|a\w*|un(?:uz)?\b|ma\w*)/u,
];

/** Words that take a product out, on folded text (ADR-0105). */
export const REMOVE_WORDS: readonly RegExp[] = [
  /\bremov\w*/u,
  /\bdelet\w*/u,
  /\btake (?:\w+ ){0,3}?(?:out|off)\b/u,
  /\bempty\b/u,
  /\bcikar\w*/u,
  /\bkaldir\w*/u,
  /\bsil(?:\b|er\b|in(?:iz)?\b|ebilir\w*|mek\b)/u,
  /\bbosalt\w*/u,
];

/**
 * Negations, on folded text (ADR-0105): not, never, n't, no need; the add word
 * negated ("ekleme", "eklemeyin", "eklemedim", "koyma"); istemiyorum,
 * istemedim, gerek yok.
 */
export const NEGATIONS: readonly RegExp[] = [
  /\b(?:not|never|dont|didnt|doesnt)\b/u,
  /n['’]t\b/u,
  /\bno need\b/u,
  /\b(?:ekle|koy)m[ae](?:yin\w*|di\w*|sin\b|\b)/u,
  /\bistem(?:iyor|edi)\w*/u,
  /\bgerek yok\b/u,
];

/** Words that ask for a person instead of the assistant (ADR-0075). */
export const HANDOFF_TERMS: Terms = {
  tr: ['temsilci', 'musteri hizmet'],
  en: ['representative', 'human', 'real person', 'customer service'],
};

/** Words that thank the shop, which the thanks-searched defect searches for (ADR-0075). */
export const THANKS_TERMS: readonly string[] = ['tesekkur', 'sagol', 'thank', 'cheers'];

function escape(term: string): string {
  return term.replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/**
 * Length of the longest term that starts a word in `text`, or 0. Any suffix is
 * allowed, so Turkish inflections match: "cadir" matches "cadirlar". `ending`
 * limits what may follow the term.
 */
export function longestMatch(text: string, terms: readonly string[], ending = ''): number {
  let longest = 0;
  for (const term of terms) {
    if (
      term.length > longest &&
      new RegExp(`(?:^|[^a-z0-9])${escape(term)}${ending}`, 'u').test(text)
    ) {
      longest = term.length;
    }
  }
  return longest;
}

/**
 * The shop's Turkish words that are English words too, never read in an
 * English message: there, "bot" is a bot and "bay" a bay (ADR-0107).
 */
export const ENGLISH_TOO: readonly string[] = ['bot', 'bay'];

/**
 * What may follow a Turkish word in an English message (ADR-0107): nothing,
 * an English plural, or the ending of a Turkish compound, as bilingual
 * shoppers write it: "monts", "uyku tulumu", "kafa lambasi". Then the word
 * ends; an apostrophe ends it too, so "matara's" is read.
 */
const IN_ENGLISH = String.raw`(?:s|i|u|si|su)?(?![a-z0-9])`;

/**
 * Length of the longest of `terms` in folded `text`, written in `written`, or 0
 * (ADR-0107). An English word, or a Turkish word in a Turkish message, takes
 * any suffix. In an English message a Turkish word takes only the endings
 * above, so "months" isn't "mont" and "grill" isn't "gri", and the words that
 * are English too aren't read.
 */
export function longestTerm(text: string, terms: Terms, written: Language): number {
  const turkish =
    written === 'tr'
      ? longestMatch(text, terms.tr)
      : longestMatch(
          text,
          terms.tr.filter((term) => !ENGLISH_TOO.includes(term)),
          IN_ENGLISH,
        );
  return Math.max(longestMatch(text, terms.en), turkish);
}
