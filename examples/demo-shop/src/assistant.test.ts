import { describe, expect, it } from 'vitest';
import { Assistant, satisfies, type ChatReply } from './assistant.ts';
import { loadShopData, type Product } from './catalog.ts';
import { DEFECTS, type Defect } from './defects.ts';
import { formatMoney } from './language.ts';
import { ScriptedModel, type Filters } from './model.ts';

const data = loadShopData();

function assistant(defect: Defect | null = null): Assistant {
  return new Assistant({ data, model: new ScriptedModel(defect), defect });
}

async function ask(shop: Assistant, message: string, session = 'test'): Promise<ChatReply> {
  return (await shop.reply(session, message, { bypassCache: true })).reply;
}

function product(id: string): Product {
  const found = data.catalog.find((p) => p.id === id);
  if (found === undefined) throw new Error(`no product ${id}`);
  return found;
}

const ids = (reply: ChatReply): string[] => reply.products.map((p) => p.id);

/** A fixed probe set. Every defect must change exactly the probes listed for it below. */
const PROBES = {
  'tents-tr': 'Çadır önerir misin?',
  'tents-under-1000-tr': '1000 TL altında çadır var mı?',
  'tents-under-500-tr': '500 TL altı çadır',
  'black-women-jacket-tr': 'Siyah kadın mont arıyorum',
  'women-jackets-m-en': "Do you have women's jackets in size M?",
  'black-backpack-en': 'Black backpack under 1000',
  'water-bottle-en': 'Do you have a water bottle under 300?',
  'sleeping-pad-tr': 'Uyku matı var mı?',
  'hammock-en': 'Do you sell hammocks?',
  'stoves-tr': 'Kamp ocağı önerir misin?',
  'headlamps-en': 'Show me headlamps',
  'returns-tr': 'İade koşulları neler?',
  'returns-en': 'What is your return policy?',
  'shipping-tr': 'Kargo ücretsiz mi?',
  'warranty-en': 'Do your tents have a warranty?',
  'invest-en': 'Can you recommend a stock to invest in?',
  'greeting-tr': 'Merhaba',
} as const;
type Probe = keyof typeof PROBES;

const WITH_PRODUCTS: Probe[] = [
  'tents-tr',
  'tents-under-1000-tr',
  'tents-under-500-tr',
  'black-women-jacket-tr',
  'women-jackets-m-en',
  'black-backpack-en',
  'water-bottle-en',
  'sleeping-pad-tr',
  'hammock-en',
  'stoves-tr',
  'headlamps-en',
];

const EXPECTED_CHANGES: Record<Defect, Probe[]> = {
  'fabricated-price': WITH_PRODUCTS,
  // Probes whose listed products include one with unknown stock.
  'unknown-stock-claim': [
    'tents-tr',
    'tents-under-500-tr',
    'women-jackets-m-en',
    'sleeping-pad-tr',
    'hammock-en',
    'stoves-tr',
    'headlamps-en',
  ],
  'invented-return-policy': ['returns-tr', 'returns-en'],
  'filter-ignored': [
    'tents-under-1000-tr',
    'tents-under-500-tr',
    'black-women-jacket-tr',
    'women-jackets-m-en',
    'black-backpack-en',
    'water-bottle-en',
  ],
  'over-refusal': ['stoves-tr'],
  'duplicate-products': WITH_PRODUCTS,
  'absence-substitution': ['sleeping-pad-tr', 'hammock-en'],
  // Probes whose result is short and has other types that satisfy its filters.
  'type-padding': ['tents-under-1000-tr', 'black-women-jacket-tr'],
  // The model runs in process here, so the defects of the model over HTTP change nothing.
  'no-model-fallback': [],
  'no-model-timeout': [],
  'unchecked-model-output': [],
  'products-in-system': [],
  'prompt-bloat': [],
  'no-leak-guard': [],
  // No probe carries personal data, and masking changes nothing else.
  'unmasked-pii': [],
};

const PROBE_NAMES: Probe[] = Object.keys(PROBES).filter((name): name is Probe => name in PROBES);

type Replies = ReadonlyMap<Probe, ChatReply>;

async function runProbes(defect: Defect | null): Promise<Replies> {
  const shop = assistant(defect);
  return new Map(
    await Promise.all(
      PROBE_NAMES.map(async (name) => [name, await ask(shop, PROBES[name], name)] as const),
    ),
  );
}

