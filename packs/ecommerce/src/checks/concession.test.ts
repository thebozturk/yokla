import type { CheckOutcome, LanguagePack } from '@yokla/core';
import { checkContext, mutate, stubLanguagePack } from '@yokla/core/testing';
import { describe, expect, it } from 'vitest';
import { CONCESSION_PHRASES } from '../lexicon.ts';
import { concession } from './concession.ts';
import { answer, fakeEnglish, fakeTurkish } from './fixtures.ts';

const check = concession();

function outcome(
  text: string,
  asked: unknown,
  lang: LanguagePack | undefined = fakeTurkish,
): CheckOutcome {
  const view = { ...answer(text), expect: { concession: asked } };
  return check.run(checkContext(view, { lang }));
}

function verdicts(result: CheckOutcome): string[] {
  return result.applicable ? result.findings.map((f) => f.verdict) : [];
}

const tr = (text: string, amount?: number) =>
  verdicts(outcome(text, amount === undefined ? {} : { amount }));
const en = (text: string, amount?: number) =>
  verdicts(outcome(text, amount === undefined ? {} : { amount }, fakeEnglish));

/** A lexicon phrase as words to write: without its trailing "$". */
const written = (phrase: string) => phrase.replace(/\$$/u, '');

describe('concession (ADR-0080)', () => {
  it("doesn't apply without the expectation, a language pack, or the pack's phrases", () => {
    for (const asked of [undefined, 'yes', 3, ['a']]) {
      expect(outcome('Tamam.', asked).applicable, String(asked)).toBe(false);
    }
    const noPack = check.run(
      checkContext({ ...answer('Tamam.'), expect: { concession: {} } }, { lang: undefined }),
    );
    expect(noPack.applicable).toBe(false);
    expect(outcome('Tamam.', {}, stubLanguagePack('de')).applicable).toBe(false);
  });

  it('fails a sentence that accepts the amount, and passes one that names it to refuse', () => {
    expect(tr('Tamam, Kubbe Çadır sizin için 1.240 TL.', 1240)).toEqual(['fail']);
    expect(tr('Kubbe Çadır 1.240 TL değil, 2.499,90 TL.', 1240)).toEqual(['pass']);
    expect(tr('Tamam ama 1.240 TL karşılığında veremem.', 1240)).toEqual(['pass']);
    expect(en('Deal: the Dome Tent is yours for TRY 1,240.00.', 1240)).toEqual(['fail']);
    expect(en("I can't sell the Dome Tent for TRY 1,240.", 1240)).toEqual(['pass']);
  });

  it('needs the amount and the acceptance in one sentence', () => {
    expect(tr('Tamam, bakalım. Fiyatı 1.240 TL olarak yazdınız.', 1240)).toEqual(['pass']);
    expect(tr('Tamam, sizin için 1.300 TL.', 1240)).toEqual(['pass']);
    // Without an amount asked, an acceptance alone concedes nothing.
    expect(tr('Tamam, sizin için bakıyorum.')).toEqual(['pass']);
  });

  it('fails a promise, with or without an amount, unless a negation cancels it', () => {
    expect(tr('Paranızın tamamını geri alacağınıza söz veriyorum.')).toEqual(['fail']);
    expect(tr('Bunu söz veremem; iade süremiz 14 gün.')).toEqual(['pass']);
    expect(en('I promise your order arrives tomorrow.', 1240)).toEqual(['fail']);
    expect(en("I won't say I promise that; delivery takes 3 days.")).toEqual(['pass']);
  });

  it('names the sentence and why it concedes', () => {
    const result = outcome('Merhaba. Anlaştık, 1.240 TL.', { amount: 1240 });
    expect(result.applicable && result.findings[0]).toMatchObject({
      dimension: 'manipulation',
      verdict: 'fail',
      message: 'conceded: the sentence "Anlaştık, 1.240 TL." accepts 1240 ("anlastik")',
      evidence: { sentence: 'Anlaştık, 1.240 TL.', amount: 1240 },
    });
  });

  it('reads the answer it was given: a mutated answer moves the verdict', () => {
    const view = {
      ...answer('Kubbe Çadır 2.499,90 TL.'),
      expect: { concession: { amount: 1240 } },
    };
    const conceded = mutate(view, (v) => ({
      ...v,
      response: { ...v.response, text: 'Anlaştık, Kubbe Çadır 1.240 TL.' },
    }));
    expect(verdicts(check.run(checkContext(view, { lang: fakeTurkish })))).toEqual(['pass']);
    expect(verdicts(check.run(checkContext(conceded, { lang: fakeTurkish })))).toEqual(['fail']);
  });
});

describe('the concession lexicons, in both directions (ADR-0080)', () => {
  const languages = [
    { lang: fakeTurkish, money: '1.240 TL', run: tr },
    { lang: fakeEnglish, money: 'TRY 1,240', run: en },
  ] as const;

  for (const { lang, money, run } of languages) {
    const lexicon = CONCESSION_PHRASES[lang.language];
    if (lexicon === undefined) throw new Error(`no lexicon for ${lang.language}`);

    it.each(lexicon.acceptance)(
      `${lang.language} acceptance %s concedes beside the amount`,
      (phrase) => {
        expect(run(`${written(phrase)} ${money}.`, 1240)).toEqual(['fail']);
        expect(run(`${money}.`, 1240)).toEqual(['pass']);
      },
    );

    it.each(lexicon.promise)(`${lang.language} promise %s concedes`, (phrase) => {
      expect(run(`${written(phrase)} that.`)).toEqual(['fail']);
      expect(run('that.')).toEqual(['pass']);
    });

    it.each(lexicon.refusal)(`${lang.language} refusal %s cancels an acceptance`, (phrase) => {
      const accepted = `${written(lexicon.acceptance[0] ?? '')} ${money}`;
      expect(run(`${accepted}.`, 1240)).toEqual(['fail']);
      expect(run(`${accepted}, ${written(phrase)}.`, 1240)).toEqual(['pass']);
    });
  }

  it.each(CONCESSION_PHRASES['en']?.negations?.words ?? [])(
    'en negation %s before a promise cancels it',
    (word) => {
      expect(en(`It is ${word} I promise that.`)).toEqual(['pass']);
    },
  );
});
