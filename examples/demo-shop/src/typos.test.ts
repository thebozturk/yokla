import { describe, expect, it } from 'vitest';
import { Assistant, type ChatReply } from './assistant.ts';
import { loadShopData } from './catalog.ts';
import { detectLanguage, fold } from './language.ts';
import { ScriptedModel } from './model.ts';
import { correctTypos, NOT_TYPOS, oneEdit, readings, VOCABULARY_WORDS, WORDS_IN } from './typos.ts';

describe('oneEdit: the typos yokla writes (ADR-0106)', () => {
  it.each([
    ['cdir', 'cadir', 'a letter dropped'],
    ['cadi', 'cadir', 'the last letter dropped'],
    ['caadir', 'cadir', 'a letter doubled'],
    ['cadirr', 'cadir', 'the last letter doubled'],
    ['siyha', 'siyah', 'neighbours swapped'],
    ['ba', 'ab', 'two letters swapped'],
  ])('%s for %s: %s', (written, known) => {
    expect(oneEdit(written, known)).toBe(true);
  });

  it.each([
    ['cadir', 'cadir', 'the same word'],
    ['cdr', 'cadir', 'two letters dropped'],
    ['caaadir', 'cadir', 'two letters added'],
    ['syiha', 'siyah', 'two swaps'],
    ['miva', 'mavi', 'a swap of letters apart'],
    ['mait', 'mavi', 'two letters replaced'],
    ['tnom', 'mont', 'far apart'],
    ['mavu', 'mavi', 'a letter replaced'],
    ['test', 'tent', 'a letter replaced'],
    ['caxdir', 'cadir', 'a letter added that doubles none'],
    ['chart', 'cart', 'a letter added at the start that doubles none'],
    ['carts', 'cart', 'a letter added at the end that doubles none'],
  ])('%s for %s: no edit, %s', (written, known) => {
    expect(oneEdit(written, known)).toBe(false);
  });
});

/** Folded text as the scripted model reads it, in the language it is written in (ADR-0107). */
const read = (text: string): string => correctTypos(text, detectLanguage(text));

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
    // A one-letter suffix swapped with the stem's last letter (ADR-0106).
    ['kamp ocaig', 'kamp ocag'],
  ])('reads "%s" as "%s"', (typed, corrected) => {
    expect(read(typed)).toBe(corrected);
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
    // A stem of three letters and a suffix: "mati" isn't "mat" with a letter added.
    'uyku mati',
    // One edit from two known words: "women" and "woman".
    'womn',
    // Words one replaced letter from the shop's, or one letter added (ADR-0106).
    'test shop store chat that card carry site side shows data',
    'chart kaydina ifadesini',
    // Words of the real runs the reading took for others (ADR-0106).
    'catalog greeting related canary relay shared mean uzere',
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
    expect(read(text)).toBe(text);
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

describe('the words that are no typos (ADR-0106)', () => {
  it.each(NOT_TYPOS)('reads "%s" as written, a word the reading would take for another', (word) => {
    expect(correctTypos(word, 'tr')).toBe(word);
    expect(readings(word, 'tr').length).toBeGreaterThan(0);
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
    ['Kamp ocağı önerir misin?', 'Kamp ocaığ önerir misin?'],
  ])('answers "%s" mistyped as it answers it written', async (written, typed) => {
    const [a, b] = [await ask(written), await ask(typed)];
    expect(b.metadata).toEqual(a.metadata);
    expect(b.products.map((p) => p.id)).toEqual(a.products.map((p) => p.id));
    expect(b.answer).toBe(a.answer);
    expect(fold(typed)).not.toBe(fold(written));
  });
});

describe('the typo reading in a word’s own language (ADR-0107)', () => {
  it('reads a typo in an English message only as an English word', () => {
    expect(correctTypos('the terms', 'en')).toBe('the terms');
    expect(correctTypos('terms', 'tr')).toBe('termos');
    expect(correctTypos('a boat', 'en')).toBe('a boat');
    expect(correctTypos('back backpack', 'en')).toBe('black backpack');
    expect(correctTypos('a water bottel', 'en')).toBe('a water bottle');
  });

  it('reads the suffix swap only as a Turkish word, in a message of either language', () => {
    for (const written of ['tr', 'en'] as const) {
      expect(correctTypos('read main', written), written).toBe('read main');
      expect(correctTypos('uyku mait', written), written).toBe('uyku mat');
    }
    expect(correctTypos('kamp ocaig', 'tr')).toBe('kamp ocag');
  });

  it('knows the words of each language', () => {
    expect([WORDS_IN.tr.has('termos'), WORDS_IN.en.has('termos')]).toEqual([true, false]);
    expect([WORDS_IN.tr.has('under'), WORDS_IN.en.has('under')]).toEqual([false, true]);
    expect([WORDS_IN.tr.has('mat'), WORDS_IN.en.has('mat')]).toEqual([true, true]);
    expect([WORDS_IN.tr.has('altinda'), WORDS_IN.en.has('cheaper')]).toEqual([true, true]);
  });
});
