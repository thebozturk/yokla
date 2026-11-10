import { describe, expect, it } from 'vitest';
import { findPhrases, hasPhrase } from './phrases.ts';

describe('findPhrases', () => {
  it('matches at the start of a word and allows suffixes', () => {
    expect(hasPhrase('urun bulunmuyormus', ['bulunmuyor'])).toBe(true);
    expect(hasPhrase('tulunmuyor', ['bulunmuyor'])).toBe(false);
    expect(hasPhrase('abulunmuyor', ['bulunmuyor'])).toBe(false);
  });

  it('requires a word end for phrases ending in $', () => {
    expect(hasPhrase('bu urun yok.', ['yok$'])).toBe(true);
    expect(hasPhrase('yoksa baska', ['yok$'])).toBe(false);
  });

  it('returns every match in order, longest first at the same position', () => {
    expect(findPhrases('free of charge, free', ['free$', 'free of charge'])).toEqual([
      { phrase: 'free of charge', start: 0, end: 14 },
      { phrase: 'free$', start: 0, end: 4 },
      { phrase: 'free$', start: 16, end: 20 },
    ]);
  });

  it('ignores empty phrases', () => {
    expect(findPhrases('anything', ['', '$'])).toEqual([]);
  });
});
