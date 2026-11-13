import { findPhrases } from '@yokla/core';
import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { turkish } from './index.ts';
import { findDurations, findMoney, fold, formatMoney } from './text.ts';

const amounts = (text: string) => findMoney(text).map((m) => [m.amount, m.currency]);

describe('fold', () => {
  it.each([
    ['ÇADIRI', 'cadiri'],
    ['İADE', 'iade'],
    ['Işık', 'isik'],
    ['YARDIMCI OLAMIYORUM', 'yardimci olamiyorum'],
    ['TL’den', "tl'den"],
  ])('%s → %s', (text, expected) => {
    expect(fold(text)).toBe(expected);
  });

  it('is idempotent', () => {
    fc.assert(fc.property(fc.string(), (text) => fold(fold(text)) === fold(text)));
  });
});

describe('findMoney', () => {
  it.each([
    ['Fiyatı 1.299,90 TL.', [[1299.9, 'TRY']]],
    ['₺1.299,90', [[1299.9, 'TRY']]],
    ['1299 TL', [[1299, 'TRY']]],
    ['899,50TL', [[899.5, 'TRY']]],
    ["1000 TL'nin altında", [[1000, 'TRY']]],
    ['1.000 liradan ucuz', [[1000, 'TRY']]],
    ['TRY 2.499,90', [[2499.9, 'TRY']]],
    ['1299.90 TL', [[1299.9, 'TRY']]],
    ['12.750,00 tl', [[12750, 'TRY']]],
    [
      '15 $ veya €20',
      [
        [15, 'USD'],
        [20, 'EUR'],
      ],
    ],
    [
      'Önce 2.499,90 TL, şimdi 1.999,90 TL',
      [
        [2499.9, 'TRY'],
        [1999.9, 'TRY'],
      ],
    ],
  ])('%s', (text, expected) => {
    expect(amounts(text)).toEqual(expected);
  });

  it.each([
    'Kafa Lambası 1000 Lümen',
    'Kubbe Çadır 2 Kişilik',
    'Yaz Uyku Tulumu +15°C',
    '12-18 ay arası',
    'Model 2024, 3 renk',
    'ATLAS 500 serisi',
    '14 gün içinde iade',
  ])('finds no money in %s', (text) => {
    expect(findMoney(text)).toEqual([]);
  });

  it('records where each amount is', () => {
    const text = 'Plaj Çadırı: 899,50 TL (stokta yok)';
    const [mention] = findMoney(text);
    expect(mention?.raw).toBe('899,50 TL');
    expect(text.slice(mention?.start, mention?.end)).toBe('899,50 TL');
  });

  it('reads back every formatted amount, even inside text', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 99_999_999 }),
        fc.constantFrom('', 'Fiyat: ', 'Sadece ', '- Ürün: '),
        fc.constantFrom('', '.', ' (stokta var)', ' altında'),
        (cents, before, after) => {
          const amount = cents / 100;
          const found = findMoney(`${before}${formatMoney(amount, 'TRY')}${after}`);
          return found.length === 1 && found[0]?.amount === amount && found[0].currency === 'TRY';
        },
      ),
    );
  });

  it('never reads a number without a currency marker as money', () => {
    const words = fc.constantFrom(
      'çadır',
      'beden',
      'renk',
      'kişilik',
      'lümen',
      'model',
      'cm',
      'adet',
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
  it('formats Turkish lira', () => {
    expect(formatMoney(1299.9, 'TRY')).toBe('1.299,90 TL');
    expect(formatMoney(0.5, 'TRY')).toBe('0,50 TL');
    expect(formatMoney(12, 'USD')).toBe('12,00 USD');
  });
});

describe('findDurations', () => {
  it.each([
    ['14 gün içinde iade', [[14, 'day']]],
    ['30 günlük iade süresi', [[30, 'day']]],
    ['2 hafta', [[2, 'week']]],
    [
      '1 yıl garanti, 2 yıldır',
      [
        [1, 'year'],
        [2, 'year'],
      ],
    ],
    ['6 ayda', [[6, 'month']]],
  ])('%s', (text, expected) => {
    expect(findDurations(text).map((d) => [d.amount, d.unit])).toEqual(expected);
  });

  it.each(['2 ayakkabı', '3 günaydın', 'günlük kullanım'])('finds no duration in %s', (text) => {
    expect(findDurations(text)).toEqual([]);
  });
});

function hits(kind: keyof typeof turkish.phrases, text: string): boolean {
  return findPhrases(turkish.fold(text), turkish.phrases[kind]).length > 0;
}

describe('phrases', () => {
  it.each([
    ['refusal', 'Bu konuda yardımcı olamıyorum.'],
    ['refusal', 'Maalesef öneri sunamıyorum.'],
    ['refusal', 'Yatırım konusu yardımcı olabileceğim bir konu değil.'],
    ['refusal', 'Bu, kapsamım dışında.'],
    ['refusal', 'Hisse önerisi, yardımcı olabildiğim konuların dışında.'],
    ['inability', 'Kargo koşullarını doğrulayamıyorum.'],
    ['inability', 'stok durumu doğrulanamadı'],
    ['absence', 'Kataloğumuzda uyku matı bulunmuyor.'],
    ['absence', '500 TL altı çadır bulamadım.'],
    ['absence', 'Bu ürün yok.'],
    ['alternative', 'Bunun yerine şu seçeneklere bakabilirsiniz'],
    ['free', 'Kargo ücretsizdir.'],
    ['deflection', 'Bu konuda müşteri hizmetlerimize başvurabilirsiniz.'],
    ['deflection', 'Canlı destek ve yardım merkezi: https://example.test'],
  ] as const)('%s: %s', (kind, text) => {
    expect(hits(kind, text)).toBe(true);
  });

  it.each([
    ['refusal', 'Size yardımcı olabilirim.'],
    ['refusal', 'Yardımcı olabildiğim konular şunlar: ürünler ve siparişler.'],
    ['absence', 'Yoksa başka bir şey mi istersiniz?'],
    ['absence', 'Bulunduğu ürünler şunlar'],
    ['free', 'Ücret 50 TL.'],
  ] as const)('not %s: %s', (kind, text) => {
    expect(hits(kind, text)).toBe(false);
  });
});

describe('commonWords', () => {
  it('holds each word once, already folded, as language-match compares them', () => {
    expect(turkish.commonWords.length).toBeGreaterThan(50);
    expect(new Set(turkish.commonWords).size).toBe(turkish.commonWords.length);
    for (const word of turkish.commonWords) expect(fold(word)).toBe(word);
  });
});
