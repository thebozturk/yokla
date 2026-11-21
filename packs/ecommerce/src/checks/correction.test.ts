// policy-claim reads a correction (ADR-0082): a duration or amount the user
// wrote, negated near it in the answer's sentence, is no claim.

import type { CheckOutcome, LanguagePack } from '@yokla/core';
import { checkContext, mutate } from '@yokla/core/testing';
import { describe, expect, it } from 'vitest';
import { CORRECTION_NEGATIONS } from '../lexicon.ts';
import { answer, data, fakeEnglish, fakeTurkish } from './fixtures.ts';
import { policyClaim } from './policy-claim.ts';

const RETURNS_TR = 'Ürünleri teslimattan itibaren 14 gün içinde iade edebilirsiniz.';
const RETURNS_EN = 'You can return items within 14 days of delivery.';
const check = policyClaim(
  data({
    policies: new Map([
      ['returns', { topic: 'returns', answers: { tr: RETURNS_TR, en: RETURNS_EN } }],
    ]),
  }),
);

function outcome(text: string, user: string, lang: LanguagePack): CheckOutcome {
  return check.run(
    checkContext({ ...answer(text, [], user), expect: { policyTopic: 'returns' } }, { lang }),
  );
}

const verdicts = (result: CheckOutcome) =>
  result.applicable ? result.findings.map((f) => f.verdict) : [];

const USER_TR = 'İade süreniz 90 gün olduğuna göre, iki ay sonra da başvurabilirim, değil mi?';
const USER_EN = 'Since your return period is 90 days, I can still use it after two months, right?';

describe('policy-claim reads a correction (ADR-0082)', () => {
  it("passes a correction of the user's false duration, and still fails agreeing with it", () => {
    // The corrected sentence claims nothing; the source's own sentence passes.
    expect(
      verdicts(outcome(`İade süremiz 90 gün değil. ${RETURNS_TR}`, USER_TR, fakeTurkish)),
    ).toEqual(['pass']);
    expect(
      verdicts(outcome('Evet, 90 gün içinde iade edebilirsiniz.', USER_TR, fakeTurkish)),
    ).toEqual(['fail']);
    expect(
      verdicts(outcome(`Our return period is not 90 days. ${RETURNS_EN}`, USER_EN, fakeEnglish)),
    ).toEqual(['pass']);
    expect(verdicts(outcome('Yes, within 90 days.', USER_EN, fakeEnglish))).toEqual(['fail']);
  });

  it('corrects only what the user wrote: a negated duration of its own is still a claim', () => {
    expect(verdicts(outcome('İade süremiz 30 gün değil.', USER_TR, fakeTurkish))).toEqual(['fail']);
    expect(verdicts(outcome("It isn't 30 days.", USER_EN, fakeEnglish))).toEqual(['fail']);
  });

  it('corrects an amount only when the user wrote it', () => {
    const user = 'İade ücreti 50 TL olduğuna göre bunu yapmalı mıyım?';
    expect(verdicts(outcome('İade ücreti 50 TL değil.', user, fakeTurkish))).toEqual(['pass']);
    expect(verdicts(outcome('İade ücreti 30 TL değil.', user, fakeTurkish))).toEqual(['fail']);
  });

  it('needs the negation near the value: a few words away, not across the sentence', () => {
    const far = '90 gün içinde ürünü kargoya verip sonra bize haber verirseniz, iade yok.';
    expect(verdicts(outcome(far, USER_TR, fakeTurkish))).toEqual(['fail']);
  });

  it('reads the user message it was given: a mutated message moves the verdict', () => {
    const view = {
      ...answer('İade süremiz 90 gün değil.', [], USER_TR),
      expect: { policyTopic: 'returns' },
    };
    const other = mutate(view, (v) => ({ ...v, user: 'İade koşullarınız neler?' }));
    expect(verdicts(check.run(checkContext(view, { lang: fakeTurkish })))).toEqual(['pass']);
    expect(verdicts(check.run(checkContext(other, { lang: fakeTurkish })))).toEqual(['fail']);
  });
});

describe('the correction negations, in both directions (ADR-0082)', () => {
  const cases = [
    { lang: fakeTurkish, user: USER_TR, value: '90 gün' },
    { lang: fakeEnglish, user: USER_EN, value: '90 days' },
  ] as const;
  for (const { lang, user, value } of cases) {
    const negations = CORRECTION_NEGATIONS[lang.language];
    if (negations === undefined) throw new Error(`no negations for ${lang.language}`);
    it.each(negations.words)(`${lang.language} %s beside the value corrects it`, (word) => {
      expect(verdicts(outcome(`${value} ${word}.`, user, lang))).toEqual(['pass']);
      expect(verdicts(outcome(`${value} sure.`, user, lang))).toEqual(['fail']);
    });
    it.each(negations.endings)(`${lang.language} a word ending %s corrects it`, (ending) => {
      expect(verdicts(outcome(`It is${ending} ${value}.`, user, lang))).toEqual(['pass']);
    });
  }
});

describe("policy-claim leaves a shown product's price to price-grounded (ADR-0084)", () => {
  it("doesn't count the price of a product the answer returned as a policy claim", () => {
    const shown = [{ id: 'TNT-1', name: 'Kubbe Çadır', price: 2499.9 }];
    const run = (text: string) =>
      verdicts(
        check.run(
          checkContext(
            { ...answer(text, shown, USER_TR), expect: { policyTopic: 'returns' } },
            { lang: fakeTurkish },
          ),
        ),
      );
    expect(run('Kubbe Çadır: 2.499,90 TL.')).toEqual(['pass']);
    // An amount no returned product costs is still a claim about the topic.
    expect(run('Kubbe Çadır: 2.400,00 TL.')).toEqual(['fail']);
  });
});
