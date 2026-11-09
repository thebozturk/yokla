import { describe, expect, it } from 'vitest';
import { detectLanguage, fold, formatMoney, parseAmount } from './language.ts';

describe('fold', () => {
  it('applies Turkish casing and removes diacritics', () => {
    expect(fold('ÇADIRI')).toBe('cadiri');
    expect(fold('İADE')).toBe('iade');
    expect(fold('Işık')).toBe('isik');
    expect(fold('I want')).toBe('i want');
  });
});

describe('detectLanguage', () => {
  it.each([
    ['Çadır var mı?', 'tr'],
    ['cadir var mi', 'tr'],
    ['1000 tl alti mont', 'tr'],
    ['Do you have tents?', 'en'],
    ['Show me headlamps', 'en'],
    ['Merhaba', 'tr'],
  ] as const)('%s → %s', (message, expected) => {
    expect(detectLanguage(message)).toBe(expected);
  });
});

describe('money', () => {
  it.each([
    [899.5, '899,50 TL', 'TRY 899.50'],
    [2499.9, '2.499,90 TL', 'TRY 2,499.90'],
    [12750, '12.750,00 TL', 'TRY 12,750.00'],
    [1234567.8, '1.234.567,80 TL', 'TRY 1,234,567.80'],
  ])('formats %d', (amount, tr, en) => {
    expect(formatMoney(amount, 'tr')).toBe(tr);
    expect(formatMoney(amount, 'en')).toBe(en);
    expect(parseAmount(tr.replace(' TL', ''), 'tr')).toBe(amount);
    expect(parseAmount(en.replace('TRY ', ''), 'en')).toBe(amount);
  });
});
