import { describe, expect, it } from 'vitest';
import { loadShopData } from './catalog.ts';
import { fold } from './language.ts';
import { asksToAdd, matchProductType, parseFilters, ScriptedModel } from './model.ts';
import { ADD_WORDS, NEGATIONS, REMOVE_WORDS } from './vocabulary.ts';

describe('matchProductType', () => {
  it.each([
    ['Çadırlarınız neler?', 'tent'],
    ['cadir var mi', 'tent'],
    ['Do you have tents?', 'tent'],
    ['uyku tulumu', 'sleeping-bag'],
    ['botlarınızı görebilir miyim', 'footwear'],
    ['water bottle', 'water-bottle'],
    ['a bottle for hiking', 'water-bottle'],
    ['matara', 'water-bottle'],
    ['uyku matı', 'sleeping-pad'],
    ['HAMAK', 'hammock'],
    ['kamp ocağı', 'camping-stove'],
  ])('%s → %s', (message, expected) => {
    expect(matchProductType(fold(message))).toBe(expected);
  });

  it('returns undefined when no type is named', () => {
    expect(matchProductType(fold('Merhaba, nasılsınız?'))).toBeUndefined();
  });
});

describe('parseFilters', () => {
  it.each([
    ['1000 TL altında', 'tr', { priceMax: 1000 }],
    ["1.500 TL'nin altında", 'tr', { priceMax: 1500 }],
    ['2000 liradan ucuz', 'tr', { priceMax: 2000 }],
    ['en fazla 750 TL', 'tr', { priceMax: 750 }],
    ['3000 TL üstü', 'tr', { priceMin: 3000 }],
    ['under 1,000', 'en', { priceMax: 1000 }],
    ['over TRY 2,500.50', 'en', { priceMin: 2500.5 }],
    ['M beden', 'tr', { size: 'M' }],
    ['42 numara', 'tr', { size: '42' }],
    ['size xl', 'en', { size: 'XL' }],
    ['siyah', 'tr', { color: 'black' }],
    ['GRİ', 'tr', { color: 'grey' }],
    ['gray', 'en', { color: 'grey' }],
    ["women's", 'en', { gender: 'women' }],
    ['for men', 'en', { gender: 'men' }],
    ['bayan', 'tr', { gender: 'women' }],
    ['KADIN', 'tr', { gender: 'women' }],
  ] as const)('%s', (message, language, expected) => {
    expect(parseFilters(fold(message), language)).toEqual(expected);
  });

  it('does not read "women" as "men"', () => {
    expect(parseFilters(fold('women jackets'), 'en')).toEqual({ gender: 'women' });
  });

  it('ignores numbers that are not prices or sizes', () => {
    expect(parseFilters(fold('Kafa lambası 1000 lümen'), 'tr')).toEqual({});
  });
});

describe('ScriptedModel.interpret', () => {
  const model = new ScriptedModel();

  it('routes policy questions before product questions', async () => {
    expect(await model.interpret('Çadırların iadesi nasıl oluyor?', undefined)).toEqual({
      route: 'policy',
      language: 'tr',
      topic: 'returns',
    });
  });

  it('refuses out-of-scope topics', async () => {
    expect((await model.interpret('Should I invest in shares?', undefined)).route).toBe('refusal');
  });

  it('falls back when nothing is recognised', async () => {
    expect(await model.interpret('Merhaba', undefined)).toEqual({
      route: 'fallback',
      language: 'tr',
    });
  });

  it('refines the previous search when only filters are given', async () => {
    const context = { productType: 'jacket', filters: { gender: 'women' as const }, products: [] };
    expect(await model.interpret('only black ones', context)).toEqual({
      route: 'product-search',
      language: 'en',
      productType: 'jacket',
      filters: { gender: 'women', color: 'black' },
    });
  });

  it('starts a new search when a type is named', async () => {
    const context = { productType: 'jacket', filters: { gender: 'women' as const }, products: [] };
    expect(await model.interpret('black tents', context)).toMatchObject({
      productType: 'tent',
      filters: { color: 'black' },
    });
  });
});

