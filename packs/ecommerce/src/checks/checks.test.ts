import type { CheckOutcome, EvidenceItem, LanguagePack } from '@yokla/core';
import { checkContext, mutate } from '@yokla/core/testing';
import { describe, expect, it } from 'vitest';
import { loadData } from '../data.ts';
import { ecommerceProfile } from '../schema.ts';
import { answer, data, fakeEnglish, fakeTurkish } from './fixtures.ts';
import { absenceCorrect } from './absence.ts';
import { filterHonoured } from './filters.ts';
import { noDuplicates } from './no-duplicates.ts';
import { policyClaim } from './policy-claim.ts';
import { priceGrounded } from './price-grounded.ts';
import { deflection, overRefusal } from './refusal.ts';
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

const RETURNS_TR = 'Ürünleri teslimattan itibaren 14 gün içinde iade edebilirsiniz.';
const RETURNS_EN = 'You can return items within 14 days of delivery.';
const withPolicies = data({
  policies: new Map([
    ['returns', { topic: 'returns', answers: { tr: RETURNS_TR, en: RETURNS_EN } }],
    ['shipping', { topic: 'shipping', answers: {} }],
    ['warranty', { topic: 'warranty', answers: { '*': 'Two years. Cargo costs 49,90 TL.' } }],
  ]),
});

describe('policy-claim', () => {
  const check = policyClaim(withPolicies);
  const run = (
    text: string,
    lang: LanguagePack = fakeTurkish,
    expectations: Record<string, unknown> = {},
  ) => verdicts(check.run(checkContext({ ...answer(text), expect: expectations }, { lang })));

  it('passes a claim that matches its source', () => {
    expect(run(RETURNS_TR)).toEqual(['pass']);
    expect(run(RETURNS_EN, fakeEnglish)).toEqual(['pass']);
  });

  it('lets any topic named in the sentence back the claim', () => {
    // returns' source lacks 49,90 TL; the warranty source has it.
    expect(run('İade ve garanti için 49,90 TL ödenir.')).toEqual(['pass']);
    expect(run('İade ve garanti için 59,90 TL ödenir.')).toEqual(['fail']);
  });

  it('fails each claim the source does not support', () => {
    const outcome = check.run(
      checkContext(answer('Ürünleri 30 gün içinde ücretsiz iade edebilirsiniz.'), {
        lang: fakeTurkish,
      }),
    );
    expect(verdicts(outcome)).toEqual(['fail']);
    expect(outcome.applicable && outcome.findings[0]?.evidence).toEqual({
      topic: 'returns',
      unsupported: ['30 day', 'free'],
    });
  });

  it('fails any concrete claim about a topic without a source', () => {
    expect(run('Kargo ücretsizdir ve 2 gün içinde teslim edilir.')).toEqual(['fail']);
  });

  it('accepts honest inability: no concrete claim, no finding against it', () => {
    expect(run('Kargo ve teslimat koşullarını doğrulayamıyorum.')).toEqual(['pass']);
  });

  it('attributes claims to the declared topic when the sentence names none', () => {
    expect(run('30 gün içinde yapabilirsiniz.', fakeTurkish, { policyTopic: 'returns' })).toEqual([
      'fail',
    ]);
  });

  it('does not judge a claim when the source exists only in another language', () => {
    const trOnly = policyClaim(
      data({ policies: new Map([['returns', { topic: 'returns', answers: { tr: RETURNS_TR } }]]) }),
    );
    const outcome = trOnly.run(
      checkContext(answer('Returns within 30 days.'), { lang: fakeEnglish }),
    );
    expect(verdicts(outcome)).toEqual(['pass']);
  });

  it('does not apply to an answer that mentions no policy', () => {
    expect(run('Çadır seçeneklerimiz: Kubbe Çadır')[0]).toMatch(/no policy topic/u);
  });

  it('catches a return period changed in the answer', () => {
    const mutated = mutate(answer(RETURNS_TR), (view) => ({
      ...view,
      response: { ...view.response, text: view.response.text.replace('14 gün', '15 gün') },
    }));
    expect(verdicts(check.run(checkContext(mutated, { lang: fakeTurkish })))).toEqual(['fail']);
  });
});

