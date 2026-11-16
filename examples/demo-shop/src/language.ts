export type Language = 'tr' | 'en';

/**
 * Lower-cases with Turkish rules and removes diacritics, so that matching is
 * robust to casing and missing diacritics: "ÇADIRI" → "cadiri", "I" → "i".
 */
export function fold(text: string): string {
  return text
    .toLocaleLowerCase('tr-TR')
    .replaceAll('ı', 'i')
    .normalize('NFD')
    .replaceAll(/\p{M}/gu, '');
}

const TURKISH_LETTERS = /[çğıöşüÇĞİÖŞÜ]/u;

// Folded words that are typical of one language and rare in the other.
export const TURKISH_HINTS: ReadonlySet<string> = new Set([
  'var',
  'mi',
  'mu',
  'ne',
  'kadar',
  'kac',
  'fiyat',
  'fiyati',
  'istiyorum',
  'ariyorum',
  'oner',
  'onerir',
  'misin',
  'musun',
  'alti',
  'altinda',
  'ustu',
  'beden',
  'numara',
  'renk',
  'iade',
  'kargo',
  'teslimat',
  'garanti',
  'cadir',
  'mont',
  'ceket',
  'canta',
  'ayakkabi',
  'matara',
  'ocak',
  'baton',
  'kadin',
  'erkek',
  'siyah',
  'mavi',
  'kirmizi',
  'yesil',
  'gri',
  'turuncu',
  'daha',
  'ucuz',
  'en',
  'olan',
  'olani',
  'icin',
  'merhaba',
  'nedir',
  'neler',
  'nasil',
  'uyku',
  'tulumu',
  've',
  'bir',
  'hamak',
  'tozluk',
]);
export const ENGLISH_HINTS: ReadonlySet<string> = new Set([
  'the',
  'a',
  'an',
  'is',
  'are',
  'do',
  'does',
  'you',
  'have',
  'what',
  'how',
  'much',
  'i',
  'want',
  'need',
  'looking',
  'for',
  'show',
  'me',
  'recommend',
  'under',
  'below',
  'over',
  'above',
  'size',
  'color',
  'colour',
  'return',
  'returns',
  'shipping',
  'delivery',
  'warranty',
  'tent',
  'tents',
  'jacket',
  'jackets',
  'boots',
  'shoes',
  'backpack',
  'cheaper',
  'cheapest',
  'one',
  'women',
  "women's",
  'men',
  "men's",
  'black',
  'blue',
  'red',
  'green',
  'grey',
  'gray',
  'orange',
  'hello',
  'thanks',
  'please',
  'can',
  'any',
  'with',
  'policy',
  'sell',
  'your',
  'in',
  'of',
  'to',
  'it',
]);

/**
 * Detects Turkish or English: by Turkish letters, else by each language's
 * common words. Ties go to Turkish, the primary language. With `lettersOnly`,
 * the language-by-letters defect (ADR-0045), a message without Turkish
 * letters is English.
 */
export function detectLanguage(message: string, lettersOnly = false): Language {
  if (TURKISH_LETTERS.test(message)) return 'tr';
  if (lettersOnly) return 'en';
  let turkish = 0;
  let english = 0;
  for (const word of fold(message).split(/[^a-z0-9']+/u)) {
    if (TURKISH_HINTS.has(word)) turkish += 1;
    if (ENGLISH_HINTS.has(word)) english += 1;
  }
  return english > turkish ? 'en' : 'tr';
}

/** Formats an amount in Turkish lira: "2.499,90 TL" (tr) or "TRY 2,499.90" (en). */
export function formatMoney(amount: number, language: Language): string {
  const [whole = '0', fraction = '00'] = amount.toFixed(2).split('.');
  const separator = language === 'tr' ? '.' : ',';
  const grouped = whole.replaceAll(/\B(?=(\d{3})+(?!\d))/gu, separator);
  return language === 'tr' ? `${grouped},${fraction} TL` : `TRY ${grouped}.${fraction}`;
}

/** Parses "1.299,90" (tr) or "1,299.90" (en). */
export function parseAmount(raw: string, language: Language): number | undefined {
  const [thousands, decimal] = language === 'tr' ? ['.', ','] : [',', '.'];
  const value = Number(raw.split(thousands).join('').replace(decimal, '.'));
  return Number.isFinite(value) ? value : undefined;
}
