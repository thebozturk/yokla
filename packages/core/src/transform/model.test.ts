import { describe, expect, it } from 'vitest';
import { checkRewrite, TRANSFORM_MARK, transformPrompt } from './model.ts';

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
      'Transform: paraphrase. Write the same request in other words, in the same language (tr), with the same facts, as another shopper would write it.',
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
      'Transform: code-switch. Write the same message as a bilingual shopper would: in tr, with some words, such as product words, in en.',
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
});
