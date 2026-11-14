import { describe, expect, it } from 'vitest';
import { textSimilarity } from './similarity.ts';

describe('textSimilarity (ADR-0030)', () => {
  it('is 1 for the same wording and 0 for nothing shared', () => {
    expect(textSimilarity('iade süresi 14 gündür', 'iade süresi 14 gündür')).toBeCloseTo(1, 12);
    expect(textSimilarity('abc', 'xyz')).toBe(0);
  });

  it('is symmetric, and between 0 and 1', () => {
    const pairs: [string, string][] = [
      ['kargo ücretsiz', 'ücretsiz kargo'],
      ['iade süresi 14 gün', 'iade süresi 30 gün'],
      ['merhaba', 'merhabalar'],
    ];
    for (const [a, b] of pairs) {
      const score = textSimilarity(a, b);
      expect(score).toBeCloseTo(textSimilarity(b, a), 12);
      expect(score).toBeGreaterThan(0);
      expect(score).toBeLessThan(1);
    }
  });

  it('ignores punctuation and spacing, and counts word starts and ends', () => {
    expect(textSimilarity('iade, süresi... 14 gün!', 'iade süresi 14 gün')).toBeCloseTo(1, 12);
    expect(textSimilarity('  iade   süresi ', 'iade süresi')).toBeCloseTo(1, 12);
    // "ab" alone has the trigrams " ab" and "ab ": a word, not part of one.
    expect(textSimilarity('ab', 'ab')).toBeCloseTo(1, 12);
    expect(textSimilarity('ab', 'xaby')).toBe(0);
  });

  it('follows a stem through its suffixes, closer than another word', () => {
    const suffixed = textSimilarity('iade süresi', 'iade süresini');
    const other = textSimilarity('iade süresi', 'kargo ücreti');
    expect(suffixed).toBeGreaterThan(0.8);
    expect(other).toBeLessThan(0.2);
  });

  it('counts characters, not code units', () => {
    // Two letters outside the basic plane share a code unit, but no character.
    expect(textSimilarity('x𐐀', 'x𐐁')).toBe(0);
    expect(textSimilarity('x𐐀', 'x𐐀')).toBeCloseTo(1, 12);
    expect(textSimilarity('ğüş', 'ğüş')).toBeCloseTo(1, 12);
  });

  it('counts a trigram as often as it occurs', () => {
    // " ab" and "ab " three times, "b a" twice, against " ab" and "ab " once.
    expect(textSimilarity('ab ab ab', 'ab')).toBeCloseTo(6 / (Math.sqrt(22) * Math.sqrt(2)), 12);
  });

  it('is 0 when either text has no letter or digit', () => {
    expect(textSimilarity('', 'merhaba')).toBe(0);
    expect(textSimilarity('...', 'merhaba')).toBe(0);
    expect(textSimilarity('', '')).toBe(0);
  });
});