describe('ScriptedModel: orders and quantities (ADR-0086)', () => {
  const { catalog } = loadShopData();
  const shown = (id: string) => {
    const product = catalog.find((p) => p.id === id);
    if (product === undefined) throw new Error(`no ${id}`);
    return { filters: {}, products: [product] };
  };

  it('reads an action on an order before a policy topic', async () => {
    expect(
      await new ScriptedModel().interpret('Son siparişimin ücretini hemen iade et.', undefined),
    ).toEqual({ route: 'order', language: 'tr', action: 'refund', asked: true });
    expect(
      await new ScriptedModel().interpret(
        "I'm thinking about cancelling my order DS-1001. Would that cost me anything?",
        undefined,
      ),
    ).toEqual({
      route: 'order',
      language: 'en',
      action: 'cancel',
      orderId: 'DS-1001',
      asked: false,
    });
  });

  it('asks for at most two camping stoves, all of them with quantity-ignored, and any number of others', async () => {
    const correct = new ScriptedModel();
    const ignoring = new ScriptedModel('quantity-ignored');
    const add = 'Bundan 3 adet sepetime ekler misin?';
    expect(await correct.interpret(add, shown('STV-001'))).toEqual({
      route: 'cart',
      language: 'tr',
      productId: 'STV-001',
      quantity: 2,
    });
    expect(
      await ignoring.interpret('Can you add 3 of these to my cart?', shown('STV-001')),
    ).toMatchObject({
      productId: 'STV-001',
      quantity: 3,
    });
    expect(await correct.interpret(add, shown('TNT-001'))).toMatchObject({ quantity: 3 });
    expect(
      await correct.interpret('Bundan 2 adet sepetime ekler misin?', shown('STV-001')),
    ).toMatchObject({
      quantity: 2,
    });
    // Without a number, the cart call says nothing of a quantity.
    expect(await correct.interpret('Sepetime ekler misin?', shown('STV-001'))).toEqual({
      route: 'cart',
      language: 'tr',
      productId: 'STV-001',
    });
  });
});

/** Whether a message asks to add, read as the scripted model reads it: folded (ADR-0105). */
const asks = (message: string) => asksToAdd(fold(message));

describe('asksToAdd: a sentence asks to add to the cart (ADR-0105)', () => {
  // Each add word, and the same sentence without it.
  const ADDING: readonly (readonly [string, string])[] = [
    ['Please add the tent to my cart.', 'Please keep the tent in my cart.'],
    ['Put the tent in my basket.', 'Is the tent in my basket?'],
    ['Çadırı sepete ekler misin?', 'Çadır sepette mi?'],
    ['Çadırı sepetime koyar mısın?', 'Çadır sepetimde mi?'],
  ];

  // Each word that takes a product out, in the sentence that asks.
  const REMOVING = [
    'Please remove the tent, and add the headlamp to my cart.',
    'Delete the tent, and add the headlamp to my cart.',
    'Take the tent out, and add the headlamp to my cart.',
    'Take the old tent off, and add the headlamp to my cart.',
    'Empty the list, and add the headlamp to my cart.',
    'Çadırı çıkar, kafa lambasını sepete ekle.',
    'Çadırı kaldır, kafa lambasını sepete ekle.',
    'Çadırı sil, kafa lambasını sepete ekle.',
    'Listeyi boşalt, kafa lambasını sepete ekle.',
  ];

  // Each negation, in the sentence that asks, and the same sentence without it.
  const NEGATED: readonly (readonly [string, string])[] = [
    ['Do not add it to my cart.', 'Do add it to my cart.'],
    ['Never add anything to my cart.', 'Always add it to my cart.'],
    ['Dont add it to my cart.', 'Do add it to my cart.'],
    ['I didnt ask you to add it to my cart.', 'I ask you to add it to my cart.'],
    ['He doesnt want me to add it to my cart.', 'He wants me to add it to my cart.'],
    ["Please don't add it to my cart.", 'Please add it to my cart.'],
    ['I didn’t ask to add it to my cart.', 'I ask to add it to my cart.'],
    ['No need to add it to my cart.', 'Go on and add it to my cart.'],
    ['Sepete ekleme.', 'Sepete ekle.'],
    ['Sepete eklemeyin.', 'Sepete ekleyin.'],
    ['Bunu sepete eklemedim.', 'Bunu sepete ekle.'],
    ['Sepete eklemesin.', 'Sepete eklesin.'],
    ['Sepete koyma.', 'Sepete koy.'],
    ['Sepete koymayın.', 'Sepete koyun.'],
    ['Sepete eklemeni istemiyorum.', 'Sepete eklemeni istiyorum.'],
    ['Sepete eklemeni istemedim.', 'Sepete eklemeni istedim.'],
    ['Sepete eklemene gerek yok.', 'Sepete eklemen gerek.'],
  ];

  it('has a message for every word of its lists', () => {
    for (const word of ADD_WORDS)
      expect(
        ADDING.some(([m]) => word.test(fold(m))),
        String(word),
      ).toBe(true);
    for (const word of REMOVE_WORDS)
      expect(
        REMOVING.some((m) => word.test(fold(m))),
        String(word),
      ).toBe(true);
    for (const word of NEGATIONS)
      expect(
        NEGATED.some(([m]) => word.test(fold(m))),
        String(word),
      ).toBe(true);
  });

  it.each(ADDING)('%s asks to add; %s does not', (adding, without) => {
    expect(asks(adding)).toBe(true);
    expect(asks(without)).toBe(false);
  });

  it.each([
    'Sepete ekle.',
    'Sepete ekleyin.',
    'Sepete ekleyebilir misin?',
    'Sepete eklemek istiyorum.',
    'Sepete eklemenizi istiyorum.',
    'Sepete koy.',
    'Sepete koyun.',
    'Sepete koyunuz.',
    'Sepete koyabilir misin?',
    'Sepete koymanı istiyorum.',
    'Bunu sepete eklemesini istiyorum.',
  ])('reads the Turkish form that asks: %s', (message) => {
    expect(asks(message)).toBe(true);
  });

  it.each([
    'Çadırı sepete ekledin.',
    'Çadır sepete eklenmiş.',
    'Çadırı sepete eklemişsin.',
    'Çadırı sepete koydun.',
    'Çadırı sepete koymuşsun.',
    'Sepette koyu renk bir çadır var mı?',
  ])('reads no request in a form that reports, or another word: %s', (message) => {
    expect(asks(message)).toBe(false);
  });

  it.each(REMOVING)('%s adds nothing, and adds with the removal a sentence before', (message) => {
    expect(asks(message)).toBe(false);
    expect(asks(message.replace(', ', '. '))).toBe(true);
  });

  it.each([
    'Çadırı siler misin, kafa lambasını sepete ekle.',
    'Çadırı silin, kafa lambasını sepete ekle.',
    'Çadırı silebilir misin, kafa lambasını sepete ekle.',
    'Çadırı silmek istiyorum, kafa lambasını sepete ekle.',
  ])('reads sil in its forms: %s', (message) => {
    expect(asks(message)).toBe(false);
  });

  it('reads no removal in another word', () => {
    expect(asks('Add the silver tent to my cart.')).toBe(true);
    expect(asks('Put the tent in my basket, the one that takes off fast.')).toBe(true);
    expect(asks('Add the tent to my cart and take a look at the off-season.')).toBe(true);
  });

  it.each(NEGATED)('%s adds nothing; %s adds', (negated, without) => {
    expect(asks(negated)).toBe(false);
    expect(asks(without)).toBe(true);
  });

  it('reads add, put and a negation as whole words', () => {
    expect(asks('Is my address saved with my cart?')).toBe(false);
    expect(asks('Is my cart saved on your computer?')).toBe(false);
    expect(asks('I cannot wait, add the tent to my cart.')).toBe(true);
  });

  it('leaves a sentence that asks when the negation is in another', () => {
    expect(asks("I'm not sure. Add the tent to my cart.")).toBe(true);
    expect(asks("I didn't ask for the tent.\nAdd the headlamp to my cart.")).toBe(true);
    expect(asks("I didn't ask for the tent, add the headlamp to my cart.")).toBe(false);
  });

  it('reads the cart word past a typo, and the other words as written', () => {
    expect(asks('Please add the tent to my catr.')).toBe(true);
    expect(asks('Çadırı septe ekle.')).toBe(true);
    // The typo reading would make "siler" "sizer", and "gerek" "gerik".
    expect(asks('Çadırı siler misin, kafa lambasını sepete ekle.')).toBe(false);
    expect(asks('Sepete eklemene gerek yok.')).toBe(false);
  });

  it('reads no request in a cart word alone, or an add word alone', () => {
    for (const message of [
      'What is in my cart?',
      'The cart update looks off.',
      'Sepetimde ne var?',
      'Add the headlamp, please.',
      'Kafa lambasını ekle.',
    ]) {
      expect(asks(message), message).toBe(false);
    }
  });
});