describe('price-grounded with policy sources', () => {
  it('accepts an amount quoted from a policy source', () => {
    const outcome = priceGrounded(withPolicies).run(
      checkContext(answer('Kargo ücreti 49,90 TL.'), { lang: fakeTurkish }),
    );
    expect(verdicts(outcome)).toEqual(['pass']);
  });
});

describe('over-refusal', () => {
  const check = overRefusal();
  const run = (
    text: string,
    answerable: unknown,
    lang: LanguagePack = fakeTurkish,
    profile = checkContext(answer('')).profile,
  ) =>
    verdicts(
      check.run(checkContext({ ...answer(text), expect: { answerable } }, { lang, profile })),
    );

  it('fails a refusal of an answerable request and passes an answer', () => {
    expect(run('Bu konuda yardımcı olamıyorum.', true)).toEqual(['fail']);
    expect(run('Kamp ocağı seçeneklerimiz:', true)).toEqual(['pass']);
  });

  it('does not count "not found" as a refusal', () => {
    expect(run('500 TL altı çadır bulamadım. Bunun yerine şunlara bakabilirsiniz:', true)).toEqual([
      'pass',
    ]);
  });

  it("recognises the profile's canonical refusal sentence", () => {
    const base = checkContext(answer('')).profile;
    const profile = { ...base, refusal: { canonical: { tr: ['Bu isteği karşılayamıyorum.'] } } };
    expect(run('Üzgünüm, bu isteği karşılayamıyorum.', true, fakeTurkish, profile)).toEqual([
      'fail',
    ]);
  });

  it('expects a refusal when the turn is not answerable', () => {
    const outcome = check.run(
      checkContext(
        { ...answer("I can't help with that."), expect: { answerable: false } },
        { lang: fakeEnglish },
      ),
    );
    expect(outcome.applicable && outcome.findings[0]).toMatchObject({
      dimension: 'refusal',
      verdict: 'pass',
    });
    expect(run('İşte yatırım önerilerim', false)).toEqual(['fail']);
  });

  it('does not apply when answerability is unknown', () => {
    expect(run('x', undefined)[0]).toMatch(/nothing about being answerable/u);
  });

  it('catches an answer turned into a refusal', () => {
    const base = { ...answer('Kamp ocağı seçeneklerimiz:'), expect: { answerable: true } };
    const mutated = mutate(base, (view) => ({
      ...view,
      response: { ...view.response, text: 'Bu konuda yardımcı olamıyorum.' },
    }));
    expect(verdicts(check.run(checkContext(mutated, { lang: fakeTurkish })))).toEqual(['fail']);
  });
});

