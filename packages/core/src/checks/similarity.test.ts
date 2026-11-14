import { describe, expect, it } from 'vitest';
import { checkContext, mutate, stubLanguagePack, turnView } from '../testing.ts';
import { textSimilarity } from '../text/similarity.ts';
import { answerSimilarity } from './similarity.ts';
import type { CheckOutcome, LanguagePack, TurnView } from './types.ts';

const turkish: LanguagePack = {
  ...stubLanguagePack('tr'),
  fold: (text) =>
    text.toLocaleLowerCase('tr-TR').replaceAll('ı', 'i').normalize('NFD').replaceAll(/\p{M}/gu, ''),
};

const REFUND = 'İade süresi teslimattan sonra 14 gündür.';
const FALLBACK = 'Şu anda yanıt veremiyorum, lütfen daha sonra tekrar deneyin.';

function answer(text: string, similar: unknown): TurnView {
  return turnView({ expect: { similar }, response: { text } });
}

function run(turn: TurnView): CheckOutcome {
  return answerSimilarity.run(checkContext(turn, { lang: turkish }));
}

function messages(outcome: CheckOutcome): string[] {
  return outcome.applicable
    ? outcome.findings.map((f) => `${f.verdict}: ${f.message}`)
    : [`n/a: ${outcome.reason}`];
}

describe('answer-similarity (ADR-0030)', () => {
  it('does not apply without references', () => {
    expect(messages(run(turnView({ response: { text: REFUND } })))).toEqual([
      'n/a: the turn compares the answer with no reference',
    ]);
  });

  it('passes an answer close enough to one reference, folded by the language pack', () => {
    const outcome = run(
      answer('İADE SÜRESİ, teslimattan sonra 14 gün.', { to: [FALLBACK, REFUND], min: 0.6 }),
    );
    expect(messages(outcome)).toEqual([
      expect.stringMatching(/^pass: similar to reference 2: 0\.\d{1,3} ≥ 0\.6$/u),
    ]);
    const evidence = outcome.applicable ? outcome.findings[0]?.evidence : undefined;
    expect(evidence).toEqual({
      scores: [expect.any(Number) as unknown, expect.any(Number) as unknown],
      best: expect.any(Number) as unknown,
      min: 0.6,
    });
    const scores: unknown = Reflect.get(Object(evidence), 'scores');
    expect(Array.isArray(scores) && scores.every((s) => Math.round(s * 1000) / 1000 === s)).toBe(
      true,
    );
  });

  it('fails an answer that strays from every reference', () => {
    expect(messages(run(answer('Kargo ücretsizdir.', { to: [REFUND], min: 0.6 })))).toEqual([
      expect.stringMatching(/^fail: not similar enough to any reference: best 0(\.\d+)? < 0\.6$/u),
    ]);
  });

  it('keeps an answer away from a text it must not be, with max', () => {
    expect(messages(run(answer(REFUND, { to: [FALLBACK], max: 0.5 })))).toEqual([
      expect.stringMatching(/^pass: not too similar to any reference: best 0(\.\d+)? ≤ 0\.5$/u),
    ]);
    expect(messages(run(answer(FALLBACK, { to: [REFUND, FALLBACK], max: 0.5 })))).toEqual([
      'fail: too similar to reference 2: 1 > 0.5',
    ]);
  });

  it('judges both bounds, one finding each', () => {
    expect(messages(run(answer(REFUND, { to: [REFUND], min: 0.5, max: 0.99 })))).toEqual([
      'pass: similar to reference 1: 1 ≥ 0.5',
      'fail: too similar to reference 1: 1 > 0.99',
    ]);
  });

  it('compares the bound with the score as reported, to three decimals', () => {
    // Pairs whose score rounds up: the reported score meets a bound the raw one misses.
    const pairs: [string, string][] = [
      ['İade süresi 14 gün.', REFUND],
      ['İade 14 gün içinde yapılır.', REFUND],
      ['Teslimattan sonra iade süresi on dört gündür.', REFUND],
    ];
    const roundsUp = pairs.find(([text, reference]) => {
      const raw = textSimilarity(turkish.fold(text), turkish.fold(reference));
      return Math.round(raw * 1000) / 1000 > raw;
    });
    expect(roundsUp).toBeDefined();
    const [text, reference] = roundsUp ?? ['', ''];
    const raw = textSimilarity(turkish.fold(text), turkish.fold(reference));
    const reported = Math.round(raw * 1000) / 1000;
    expect(messages(run(answer(text, { to: [reference], min: reported })))).toEqual([
      `pass: similar to reference 1: ${String(reported)} ≥ ${String(reported)}`,
    ]);
  });

  it('catches an answer replaced by the fallback text', () => {
    const base = answer(REFUND, { to: [REFUND], min: 0.6 });
    const mutated = mutate(base, (view) => ({
      ...view,
      response: { ...view.response, text: FALLBACK },
    }));
    expect(messages(run(base))[0]).toMatch(/^pass/u);
    expect(messages(run(mutated))[0]).toMatch(/^fail/u);
  });
});
