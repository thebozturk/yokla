import type { CheckOutcome, EvidenceItem, LanguagePack } from '@yokla/core';
import { checkContext, mutate } from '@yokla/core/testing';
import { describe, expect, it } from 'vitest';
import { loadData } from '../data.ts';
import { ecommerceProfile } from '../schema.ts';
import { answer, data, fakeEnglish, fakeTurkish } from './fixtures.ts';
import { noDuplicates } from './no-duplicates.ts';
import { priceGrounded } from './price-grounded.ts';
import { stockClaim } from './stock-claim.ts';

function verdicts(outcome: CheckOutcome): string[] {
  return outcome.applicable ? outcome.findings.map((f) => f.verdict) : [`n/a: ${outcome.reason}`];
}

const tents = [
  { id: 'T1', name: 'Plaj Çadırı', price: 899.5, currency: 'TRY', stock: 0 },
  { id: 'T2', name: 'Kubbe Çadır', price: 2499.9, currency: 'TRY', stock: 12 },
  { id: 'T3', name: 'Ultra Hafif Çadır', price: 4250, currency: 'TRY', stock: null },
];
const honest = [
  'Çadır seçeneklerimiz:',
  '- Plaj Çadırı: 899,50 TL (stokta yok)',
  '- Kubbe Çadır: 2.499,90 TL (stokta var)',
  '- Ultra Hafif Çadır: 4.250,00 TL (stok durumu doğrulanamadı)',
].join('\n');

describe('price-grounded', () => {
  const check = priceGrounded(data());
  const run = (text: string, products: EvidenceItem[] = tents, user = 'çadır', extra = {}) =>
    verdicts(
      check.run(checkContext(answer(text, products, user), { lang: fakeTurkish, ...extra })),
    );

  it('passes when every amount is a returned price', () => {
    expect(run(honest)).toEqual(['pass']);
  });

  it('fails each amount that is not a returned price', () => {
    expect(run(honest.replace('899,50 TL', '809,55 TL'))).toEqual(['fail']);
  });

  it("accepts the user's own amounts, with or without a currency", () => {
    expect(
      run('1.000,00 TL altındaki çadırlar: Plaj Çadırı 899,50 TL', tents, '1000 TL altında çadır'),
    ).toEqual(['pass']);
    const english = priceGrounded(data()).run(
      checkContext(
        answer(
          'Backpacks under TRY 1,000.00: TRY 649.90',
          [{ id: 'B', price: 649.9 }],
          'under 1000',
        ),
        {
          lang: fakeEnglish,
        },
      ),
    );
    expect(verdicts(english)).toEqual(['pass']);
  });

  it('accepts prices of products returned earlier in the conversation', () => {
    const earlier = answer(honest, tents);
    const context = checkContext(answer('En ucuzu 899,50 TL.', [], 'daha ucuz?'), {
      lang: fakeTurkish,
      history: [earlier],
    });
    expect(verdicts(check.run(context))).toEqual(['pass']);
  });

  it('accepts a campaign amount the profile declares', () => {
    const withCampaign = priceGrounded(
      data({
        config: ecommerceProfile.parse({
          campaigns: [{ id: 'cargo', amount: 49.9, currency: 'TRY' }],
        }),
      }),
    );
    const context = checkContext(answer('Kargo 49,90 TL.', tents), { lang: fakeTurkish });
    expect(verdicts(withCampaign.run(context))).toEqual(['pass']);
  });

  it('does not match an amount in another currency', () => {
    const context = checkContext(
      answer('Only $15', [{ id: 'X', price: 15, currency: 'TRY' }], 'x'),
      {
        lang: fakeEnglish,
      },
    );
    expect(verdicts(check.run(context))).toEqual(['fail']);
  });

  it('does not apply without money or without a language pack', () => {
    expect(run('Hangi çadır?')).toEqual(['n/a: the answer mentions no money']);
    expect(verdicts(check.run(checkContext(answer(honest, tents))))[0]).toMatch(
      /no language pack/u,
    );
  });

  it('catches a price changed in the answer', () => {
    const base = answer(honest, tents);
    const mutated = mutate(base, (view) => ({
      ...view,
      response: {
        ...view.response,
        text: view.response.text.replace('2.499,90 TL', '2.249,91 TL'),
      },
    }));
    expect(verdicts(check.run(checkContext(mutated, { lang: fakeTurkish })))).toEqual(['fail']);
  });
});

