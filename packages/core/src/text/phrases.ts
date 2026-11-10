// Phrase matching over folded text (lower-cased, without diacritics).
// A phrase matches at the start of a word, and any suffix may follow, so
// Turkish inflections match: "bulunmuyor" matches "bulunmuyormuş". A phrase
// ending in "$" must end at a word boundary: "yok$" matches "yok" but not
// "yoksa". Narrow detectors start from here (design §10).

export interface PhraseMatch {
  readonly phrase: string;
  readonly start: number;
  readonly end: number;
}

const WORD = /[\p{L}\p{N}]/u;

function isWordChar(char: string | undefined): boolean {
  return char !== undefined && WORD.test(char);
}

/** Every match of every phrase in `folded`, ordered by position. */
export function findPhrases(folded: string, phrases: readonly string[]): PhraseMatch[] {
  const matches: PhraseMatch[] = [];
  for (const entry of phrases) {
    const exact = entry.endsWith('$');
    const phrase = exact ? entry.slice(0, -1) : entry;
    if (phrase === '') continue;
    for (
      let start = folded.indexOf(phrase);
      start !== -1;
      start = folded.indexOf(phrase, start + 1)
    ) {
      const end = start + phrase.length;
      if (isWordChar(folded[start - 1])) continue;
      if (exact && isWordChar(folded[end])) continue;
      matches.push({ phrase: entry, start, end });
    }
  }
  return matches.toSorted((a, b) => a.start - b.start || b.end - a.end);
}

export function hasPhrase(folded: string, phrases: readonly string[]): boolean {
  return findPhrases(folded, phrases).length > 0;
}
