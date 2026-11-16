// Tolerance for typos (ADR-0045): a word the shop doesn't know, one edit away
// from exactly one word it knows, is read as that word. This is the correct
// shop's behaviour; a model-backed assistant reads past a typo the same way.
// Like yokla's typos, a typo here never changes a word's first letter, so a
// word such as "sadece" isn't read as "iade" with a suffix.

import { loadShopData } from './catalog.ts';
import { ENGLISH_HINTS, fold, TURKISH_HINTS } from './language.ts';
import {
  ABSENT_TYPES,
  CART_TERMS,
  CHEAPER_TERMS,
  COLORS,
  GENDERS,
  OUT_OF_SCOPE_TERMS,
  POLICY_TOPICS,
  PRODUCT_TYPES,
} from './vocabulary.ts';

/** The words of the price and size phrases the scripted model reads, folded. */
const PHRASE_WORDS = [
  'alti',
  'altinda',
  'altindaki',
  'ucuz',
  'fazla',
  'ustu',
  'uzeri',
  'uzerinde',
  'uzerindeki',
  'pahali',
  'beden',
  'numara',
  'under',
  'below',
  'less',
  'than',
  'cheaper',
  'most',
  'over',
  'above',
  'more',
  'least',
  'size',
];

/**
 * The words the shop reads requests by, folded: its terms' words and its
 * phrases' words. A typo is read as one of them.
 */
export const VOCABULARY_WORDS: ReadonlySet<string> = new Set([
  ...[...PRODUCT_TYPES, ...ABSENT_TYPES, ...COLORS, ...GENDERS, ...POLICY_TOPICS].flatMap((entry) =>
    entry.terms.flatMap((term) => term.split(' ')),
  ),
  ...[...OUT_OF_SCOPE_TERMS, ...CHEAPER_TERMS, ...CART_TERMS].flatMap((term) => term.split(' ')),
  ...PHRASE_WORDS,
]);

/**
 * Words the shop knows besides its vocabulary, never read as a typo of
 * another word: each language's common words ("show" isn't "shoe"), and the
 * words of its products' names ("carbon" isn't "cart" and a suffix).
 */
const OTHER_KNOWN_WORDS: ReadonlySet<string> = new Set([
  ...TURKISH_HINTS,
  ...ENGLISH_HINTS,
  ...loadShopData()
    .catalog.flatMap((product) => [product.name.tr, product.name.en])
    .flatMap((name) => fold(name).split(/[^a-z]+/u)),
]);

/** Whether `a` becomes `b` by one edit: a letter replaced, dropped, added, or two neighbours swapped. */
export function oneEdit(a: string, b: string): boolean {
  if (a === b) return false;
  if (a.length === b.length) {
    const differ: number[] = [];
    for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) differ.push(i);
    if (differ.length === 1) return true;
    const [i, j] = differ;
    return differ.length === 2 && i !== undefined && j === i + 1 && a[i] === b[j] && a[j] === b[i];
  }
  // One letter more: past the first difference, the rest is the same. Two or more
  // letters more leave rests of different lengths.
  const [long, short] = a.length > b.length ? [a, b] : [b, a];
  let i = 0;
  while (i < short.length && long[i] === short[i]) i += 1;
  return long.slice(i + 1) === short.slice(i);
}

/** A way to read a word: as `word`, over its first `length` letters. */
interface Reading {
  readonly word: string;
  readonly length: number;
}

/** The ways to read a word as a vocabulary word with the same first letter, or a stem and a suffix. */
function readings(word: string): Reading[] {
  const found: Reading[] = [];
  for (const known of VOCABULARY_WORDS) {
    if (known[0] !== word[0]) continue;
    if (known.length >= 4 && word.startsWith(known)) {
      found.push({ word: known, length: known.length });
    } else if (oneEdit(word, known)) {
      found.push({ word: known, length: word.length });
    } else if (known.length >= 4) {
      const length = [known.length - 1, known.length, known.length + 1].find(
        (start) => start >= 4 && start < word.length && oneEdit(word.slice(0, start), known),
      );
      if (length !== undefined) found.push({ word: known, length });
    }
  }
  return found;
}

/**
 * The word a word of four letters or more is a typo of. The reading that
 * covers most of the word wins, and only when one vocabulary word gives it;
 * a reading without a typo gives the word back as written. So "headalmps" is
 * "headlamps", not "head"; "ocagi" stays, as "ocag" and a suffix, not "ocak";
 * and "mati", one edit from both "mat" and "mavi", stays as written.
 */
function correction(word: string): string | undefined {
  if (word.length < 4 || VOCABULARY_WORDS.has(word) || OTHER_KNOWN_WORDS.has(word)) {
    return undefined;
  }
  const found = readings(word);
  const longest = Math.max(0, ...found.map((reading) => reading.length));
  const best = found.filter((reading) => reading.length === longest);
  const words = new Set(best.map((reading) => reading.word));
  const [only] = words;
  return words.size === 1 && only !== undefined ? only + word.slice(longest) : undefined;
}

/** Folded text with each typo of a vocabulary word read as that word. */
export function correctTypos(text: string): string {
  return text.replaceAll(/[a-z]+/gu, (word) => correction(word) ?? word);
}
