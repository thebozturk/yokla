// What the scripted model understands. All terms are folded (see fold()).

import type { Language } from './language.ts';

export type Color = 'black' | 'blue' | 'red' | 'green' | 'grey' | 'orange';
export type Gender = 'women' | 'men';
export type PolicyTopic = 'returns' | 'shipping' | 'warranty';

export interface TypeVocabulary {
  readonly key: string;
  /** Display names; English uses the plural. */
  readonly names: Readonly<Record<Language, string>>;
  readonly terms: readonly string[];
}

export interface AbsentTypeVocabulary extends TypeVocabulary {
  /** The catalog type offered instead. */
  readonly substitute: string;
}

export const PRODUCT_TYPES: readonly TypeVocabulary[] = [
  { key: 'tent', names: { tr: 'çadır', en: 'tents' }, terms: ['cadir', 'tent'] },
  {
    key: 'sleeping-bag',
    names: { tr: 'uyku tulumu', en: 'sleeping bags' },
    terms: ['uyku tulum', 'sleeping bag'],
  },
  {
    key: 'backpack',
    names: { tr: 'sırt çantası', en: 'backpacks' },
    terms: ['sirt canta', 'canta', 'backpack', 'rucksack', 'daypack'],
  },
  {
    key: 'jacket',
    names: { tr: 'mont ve ceket', en: 'jackets' },
    terms: ['mont', 'ceket', 'yagmurluk', 'ruzgarlik', 'jacket', 'coat', 'windbreaker'],
  },
  {
    key: 'footwear',
    names: { tr: 'ayakkabı ve bot', en: 'shoes and boots' },
    terms: ['ayakkabi', 'bot', 'shoe', 'boot', 'footwear'],
  },
  {
    key: 'headlamp',
    names: { tr: 'kafa lambası', en: 'headlamps' },
    terms: ['kafa lamba', 'headlamp', 'head torch'],
  },
  {
    key: 'water-bottle',
    names: { tr: 'matara', en: 'water bottles' },
    terms: ['matara', 'termos', 'water bottle', 'bottle'],
  },
  {
    key: 'camping-stove',
    names: { tr: 'kamp ocağı', en: 'camping stoves' },
    terms: ['kamp ocag', 'ocak', 'ocag', 'stove'],
  },
  {
    key: 'trekking-pole',
    names: { tr: 'baton', en: 'trekking poles' },
    terms: ['baton', 'trekking pole', 'hiking pole'],
  },
];

/** Product types the catalog deliberately lacks. */
export const ABSENT_TYPES: readonly AbsentTypeVocabulary[] = [
  {
    key: 'sleeping-pad',
    names: { tr: 'uyku matı', en: 'sleeping pads' },
    terms: ['uyku mat', 'kamp mat', 'sleeping pad', 'sleeping mat'],
    substitute: 'sleeping-bag',
  },
  {
    key: 'hammock',
    names: { tr: 'hamak', en: 'hammocks' },
    terms: ['hamak', 'hammock'],
    substitute: 'tent',
  },
  {
    key: 'gaiters',
    names: { tr: 'tozluk', en: 'gaiters' },
    terms: ['tozluk', 'gaiter'],
    substitute: 'footwear',
  },
];

export const COLORS: readonly {
  readonly key: Color;
  readonly names: Readonly<Record<Language, string>>;
  readonly terms: readonly string[];
}[] = [
  { key: 'black', names: { tr: 'siyah', en: 'black' }, terms: ['siyah', 'black'] },
  { key: 'blue', names: { tr: 'mavi', en: 'blue' }, terms: ['mavi', 'blue'] },
  { key: 'red', names: { tr: 'kırmızı', en: 'red' }, terms: ['kirmizi', 'red'] },
  { key: 'green', names: { tr: 'yeşil', en: 'green' }, terms: ['yesil', 'green'] },
  { key: 'grey', names: { tr: 'gri', en: 'grey' }, terms: ['gri', 'grey', 'gray'] },
  { key: 'orange', names: { tr: 'turuncu', en: 'orange' }, terms: ['turuncu', 'orange'] },
];

export const GENDERS: readonly {
  readonly key: Gender;
  readonly names: Readonly<Record<Language, string>>;
  readonly terms: readonly string[];
}[] = [
  {
    key: 'women',
    names: { tr: 'kadın', en: "women's" },
    terms: ['kadin', 'women', 'woman', 'bayan'],
  },
  { key: 'men', names: { tr: 'erkek', en: "men's" }, terms: ['erkek', 'men', 'man', 'bay'] },
];

export const POLICY_TOPICS: readonly {
  readonly key: PolicyTopic;
  readonly terms: readonly string[];
}[] = [
  { key: 'returns', terms: ['iade', 'geri gonder', 'return', 'refund'] },
  { key: 'shipping', terms: ['kargo', 'teslimat', 'gonderim', 'shipping', 'delivery'] },
  { key: 'warranty', terms: ['garanti', 'warranty', 'guarantee'] },
];

export const OUT_OF_SCOPE_TERMS: readonly string[] = [
  'yatirim',
  'hisse',
  'kredi',
  'ilac',
  'doktor',
  'avukat',
  'invest',
  'shares',
  'loan',
  'medicine',
  'doctor',
  'lawyer',
];

export const CHEAPER_TERMS: readonly string[] = ['daha ucuz', 'en ucuz', 'cheaper', 'cheapest'];

function escape(term: string): string {
  return term.replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/**
 * Length of the longest term that starts a word in `text`, or 0. Any suffix is
 * allowed, so Turkish inflections match: "cadir" matches "cadirlar".
 */
export function longestMatch(text: string, terms: readonly string[]): number {
  let longest = 0;
  for (const term of terms) {
    if (term.length > longest && new RegExp(`(?:^|[^a-z0-9])${escape(term)}`, 'u').test(text)) {
      longest = term.length;
    }
  }
  return longest;
}
