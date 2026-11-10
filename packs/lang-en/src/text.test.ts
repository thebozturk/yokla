import { findPhrases } from '@yokla/core';
import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { english } from './index.ts';
import { findDurations, findMoney, fold, formatMoney } from './text.ts';

const amounts = (text: string) => findMoney(text).map((m) => [m.amount, m.currency]);

describe('fold', () => {
  it('lower-cases and normalises apostrophes', () => {
    expect(fold('I Can’t Help')).toBe("i can't help");
    expect(fold('Café')).toBe('cafe');
  });

  it('is idempotent', () => {
    fc.assert(fc.property(fc.string(), (text) => fold(fold(text)) === fold(text)));
  });
});

describe('findMoney', () => {
  it.each([
    ['TRY 1,299.90', [[1299.9, 'TRY']]],
    ['$15', [[15, 'USD']]],
    ['15 dollars', [[15, 'USD']]],
    ['€1,000.5', [[1000.5, 'EUR']]],
    ['1,299.90 TL', [[1299.9, 'TRY']]],
    ['under TRY 1,000.00', [[1000, 'TRY']]],
    [
      'was $20, now $15.99',
      [
        [20, 'USD'],
        [15.99, 'USD'],
      ],
    ],
  ])('%s', (text, expected) => {
    expect(amounts(text)).toEqual(expected);
  });

  it.each([
    'Headlamp 1000 lm',
    'Dome Tent, 2-Person',
    'size 42',
    'Summer Sleeping Bag +15°C',
    '30 days',
  ])('finds no money in %s', (text) => {
    expect(findMoney(text)).toEqual([]);
  });

  it('reads back every formatted amount, even inside text', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 99_999_999 }),
        fc.constantFrom('TRY', 'USD', 'EUR', 'GBP'),
        fc.constantFrom('', 'Price: ', '- Tent: '),
        fc.constantFrom('', '.', ' (in stock)'),
        (cents, currency, before, after) => {
          const amount = cents / 100;
          const found = findMoney(`${before}${formatMoney(amount, currency)}${after}`);
          return (
            found.length === 1 && found[0]?.amount === amount && found[0].currency === currency
          );
        },
      ),
    );
  });

  it('never reads a number without a currency marker as money', () => {
    const words = fc.constantFrom(
      'tent',
      'size',
      'person',
      'lm',
      'model',
      'cm',
      'pack',
      '-',
      ',',
      '.',
    );
    fc.assert(
      fc.property(
        fc.array(fc.oneof(words, fc.nat().map(String)), { maxLength: 12 }),
        (parts) => findMoney(parts.join(' ')).length === 0,
      ),
    );
  });
});

describe('formatMoney', () => {
  it('formats with symbols where common', () => {
    expect(formatMoney(1299.9, 'TRY')).toBe('TRY 1,299.90');
    expect(formatMoney(5, 'USD')).toBe('$5.00');
  });
});

describe('findDurations', () => {
  it.each([
    ['within 14 days of delivery', [[14, 'day']]],
    ['a 30-day return window', [[30, 'day']]],
    [
      '2 weeks or 1 year',
      [
        [2, 'week'],
        [1, 'year'],
      ],
    ],
  ])('%s', (text, expected) => {
    expect(findDurations(text).map((d) => [d.amount, d.unit])).toEqual(expected);
  });

  it('finds no duration in "3 daylong hikes"', () => {
    expect(findDurations('3 daylong hikes')).toEqual([]);
  });
});

function hits(kind: keyof typeof english.phrases, text: string): boolean {
  return findPhrases(english.fold(text), english.phrases[kind]).length > 0;
}

describe('phrases', () => {
  it.each([
    ['refusal', "I can't help with that."],
    ['refusal', 'I’m sorry, but I can’t do that'],
    ['inability', "I can't verify shipping terms"],
    ['inability', 'stock not confirmed'],
    ['absence', "We don't carry hammocks."],
    ['absence', "I couldn't find any tents"],
    ['alternative', 'Here are other tents instead'],
    ['free', 'Returns are free of charge'],
    ['free', 'Shipping is free.'],
  ] as const)('%s: %s', (kind, text) => {
    expect(hits(kind, text)).toBe(true);
  });

  it.each([
    ['refusal', 'I can help with products.'],
    ['free', 'Feel freely to ask'],
    ['absence', 'We have these.'],
  ] as const)('not %s: %s', (kind, text) => {
    expect(hits(kind, text)).toBe(false);
  });
});
