import { describe, expect, it } from 'vitest';
import { Assistant, type ChatReply } from './assistant.ts';
import { loadShopData } from './catalog.ts';
import { fold } from './language.ts';
import { ScriptedModel } from './model.ts';
import { correctTypos, oneEdit, VOCABULARY_WORDS } from './typos.ts';

describe('oneEdit', () => {
  it.each([
    ['cadir', 'cdir', 'a letter dropped'],
    ['cadir', 'caadir', 'a letter doubled'],
    ['siyah', 'siyha', 'neighbours swapped'],
    ['mavi', 'mavu', 'a letter replaced'],
  ])('%s → %s: %s', (a, b) => {
    expect(oneEdit(a, b)).toBe(true);
    expect(oneEdit(b, a)).toBe(true);
  });

  it.each([
    ['cadir', 'cadir', 'the same word'],
    ['cadir', 'cdr', 'two letters dropped'],
    ['siyah', 'syiha', 'two swaps'],
    ['mavi', 'miva', 'a swap of letters apart'],
    ['mavi', 'mait', 'two letters replaced'],
    ['mont', 'tnom', 'far apart'],
    ['ab', 'ba', 'a swap is one edit'],
  ])('%s → %s: %s', (a, b, why) => {
    expect(oneEdit(a, b)).toBe(why === 'a swap is one edit');
  });
});

describe('correctTypos (ADR-0045)', () => {
  it.each([
    ['cdir onerir misin?', 'cadir onerir misin?'],
    ['1000 tl atlinda cadir', '1000 tl altinda cadir'],
    ['siyha kadin mont', 'siyah kadin mont'],
    ['uyku mait var mi?', 'uyku mat var mi?'],
    ['back backpack under 1000', 'black backpack under 1000'],
    ['a water bottel', 'a water bottle'],
    ['show me headalmps', 'show me headlamps'],
    ['iaed kosullari', 'iade kosullari'],
    ['women jcakets', 'women jackets'],
    ['kamp ocgai', 'kamp ocagi'],
    ['the ceaper one', 'the cheaper one'],
    ['altina cadir', 'altinda cadir'],
  ])('reads "%s" as "%s"', (typed, read) => {
    expect(correctTypos(typed)).toBe(read);
  });

  it.each([
    // Words it knows, or knows the stem of.
    'cadirlar onerir misin',
    'kamp ocagi',
    'headlamps jackets bottles',
    // Words it doesn't know and that are no typo of one it does.
    'kosullari ucretsiz recommend stock policy',
    // A typo never changes the first letter: "sade" is not "iade".
    'sadece siyah olanlar',
    // One edit from two known words: "mat" and "mavi".
    'uyku mati',
    // A stem of three letters claims nothing: "bot" doesn't make "botlar" a typo.
    'botlar',
    // A stem and a suffix are read as written: "ocag" and "i", not "ocak".
    'kamp ocagi olanlar',
    // Common words are no typos of the vocabulary: "show" isn't "shoe".
    'show me',
    // Only the vocabulary is a reading of a typo: "mehraba" isn't read as "merhaba".
    'mehraba',
    // Words of fewer than four letters stay as they are: "ret" isn't "red".
    'mot mnt ret',
    // The words of its products' names are no typos: "carbon" isn't "cart", "polar" isn't "pole".
    'carbon trekking poles, polar ceket, su gecirmez bot, mountaineering boot',
  ])('leaves "%s" as it is', (text) => {
    expect(correctTypos(text)).toBe(text);
  });

  it('reads typos as the words of its terms and phrases, and nothing else', () => {
    for (const word of ['cadir', 'tulum', 'mat', 'altinda', 'under', 'beden', 'cheaper']) {
      expect(VOCABULARY_WORDS.has(word), word).toBe(true);
    }
    for (const word of ['cdir', 'merhaba', 'show']) {
      expect(VOCABULARY_WORDS.has(word), word).toBe(false);
    }
  });
});

describe('the shop reads past a typo (ADR-0045)', () => {
  const data = loadShopData();
  const shop = () => new Assistant({ data, model: new ScriptedModel(), defect: null });
  const ask = async (message: string): Promise<ChatReply> =>
    (await shop().reply('typos', message, { bypassCache: true })).reply;

  // The acceptance messages as yokla's typos transform sends them.
  it.each([
    ['Çadır önerir misin?', 'Çdır önerir misin?'],
    ['1000 TL altında çadır var mı?', '1000 TL atlında çadır var mı?'],
    ['500 TL altı çadır', '500 TL altı çdır'],
    ['Siyah kadın mont arıyorum', 'Siyha kadın mont arıyorum'],
    ["Do you have women's jackets in size M?", "Do you have women's jcakets in size M?"],
    ['Black backpack under 1000', 'Back backpack under 1000'],
    ['Do you have a water bottle under 300?', 'Do you have a water bottel under 300?'],
    ['Uyku matı var mı?', 'Uyku maıt var mı?'],
    ['Show me headlamps', 'Show me headalmps'],
    ['İade koşulları neler?', 'İaed koşulları neler?'],
    ['Kamp ocağı önerir misin?', 'Kamp ocgaı önerir misin?'],
  ])('answers "%s" mistyped as it answers it written', async (written, typed) => {
    const [a, b] = [await ask(written), await ask(typed)];
    expect(b.metadata).toEqual(a.metadata);
    expect(b.products.map((p) => p.id)).toEqual(a.products.map((p) => p.id));
    expect(b.answer).toBe(a.answer);
    expect(fold(typed)).not.toBe(fold(written));
  });
});