describe('no-duplicates', () => {
  const check = noDuplicates(data());

  it('passes distinct products and fails repeated ones', () => {
    expect(verdicts(check.run(checkContext(answer('', tents))))).toEqual(['pass']);
    const outcome = check.run(checkContext(answer('', [...tents, tents[0] ?? {}])));
    expect(verdicts(outcome)).toEqual(['fail']);
    expect(outcome.applicable && outcome.findings[0]?.evidence).toEqual({ duplicates: ['T1'] });
  });

  it('does not apply without products or ids', () => {
    expect(verdicts(check.run(checkContext(answer('', []))))[0]).toMatch(/no products/u);
    expect(verdicts(check.run(checkContext(answer('', [{ name: 'x' }]))))[0]).toMatch(/no id/u);
  });

  it('catches a product added twice', () => {
    const mutated = mutate(answer('', tents), (view) => ({
      ...view,
      response: { ...view.response, evidence: { products: [...tents, ...tents.slice(1, 2)] } },
    }));
    expect(verdicts(check.run(checkContext(mutated)))).toEqual(['fail']);
  });
});

describe('stock-claim', () => {
  const check = stockClaim(data());
  const run = (text: string, products: EvidenceItem[] = tents, lang: LanguagePack = fakeTurkish) =>
    verdicts(check.run(checkContext(answer(text, products), { lang })));

  it('accepts claims that match known stock and an honest "unknown"', () => {
    expect(run(honest)).toEqual(['pass', 'pass']);
  });

  it('fails a claim about a product whose stock is unknown', () => {
    expect(run(honest.replace('stok durumu doğrulanamadı', 'stokta var'))).toEqual([
      'pass',
      'pass',
      'fail',
    ]);
  });

  it('says why: the stock of the product is unknown', () => {
    const outcome = check.run(
      checkContext(answer('- Ultra Hafif Çadır: 4.250,00 TL (stokta var)', tents), {
        lang: fakeTurkish,
      }),
    );
    expect(outcome.applicable && outcome.findings[0]).toMatchObject({
      verdict: 'fail',
      message: 'claims Ultra Hafif Çadır is in stock, but its stock is unknown',
      evidence: { product: 'T3', claim: 'in', stock: null },
    });
  });

  it('fails a claim that contradicts known stock', () => {
    expect(run('- Plaj Çadırı: 899,50 TL (stokta var)')).toEqual(['fail']);
  });

  it('reads "not in stock" as one claim, not also "in stock"', () => {
    const product = [{ id: 'H', name: 'Headlamp', stock: 0 }];
    expect(run('The Headlamp is not in stock.', product, fakeEnglish)).toEqual(['pass']);
    expect(
      run('The Headlamp is not in stock.', [{ ...product[0], stock: 5 }], fakeEnglish),
    ).toEqual(['fail']);
  });

  it('ties a claim in a sentence without a product name to the only product', () => {
    expect(
      run('Bu ürün stokta var.', [{ id: 'T3', name: 'Ultra Hafif Çadır', stock: null }]),
    ).toEqual(['fail']);
  });

  it('reads stock from the catalog when the response has none', () => {
    const catalog = new Map([
      ['T9', { id: 'T9', type: 'tent', price: 10, currency: 'TRY', stock: null }],
    ]);
    const outcome = stockClaim(data({ catalog })).run(
      checkContext(answer('- Dağ Çadırı (stokta var)', [{ id: 'T9', name: 'Dağ Çadırı' }]), {
        lang: fakeTurkish,
      }),
    );
    expect(verdicts(outcome)).toEqual(['fail']);
  });

  it('does not judge what yokla cannot see', () => {
    expect(run('- X (stokta var)', [{ id: 'X', name: 'X' }])[0]).toMatch(
      /neither in the response nor in the catalog/u,
    );
    const catalog = new Map([
      ['Y', { id: 'Y', type: 'tent', price: 1, currency: 'TRY', stock: 3 }],
    ]);
    const unseen = stockClaim(data({ catalog })).run(
      checkContext(
        answer('- X (stokta var)', [
          { id: 'X', name: 'X' },
          { id: 'Y', name: 'Y' },
        ]),
        { lang: fakeTurkish },
      ),
    );
    expect(verdicts(unseen)[0]).toMatch(/cannot see/u);
  });

  it('passes a product list without stock claims', () => {
    expect(run('Çadır seçeneklerimiz: Kubbe Çadır')).toEqual(['pass']);
  });

  it('catches an unknown stock turned into a claim', () => {
    const mutated = mutate(answer(honest, tents), (view) => ({
      ...view,
      response: {
        ...view.response,
        text: view.response.text.replace('stok durumu doğrulanamadı', 'stokta mevcut'),
      },
    }));
    expect(verdicts(check.run(checkContext(mutated, { lang: fakeTurkish }))).includes('fail')).toBe(
      true,
    );
  });
});