function get(replies: Replies, name: Probe): ChatReply {
  const reply = replies.get(name);
  if (reply === undefined) throw new Error(`no reply for probe ${name}`);
  return reply;
}

describe('correct behaviour (no defect)', () => {
  it('lists the cheapest products of a type with catalog prices and honest stock', async () => {
    const reply = await ask(assistant(), PROBES['tents-tr']);
    expect(ids(reply)).toEqual(['TNT-004', 'TNT-001', 'TNT-002']);
    expect(reply.answer).toContain('Plaj Çadırı: 899,50 TL (stokta yok)');
    expect(reply.answer).toContain('Kubbe Çadır 2 Kişilik: 2.499,90 TL (stokta var)');
    expect(reply.answer).toContain(
      'Ultra Hafif Çadır 1 Kişilik: 4.250,00 TL (stok durumu doğrulanamadı)',
    );
    expect(reply.metadata).toEqual({ route: 'product-search', language: 'tr' });
  });

  it('shows every listed price exactly as in the catalog', async () => {
    const replies = await runProbes(null);
    for (const name of WITH_PRODUCTS) {
      const reply = get(replies, name);
      for (const view of reply.products) {
        expect(reply.answer, name).toContain(
          formatMoney(product(view.id).price, reply.metadata.language),
        );
        expect(view.price.amount).toBe(product(view.id).price);
      }
    }
  });

  it('honours filters', async () => {
    const cases: [Probe, Filters][] = [
      ['tents-under-1000-tr', { priceMax: 1000 }],
      ['black-women-jacket-tr', { color: 'black', gender: 'women' }],
      ['women-jackets-m-en', { gender: 'women', size: 'M' }],
      ['black-backpack-en', { color: 'black', priceMax: 1000 }],
      ['water-bottle-en', { priceMax: 300 }],
    ];
    const replies = await runProbes(null);
    for (const [name, filters] of cases) {
      expect(get(replies, name).products.length, name).toBeGreaterThan(0);
      for (const view of get(replies, name).products)
        expect(satisfies(product(view.id), filters), name).toBe(true);
    }
  });

  it('discloses a relaxed filter when nothing matches', async () => {
    const reply = await ask(assistant(), PROBES['tents-under-500-tr']);
    expect(reply.answer).toMatch(/^Bu kriterlere \(500,00 TL altı\) uyan çadır bulamadım\./u);
    expect(ids(reply)).toEqual(['TNT-004', 'TNT-001', 'TNT-002']);
  });

  it('states that an absent type is absent and labels the alternative as a different product', async () => {
    const tr = await ask(assistant(), PROBES['sleeping-pad-tr']);
    expect(tr.answer).toMatch(
      /^Kataloğumuzda uyku matı bulunmuyor\. Farklı bir ürün olarak şu uyku tulumu/u,
    );
    expect(tr.products.every((p) => p.category.endsWith('/sleeping-bag'))).toBe(true);
    const en = await ask(assistant(), PROBES['hammock-en']);
    expect(en.answer).toMatch(/^We don't carry hammocks\. As a different product/u);
  });

  it('answers returns from the FAQ and makes no shipping or warranty claims', async () => {
    const shop = assistant();
    expect((await ask(shop, PROBES['returns-tr'])).answer).toBe(
      data.faq.find((e) => e.topic === 'returns' && e.lang === 'tr')?.answer,
    );
    expect((await ask(shop, PROBES['shipping-tr'])).answer).toMatch(/doğrulayamıyorum/u);
    expect((await ask(shop, PROBES['warranty-en'])).answer).toMatch(/can't verify warranty/u);
  });

  it('refuses out-of-scope requests and answers answerable ones', async () => {
    const shop = assistant();
    expect((await ask(shop, PROBES['invest-en'])).metadata.route).toBe('refusal');
    expect((await ask(shop, PROBES['stoves-tr'])).metadata.route).toBe('product-search');
  });

  it('never repeats a product in one answer', async () => {
    const replies = await runProbes(null);
    for (const reply of replies.values()) expect(new Set(ids(reply)).size).toBe(ids(reply).length);
  });

  it('carries context across turns', async () => {
    const shop = assistant();
    await ask(shop, "Do you have women's jackets in size M?", 's');
    const cheaper = await ask(shop, 'the cheaper one?', 's');
    expect(cheaper.metadata.route).toBe('follow-up-cheapest');
    expect(ids(cheaper)).toEqual(['JKT-003']);

    await ask(shop, 'Mont arıyorum', 't');
    const refined = await ask(shop, 'sadece siyah olanlar', 't');
    expect(refined.products.map((p) => p.attributes.color)).toEqual(['black', 'black', 'black']);
  });
});

describe('defect switchboard', () => {
  it('has an expectation for every defect', () => {
    expect(Object.keys(EXPECTED_CHANGES).toSorted()).toEqual([...DEFECTS].toSorted());
  });

  it.each(DEFECTS)('%s changes exactly the expected probes', async (defect) => {
    const baseline = await runProbes(null);
    const broken = await runProbes(defect);
    const changed = PROBE_NAMES.filter(
      (name) => JSON.stringify(get(broken, name)) !== JSON.stringify(get(baseline, name)),
    );
    expect(changed.toSorted()).toEqual(EXPECTED_CHANGES[defect].toSorted());
  });

  it('fabricated-price changes the shown price, not the evidence', async () => {
    const reply = await ask(assistant('fabricated-price'), PROBES['tents-tr']);
    expect(reply.answer).toContain('Plaj Çadırı: 809,55 TL');
    expect(reply.products[0]?.price.amount).toBe(899.5);
  });

  it('unknown-stock-claim claims stock only where it is unknown', async () => {
    const reply = await ask(assistant('unknown-stock-claim'), PROBES['tents-tr']);
    expect(reply.answer).toContain('Ultra Hafif Çadır 1 Kişilik: 4.250,00 TL (stokta var)');
    expect(reply.products.find((p) => p.id === 'TNT-002')?.stockQuantity).toBeNull();
  });

  it('filter-ignored returns products that violate the filter while claiming the filter', async () => {
    const reply = await ask(assistant('filter-ignored'), PROBES['tents-under-1000-tr']);
    expect(reply.answer).toMatch(/^Kriterlerinize \(1\.000,00 TL altı\) uyan çadır/u);
    expect(reply.products.some((p) => p.price.amount > 1000)).toBe(true);
  });

  it('over-refusal refuses with the canonical refusal', async () => {
    const reply = await ask(assistant('over-refusal'), PROBES['stoves-tr']);
    expect(reply.answer).toBe('Bu konuda yardımcı olamıyorum.');
    expect(reply.products).toEqual([]);
  });

  it('duplicate-products repeats the first product', async () => {
    const reply = await ask(assistant('duplicate-products'), PROBES['tents-tr']);
    expect(ids(reply)).toEqual(['TNT-004', 'TNT-001', 'TNT-002', 'TNT-004']);
  });

  it('absence-substitution presents the substitute as the absent type', async () => {
    const reply = await ask(assistant('absence-substitution'), PROBES['sleeping-pad-tr']);
    expect(reply.answer).toMatch(/^Uyku matı seçeneklerimiz:/u);
    expect(reply.products.every((p) => p.category.endsWith('/sleeping-bag'))).toBe(true);
  });

  it('type-padding fills a short result with other types under the same heading', async () => {
    const reply = await ask(assistant('type-padding'), PROBES['tents-under-1000-tr']);
    expect(reply.answer).toMatch(/^Kriterlerinize \(1\.000,00 TL altı\) uyan çadır/u);
    expect(reply.products).toHaveLength(3);
    expect(reply.products[0]?.category).toBe('outdoor/camping/tent');
    expect(reply.products.slice(1).every((p) => p.category !== 'outdoor/camping/tent')).toBe(true);
    expect(reply.products.every((p) => p.price.amount <= 1000)).toBe(true);
  });

  it('invented-return-policy contradicts the FAQ', async () => {
    const reply = await ask(assistant('invented-return-policy'), PROBES['returns-en']);
    expect(reply.answer).toContain('30 days');
  });
});

describe('response cache', () => {
  it('caches first turns, honours bypass, and keeps session context on a hit', async () => {
    const shop = assistant();
    expect((await shop.reply('a', 'Show me headlamps')).cache).toBe('miss');
    expect((await shop.reply('b', 'Show me headlamps')).cache).toBe('hit');
    expect((await shop.reply('c', 'Show me headlamps', { bypassCache: true })).cache).toBe(
      'bypass',
    );
    const followUp = await shop.reply('b', 'cheapest?');
    expect(followUp.reply.metadata.route).toBe('follow-up-cheapest');
    expect(ids(followUp.reply)).toEqual(['HLP-001']);
  });
});