describe('filter-honoured-or-disclosed', () => {
  const check = filterHonoured(data());
  const jackets = [
    { id: 'J1', name: 'Rüzgarlık', price: 899.9, color: 'blue' },
    { id: 'J2', name: 'Polar', price: 1199.9, color: 'black' },
  ];
  const run = (
    text: string,
    filters: unknown,
    products: EvidenceItem[] = tents,
    lang: LanguagePack = fakeTurkish,
  ) =>
    verdicts(check.run(checkContext({ ...answer(text, products), expect: { filters } }, { lang })));

  it('passes when every product satisfies the filters', () => {
    expect(run('Plaj Çadırı: 899,50 TL', { maxPrice: 1000 }, tents.slice(0, 1))).toEqual(['pass']);
    expect(run('Polar', { attributes: { color: 'black' } }, jackets.slice(1))).toEqual(['pass']);
  });

  it('passes a relaxation that is disclosed and names the price bound', () => {
    const text =
      'Bu kriterlere (500,00 TL altı) uyan çadır bulamadım. Bunun yerine şunlara bakabilirsiniz:';
    expect(run(text, { maxPrice: 500 })).toEqual(['pass']);
  });

  it('fails a silent relaxation', () => {
    expect(run('Kriterlerinize (500,00 TL altı) uyan çadırlar:', { maxPrice: 500 })).toEqual([
      'fail',
    ]);
    expect(run('Siyah montlar:', { attributes: { color: 'black' } }, jackets)).toEqual(['fail']);
  });

  it('fails a disclosure that does not name the relaxed price bound', () => {
    const outcome = check.run(
      checkContext(
        {
          ...answer('Aradığınızı bulamadım. Bunun yerine:', tents),
          expect: { filters: { maxPrice: 500 } },
        },
        { lang: fakeTurkish },
      ),
    );
    expect(verdicts(outcome)).toEqual(['fail']);
    expect(outcome.applicable && outcome.findings[0]?.evidence).toEqual({
      violated: ['maxPrice'],
      unnamed: ['maxPrice'],
    });
  });

  it('accepts disclosure wording alone for an attribute it relaxed', () => {
    expect(
      run('Siyah bulamadım, bunun yerine mavi:', { attributes: { color: 'black' } }, jackets),
    ).toEqual(['pass']);
  });

  it('says which filters it could not check', () => {
    const outcome = check.run(
      checkContext(
        { ...answer('Montlar', jackets), expect: { filters: { attributes: { size: 'M' } } } },
        { lang: fakeTurkish },
      ),
    );
    expect(outcome.applicable && outcome.findings[0]?.message).toMatch(/not checked: size/u);
  });

  it('does not apply without filters or products', () => {
    expect(run('x', undefined)[0]).toMatch(/no filters/u);
    expect(run('x', { maxPrice: 1 }, [])[0]).toMatch(/no products/u);
  });

  it('catches an unfiltered product slipped into the result', () => {
    const base = {
      ...answer('1.000,00 TL altı çadırlar:', tents.slice(0, 1)),
      expect: { filters: { maxPrice: 1000 } },
    };
    const mutated = mutate(base, (view) => ({
      ...view,
      response: { ...view.response, evidence: { products: tents } },
    }));
    expect(verdicts(check.run(checkContext(mutated, { lang: fakeTurkish })))).toEqual(['fail']);
  });
});

describe('absence-correct', () => {
  const check = absenceCorrect(data());
  const bags = [{ id: 'S1', name: 'Yaz Uyku Tulumu', price: 749.9 }];
  const run = (text: string, products: EvidenceItem[] = bags, lang: LanguagePack = fakeTurkish) =>
    verdicts(
      check.run(
        checkContext(
          { ...answer(text, products), expect: { absentType: 'sleeping-pad' } },
          { lang },
        ),
      ),
    );

  it('passes an absence statement with alternatives labelled as such', () => {
    expect(
      run('Kataloğumuzda uyku matı bulunmuyor. Farklı bir ürün olarak şu uyku tulumlarına bakın:'),
    ).toEqual(['pass', 'pass']);
    expect(
      run("We don't carry sleeping pads. As a different product, see these:", bags, fakeEnglish),
    ).toEqual(['pass', 'pass']);
    expect(run('Kataloğumuzda uyku matı bulunmuyor.', [])).toEqual(['pass']);
  });

  it('fails other products presented as the requested type', () => {
    expect(run('Uyku matı seçeneklerimiz:')).toEqual(['fail', 'fail']);
  });

  it('fails alternatives that are not labelled', () => {
    expect(run('Uyku matı bulunmuyor. İşte uyku matları:')).toEqual(['pass', 'fail']);
  });

  it('does not apply without an absent type', () => {
    expect(verdicts(check.run(checkContext(answer('x'), { lang: fakeTurkish })))[0]).toMatch(
      /no absent type/u,
    );
  });

  it('catches the absence statement removed from the answer', () => {
    const base = {
      ...answer('Kataloğumuzda uyku matı bulunmuyor. Farklı bir ürün olarak şunlar:', bags),
      expect: { absentType: 'sleeping-pad' },
    };
    const mutated = mutate(base, (view) => ({
      ...view,
      response: { ...view.response, text: 'Uyku matlarımız:' },
    }));
    expect(verdicts(check.run(checkContext(mutated, { lang: fakeTurkish })))).toEqual([
      'fail',
      'fail',
    ]);
  });
});

