import { describe, expect, it } from 'vitest';
import type { LanguagePack } from '../checks/types.ts';
import { stubLanguagePack } from '../testing.ts';
import { findQuantities } from './quantities.ts';

/** A pack with "four", and money and durations in a fixed shape: "$N" and "N days". */
const pack: LanguagePack = {
  ...stubLanguagePack('en'),
  numberWords: { four: 4, twenty: 20 },
  findMoney: (text) =>
    [...text.matchAll(/\$(\d+(?:\.\d+)?)/gu)].map((m) => ({
      amount: Number(m[1]),
      currency: 'USD',
      raw: m[0],
      start: m.index,
      end: m.index + m[0].length,
    })),
  findDurations: (text) =>
    [...text.matchAll(/(\d+) days/gu)].map((m) => ({
      amount: Number(m[1]),
      unit: 'day' as const,
      raw: m[0],
      start: m.index,
      end: m.index + m[0].length,
    })),
};
const values = (text: string) => findQuantities(text, pack).map((q) => q.value);

describe('findQuantities', () => {
  it('finds quantities in digits and in number words, in order, with their place', () => {
    expect(findQuantities('Four bags, $356 for 4 people, x3.', pack)).toEqual([
      { value: 4, raw: 'Four', start: 0, end: 4 },
      { value: 4, raw: '4', start: 20, end: 21 },
      { value: 3, raw: '3', start: 31, end: 32 },
    ]);
  });

  it('leaves out the numbers of money amounts and durations', () => {
    expect(values('$89 each, returns within 14 days, $12.50 shipping')).toEqual([]);
  });

  it('leaves out 1, 100 and up, decimals, and numbers followed by % or °', () => {
    expect(values('1 tent, 100 pegs, 4.5 kg, 20% off, 20°F, 20 °C')).toEqual([]);
  });

  it('matches number words whole, not inside other words', () => {
    expect(values('the fourth bag, fourteen pegs, twentyish')).toEqual([]);
    expect(values('twenty pegs')).toEqual([20]);
  });
});
