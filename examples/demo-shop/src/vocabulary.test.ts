import { describe, expect, it } from 'vitest';
import {
  ABSENT_TYPES,
  CART_TERMS,
  CHEAPER_TERMS,
  COLORS,
  ENGLISH_TOO,
  GENDERS,
  HANDOFF_TERMS,
  longestTerm,
  OUT_OF_SCOPE_TERMS,
  POLICY_TOPICS,
  PRODUCT_TYPES,
  type Terms,
} from './vocabulary.ts';

/** Every list the scripted model reads requests by. */
const LISTS: readonly Terms[] = [
  ...[...PRODUCT_TYPES, ...ABSENT_TYPES, ...COLORS, ...GENDERS, ...POLICY_TOPICS].map(
    (entry) => entry.terms,
  ),
  OUT_OF_SCOPE_TERMS,
  CHEAPER_TERMS,
  CART_TERMS,
  HANDOFF_TERMS,
];
const TURKISH = LISTS.flatMap((terms) => terms.tr);
const ENGLISH = LISTS.flatMap((terms) => terms.en);

/** Whether a folded text, written in `written`, holds `term`, read as a word of its language. */
function reads(text: string, term: string, language: 'tr' | 'en', written: 'tr' | 'en'): boolean {
  const terms: Terms = language === 'tr' ? { tr: [term], en: [] } : { tr: [], en: [term] };
  return longestTerm(text, terms, written) === term.length;
}

describe('longestTerm: a word in its own language (ADR-0107)', () => {
  it.each(TURKISH)('reads the Turkish "%s" with any suffix in a Turkish message', (term) => {
    expect(reads(`a ${term} b`, term, 'tr', 'tr')).toBe(true);
    expect(reads(`a ${term}lar b`, term, 'tr', 'tr')).toBe(true);
    expect(reads(`a ${term}h b`, term, 'tr', 'tr')).toBe(true);
  });

  it.each(TURKISH.filter((term) => !ENGLISH_TOO.includes(term)))(
    'reads the Turkish "%s" in an English message alone or with an ending a shopper writes, not inside a longer word',
    (term) => {
      for (const ending of ['', 's', "'s", '’s', 'i', 'u', 'si', 'su']) {
        expect(reads(`a ${term}${ending} b`, term, 'tr', 'en'), ending).toBe(true);
        expect(reads(`a ${term}${ending}`, term, 'tr', 'en'), ending).toBe(true);
      }
      for (const longer of ['lar', 'h', 'ss', 'sis', '0']) {
        expect(reads(`a ${term}${longer} b`, term, 'tr', 'en'), longer).toBe(false);
      }
    },
  );

  it.each(ENGLISH_TOO)(
    'reads "%s", a Turkish word that is English too, only in a Turkish message',
    (term) => {
      expect(TURKISH).toContain(term);
      expect(reads(`a ${term} b`, term, 'tr', 'tr')).toBe(true);
      expect(reads(`a ${term} b`, term, 'tr', 'en')).toBe(false);
      expect(reads(`a ${term}s b`, term, 'tr', 'en')).toBe(false);
    },
  );

  it.each(ENGLISH.filter((term) => term.length >= 4))(
    'reads the English "%s" with any suffix in a message of either language',
    (term) => {
      for (const written of ['tr', 'en'] as const) {
        expect(reads(`a ${term} b`, term, 'en', written), written).toBe(true);
        expect(reads(`a ${term}ing b`, term, 'en', written), written).toBe(true);
        expect(reads(`a ${term}ss b`, term, 'en', written), written).toBe(true);
      }
    },
  );

  it('knows men, man and red as its English words of fewer than four letters (ADR-0108)', () => {
    expect(ENGLISH.filter((term) => term.length < 4).toSorted()).toEqual(['man', 'men', 'red']);
  });

  it.each(ENGLISH.filter((term) => term.length < 4))(
    'reads the short English "%s" alone or with a plural s, not at the start of a longer word (ADR-0108)',
    (term) => {
      for (const written of ['tr', 'en'] as const) {
        for (const ending of ['', 's', "'s", '’s']) {
          expect(reads(`a ${term}${ending} b`, term, 'en', written), ending).toBe(true);
          expect(reads(`a ${term}${ending}`, term, 'en', written), ending).toBe(true);
        }
        for (const longer of ['ager', 'y', 'u', 'tion', 'uce', 'gal', 'ss', 'es', '1']) {
          expect(reads(`a ${term}${longer} b`, term, 'en', written), longer).toBe(false);
        }
      }
    },
  );

  it('reads a term only at the start of a word, and gives the longest', () => {
    expect(longestTerm('x matara', { tr: ['matara'], en: [] }, 'en')).toBe(6);
    expect(longestTerm('xmatara', { tr: ['matara'], en: [] }, 'en')).toBe(0);
    expect(
      longestTerm('a water bottle', { tr: ['matara'], en: ['bottle', 'water bottle'] }, 'en'),
    ).toBe(12);
    expect(longestTerm('kamp ocagi', { tr: ['ocag', 'kamp ocag'], en: ['stove'] }, 'en')).toBe(9);
    expect(longestTerm('nothing here', { tr: ['matara'], en: ['bottle'] }, 'tr')).toBe(0);
  });
});