// Regressions found by running the demo-shop's defects (2026-11-10). The texts
// are the demo-shop's real answers.
describe('regressions from the demo-shop defect runs', () => {
  it('filter: "stokta yok" in a product line is not a disclosure of a relaxed filter', () => {
    const text = [
      'Kriterlerinize (1.000,00 TL altı) uyan çadır seçenekleri:',
      '- Plaj Çadırı: 899,50 TL (stokta yok)',
      '- Kubbe Çadır 2 Kişilik: 2.499,90 TL (stokta var)',
      '- Ultra Hafif Çadır 1 Kişilik: 4.250,00 TL (stok durumu doğrulanamadı)',
    ].join('\n');
    const outcome = filterHonoured(data()).run(
      checkContext(
        { ...answer(text, tents), expect: { filters: { maxPrice: 1000 } } },
        { lang: fakeTurkish },
      ),
    );
    expect(verdicts(outcome)).toEqual(['fail']);
  });

  it('absence: "stokta yok" in a product line is not an absence statement', () => {
    const text = 'Uyku matı seçeneklerimiz:\n- Yaz Uyku Tulumu: 749,90 TL (stokta yok)';
    const outcome = absenceCorrect(data()).run(
      checkContext(
        {
          ...answer(text, [{ id: 'S1', name: 'Yaz Uyku Tulumu', stock: 0 }]),
          expect: { absentType: 'sleeping-pad' },
        },
        { lang: fakeTurkish },
      ),
    );
    expect(verdicts(outcome)).toEqual(['fail', 'fail']);
  });

  it('stock: a claim on "Women\'s Windbreaker" is not about "Men\'s Windbreaker"', () => {
    const text = [
      "Here are jackets matching your criteria (women's, size: M):",
      "- Women's Windbreaker: TRY 899.90 (in stock)",
      "- Men's Windbreaker: TRY 899.90 (stock not confirmed)",
      "- Women's Fleece Jacket: TRY 1,199.90 (in stock)",
    ].join('\n');
    const products = [
      { id: 'JKT-001', name: "Women's Windbreaker", stock: 15 },
      { id: 'JKT-002', name: "Men's Windbreaker", stock: null },
      { id: 'JKT-003', name: "Women's Fleece Jacket", stock: 8 },
    ];
    const outcome = stockClaim(data()).run(
      checkContext(answer(text, products), { lang: fakeEnglish }),
    );
    expect(verdicts(outcome)).toEqual(['pass', 'pass']);
  });

  it('stock: the longest product name wins where names overlap', () => {
    const products = [
      { id: 'A', name: 'Kubbe Çadır', stock: null },
      { id: 'B', name: 'Kubbe Çadır 2 Kişilik', stock: 12 },
    ];
    const outcome = stockClaim(data()).run(
      checkContext(answer('- Kubbe Çadır 2 Kişilik: 2.499,90 TL (stokta var)', products), {
        lang: fakeTurkish,
      }),
    );
    expect(verdicts(outcome)).toEqual(['pass']);
  });
});

describe('clarifying turns and deflection', () => {
  it('absence-correct does not apply to a clarifying question', () => {
    const view = {
      ...answer('Hangi bedeni arıyorsunuz?', []),
      expect: { absentType: 'x' },
      clarifying: true,
    };
    expect(
      verdicts(absenceCorrect(data()).run(checkContext(view, { lang: fakeTurkish })))[0],
    ).toMatch(/clarifying question/u);
  });

  it('deflection flags an answerable turn sent only to customer service', () => {
    const check = deflection();
    const sent = {
      ...answer('Bu konuda müşteri hizmetlerimize başvurabilirsiniz.', []),
      expect: { answerable: true },
    };
    expect(verdicts(check.run(checkContext(sent, { lang: fakeTurkish })))).toEqual(['fail']);
    const withProducts = {
      ...answer('Müşteri hizmetlerimize de sorabilirsiniz. Ürünler:', tents),
      expect: { answerable: true },
    };
    expect(verdicts(check.run(checkContext(withProducts, { lang: fakeTurkish })))).toEqual([
      'pass',
    ]);
    const answered = { ...answer('İade süresi 14 gündür.', []), expect: { answerable: true } };
    expect(verdicts(check.run(checkContext(answered, { lang: fakeTurkish })))).toEqual(['pass']);
    expect(verdicts(check.run(checkContext(answer('x'), { lang: fakeTurkish })))[0]).toMatch(
      /not marked answerable/u,
    );
  });
});