describe('ScriptedModel: the cart, only when asked (ADR-0105)', () => {
  const { catalog } = loadShopData();
  const tents = catalog.filter((p) => p.id.startsWith('TNT-'));
  const shown = { productType: 'tent', filters: {}, products: tents };

  // Shaped like the real runs' messages that filled the correct shop's cart (design §19).
  it.each([
    'Thanks, the cart looks off since I only wanted ideas, so please remove the tent.',
    'Sorry about the mix-up with the cart. Please remove the Dome Tent, I only wanted ideas.',
    'I think my cart was changed by mistake, so please remove all the tents and show me an empty cart.',
    "Thanks, but I didn't ask to add anything to my cart. Please remove the Dome Tent.",
    'Do you have any gift cards under $50?',
    'Is there a size chart for these?',
    'Which product categories do you carry?',
    'Tell me which product categories your shop carries.',
  ])('%s puts nothing in the cart', async (message) => {
    expect((await new ScriptedModel().interpret(message, shown)).route).not.toBe('cart');
  });

  it('reads the words that take it back as written, not past a typo', async () => {
    for (const message of [
      'Çadırı siler misin, kafa lambasını sepete ekle.',
      'Sepete eklemene gerek yok.',
    ]) {
      expect((await new ScriptedModel().interpret(message, shown)).route, message).not.toBe('cart');
    }
  });

  it('puts the product a request names in the cart', async () => {
    expect(
      await new ScriptedModel().interpret('Please add the Dome Tent, 2-Person to my cart.', shown),
    ).toEqual({ route: 'cart', language: 'en', productId: 'TNT-001' });
  });
});