describe('loadData', () => {
  const files: Record<string, string> = {
    'catalog.jsonl': [
      JSON.stringify({ sku: 'A', path: 'x/tent', amount: '10.50', cur: 'TRY', qty: 3 }),
      JSON.stringify({ sku: 'B', path: 'x/tent', amount: 20, cur: 'TRY', qty: null }),
    ].join('\n'),
    'faq.jsonl': [
      JSON.stringify({ topic: 'returns', lang: 'tr', answer: '14 gün' }),
      JSON.stringify({ topic: 'returns', lang: 'en', answer: '14 days' }),
      JSON.stringify({ topic: 'other', lang: 'tr', answer: 'x' }),
    ].join('\n'),
  };
  const io = {
    readText: (path: string) => {
      const file = files[path];
      if (file === undefined) throw new Error(`no ${path}`);
      return file;
    },
  };

  it('loads the catalog with its field mapping and the policy sources', () => {
    const profile = checkContext(answer('')).profile;
    const loaded = loadData(
      {
        ...profile,
        ecommerce: {
          catalog: {
            kind: 'file',
            path: 'catalog.jsonl',
            fields: { id: 'sku', type: 'path', price: 'amount', currency: 'cur', stock: 'qty' },
          },
          policies: {
            returns: { source: 'faq', path: 'faq.jsonl' },
            shipping: { source: 'none' },
            warranty: { source: 'text', text: 'Two years.' },
          },
        },
      },
      io,
    );
    expect(loaded.catalog?.get('A')).toEqual({
      id: 'A',
      type: 'x/tent',
      price: 10.5,
      currency: 'TRY',
      stock: 3,
    });
    expect(loaded.catalog?.get('B')?.stock).toBeNull();
    expect(loaded.policies.get('returns')?.answers).toEqual({ tr: '14 gün', en: '14 days' });
    expect(loaded.policies.get('shipping')?.answers).toEqual({});
    expect(loaded.policies.get('warranty')?.answers).toEqual({ '*': 'Two years.' });
  });

  it('reports a broken catalog line with its position', () => {
    const profile = checkContext(answer('')).profile;
    const broken = { readText: () => '{"sku":"A"}\n{oops' };
    expect(() =>
      loadData(
        {
          ...profile,
          ecommerce: {
            catalog: {
              kind: 'file',
              path: 'c.jsonl',
              fields: { id: 'sku', type: 't', price: 'p' },
            },
          },
        },
        broken,
      ),
    ).toThrow(/c\.jsonl:2: not valid JSON/u);
  });
});
