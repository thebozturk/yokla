import { describe, expect, it } from 'vitest';
import { stubLanguagePack } from '../testing.ts';
import { checkRewrite, TRANSFORM_MARK, transformPrompt } from './model.ts';

/** Two packs with a few common words each, as language-match counts them. */
const turkish = { ...stubLanguagePack('tr'), commonWords: ['bir', 'var', 'mı', 'misin'] };
const english = { ...stubLanguagePack('en'), commonWords: ['do', 'you', 'have', 'a', 'any'] };

describe('the transform prompt (ADR-0059)', () => {
  it("is yokla's own: marked, with the kind, the language and the text to keep", () => {
    const prompt = transformPrompt({
      kind: 'paraphrase',
      message: '500 TL altı çadır',
      language: 'tr',
      keep: ['500 TL'],
    });
    const lines = prompt.system.split('\n');
    expect(lines[0]).toBe(TRANSFORM_MARK);
    expect(lines).toContain(
      'Transform: paraphrase. Write the same request in other words, in the same language (tr), as another shopper would write it. Keep the same requests and facts: add none and drop none; change only how they are written.',
    );
    expect(lines).toContain('Keep each of these exactly as written: "500 TL".');
    expect(prompt.messages).toEqual([{ role: 'user', content: '500 TL altı çadır' }]);
  });

  it('names the language mixed in for code-switch, and keeps nothing it needn’t', () => {
    const lines = transformPrompt({
      kind: 'code-switch',
      message: 'Çadır önerir misin?',
      language: 'tr',
      other: 'en',
      keep: [],
    }).system.split('\n');
    expect(lines).toContain(
      'Transform: code-switch. Write the same message as a bilingual shopper would: keep tr as its language, replace a few words, such as product words, with their en words, and write nothing else in en. Keep the same requests and facts: add none and drop none; change only how they are written.',
    );
    expect(lines.some((line) => line.startsWith('Keep each'))).toBe(false);
  });
});

describe('checkRewrite (ADR-0059)', () => {
  it('takes a rewrite that keeps every kept text, out of quotes', () => {
    expect(
      checkRewrite('500 TL altı çadır', ' "500 TL altında çadır var mı?" ', ['500 TL']),
    ).toEqual({
      ok: true,
      text: '500 TL altında çadır var mı?',
    });
  });

  it.each([
    ['', 'the reply is empty'],
    ['  ""  ', 'the reply is empty'],
    ['bir\nçadır 500 TL', 'the reply is more than one line'],
    [' 500 TL altı çadır ', 'the reply is the message as written'],
    ['beş yüz TL altı çadır', '"500 TL" was lost'],
  ])('refuses %j: %s', (reply, why) => {
    expect(checkRewrite('500 TL altı çadır', reply, ['500 TL'])).toEqual({ ok: false, why });
  });

  it('refuses a rewrite with a sentence more than the message, never counting a point between digits (ADR-0060)', () => {
    expect(
      checkRewrite('Çadır önerir misin?', 'Çadır önerir misin? 2 kişilik var mı?', []),
    ).toEqual({
      ok: false,
      why: 'the reply adds a sentence',
    });
    expect(checkRewrite('Merhaba', 'Selam. Kulaklık var mı?', [])).toMatchObject({ ok: false });
    expect(
      checkRewrite('1.500 TL altı çadır', 'Bana 1.500 TL altında bir çadır.', ['1.500 TL']),
    ).toEqual({
      ok: true,
      text: 'Bana 1.500 TL altında bir çadır.',
    });
    expect(checkRewrite('Merhaba', 'Selam, iyi günler', [])).toMatchObject({ ok: true });
    // A message without an end mark is one sentence: one with it is not more.
    expect(checkRewrite('Merhaba', 'Selam, iyi günler.', [])).toMatchObject({ ok: true });
  });

  it('refuses a code-switch whose mixed-in common words outnumber its own, and takes a tie (ADR-0060)', () => {
    const switched = { own: english, mixed: turkish };
    expect(checkRewrite('Do you have a tent?', 'Bir çadır var mı you have?', [], switched)).toEqual(
      {
        ok: false,
        why: 'the reply is no longer in en',
      },
    );
    expect(checkRewrite('Do you have a tent?', 'Do you have a çadır?', [], switched)).toMatchObject(
      {
        ok: true,
      },
    );
    // One common word each: a tie keeps the case's language.
    expect(checkRewrite('Any tent?', 'Any çadır var?', [], switched)).toMatchObject({ ok: true });
    // A paraphrase is never judged by language.
    expect(checkRewrite('Do you have a tent?', 'Bir çadır var mı?', [])).toMatchObject({
      ok: true,
    });
  });
});
