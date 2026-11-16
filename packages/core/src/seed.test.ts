import { describe, expect, it } from 'vitest';
import { seededFraction, seededIndex } from './seed.ts';

describe('seededFraction', () => {
  it('gives the same fraction for the same seed, in [0, 1)', () => {
    for (const seed of ['', 'a', 'case|0|1', 'çadır|2|3']) {
      const fraction = seededFraction(seed);
      expect(seededFraction(seed)).toBe(fraction);
      expect(fraction).toBeGreaterThanOrEqual(0);
      expect(fraction).toBeLessThan(1);
    }
  });

  it('spreads seeds over the range', () => {
    const buckets = [0, 0, 0, 0];
    for (let i = 0; i < 400; i += 1) {
      const bucket = Math.floor(seededFraction(`s|${String(i)}`) * 4);
      buckets[bucket] = (buckets[bucket] ?? 0) + 1;
    }
    for (const count of buckets) expect(count).toBeGreaterThan(60);
  });
});

describe('seededIndex', () => {
  it('draws an index below the count', () => {
    const seen = new Set<number>();
    for (let i = 0; i < 100; i += 1) {
      const index = seededIndex(`s|${String(i)}`, 3);
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThan(3);
      seen.add(index);
    }
    expect([...seen].toSorted((a, b) => a - b)).toEqual([0, 1, 2]);
    expect(seededIndex('anything', 1)).toBe(0);
  });
});
