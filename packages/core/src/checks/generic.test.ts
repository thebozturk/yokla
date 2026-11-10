import { describe, expect, it } from 'vitest';
import { checkContext, mutate, stubLanguagePack, turnView } from '../testing.ts';
import { answerText, evidenceCount, routeExpected } from './generic.ts';
import type { CheckOutcome, LanguagePack, TurnView } from './types.ts';

function verdicts(outcome: CheckOutcome): string[] {
  return outcome.applicable ? outcome.findings.map((f) => f.verdict) : [`n/a: ${outcome.reason}`];
}

const turkishLike: LanguagePack = {
  ...stubLanguagePack('tr'),
  fold: (text) =>
    text.toLocaleLowerCase('tr-TR').replaceAll('ı', 'i').normalize('NFD').replaceAll(/\p{M}/gu, ''),
};

const routeTurn = (route: string | undefined, expected: unknown) =>
  turnView({ expect: { route: expected }, response: { route } });

const answerTurn = (text: string, answer: unknown): TurnView =>
  turnView({ expect: { answer }, response: { text } });

const evidenceTurn = (items: { id: string }[], expectation: unknown): TurnView =>
  turnView({
    expect: { evidence: { products: expectation } },
    response: { evidence: { products: items } },
  });

describe('route-expected', () => {
  it('does not apply without an expectation or without a mapped route', () => {
    expect(verdicts(routeExpected.run(checkContext(turnView())))).toEqual([
      'n/a: the turn expects no route',
    ]);
    expect(verdicts(routeExpected.run(checkContext(routeTurn(undefined, 'search'))))[0]).toMatch(
      /no route/u,
    );
  });

  it('passes for an expected route and fails otherwise', () => {
    expect(verdicts(routeExpected.run(checkContext(routeTurn('ai', ['retrieval', 'ai']))))).toEqual(
      ['pass'],
    );
    expect(verdicts(routeExpected.run(checkContext(routeTurn('fallback', 'retrieval'))))).toEqual([
      'fail',
    ]);
  });

  it('catches a changed route', () => {
    const base = routeTurn('retrieval', 'retrieval');
    const mutated = mutate(base, (view) => ({
      ...view,
      response: { ...view.response, route: 'fallback' },
    }));
    expect(verdicts(routeExpected.run(checkContext(mutated)))).toEqual(['fail']);
  });
});

describe('answer-text', () => {
  it('checks phrases that must and must not appear, one finding each', () => {
    const outcome = answerText.run(
      checkContext(
        answerTurn('Bunun yerine şu çadırlar var', {
          contains: ['bunun yerine', 'bulamadım'],
          notContains: ['stokta'],
        }),
      ),
    );
    expect(verdicts(outcome)).toEqual(['pass', 'fail', 'pass']);
  });

  it('folds text and phrases with the language pack', () => {
    const context = checkContext(answerTurn('İADE SÜRESİ 14 GÜN', { contains: ['iade süresi'] }), {
      lang: turkishLike,
    });
    expect(verdicts(answerText.run(context))).toEqual(['pass']);
  });

  it('matches at word starts, so a phrase inside another word does not count', () => {
    const context = checkContext(
      answerTurn('Yoksa başka bir ürün mü?', { notContains: ['yok$'] }),
      {
        lang: turkishLike,
      },
    );
    expect(verdicts(answerText.run(context))).toEqual(['pass']);
  });

  it('does not apply without phrases', () => {
    expect(answerText.run(checkContext(answerTurn('x', {}))).applicable).toBe(false);
  });

  it('catches a forbidden phrase added to the answer', () => {
    const base = answerTurn('Stok durumu doğrulanamadı.', { notContains: ['stokta var'] });
    const mutated = mutate(base, (view) => ({
      ...view,
      response: { ...view.response, text: 'Ürün stokta var.' },
    }));
    expect(verdicts(answerText.run(checkContext(mutated, { lang: turkishLike })))).toEqual([
      'fail',
    ]);
  });
});

describe('evidence-count', () => {
  const products = [{ id: 'P1' }, { id: 'P2' }, { id: 'P3' }];
  it('checks minimum, maximum and included ids', () => {
    expect(
      verdicts(
        evidenceCount.run(
          checkContext(evidenceTurn(products, { min: 1, max: 3, includes: ['P2'] })),
        ),
      ),
    ).toEqual(['pass', 'pass', 'pass']);
    expect(
      verdicts(
        evidenceCount.run(checkContext(evidenceTurn(products, { max: 0, includes: ['P9'] }))),
      ),
    ).toEqual(['fail', 'fail']);
  });

  it('accepts a count exactly at the minimum or the maximum', () => {
    expect(
      verdicts(evidenceCount.run(checkContext(evidenceTurn(products, { min: 3, max: 3 })))),
    ).toEqual(['pass', 'pass']);
    expect(verdicts(evidenceCount.run(checkContext(evidenceTurn(products, { min: 4 }))))).toEqual([
      'fail',
    ]);
    expect(verdicts(evidenceCount.run(checkContext(evidenceTurn(products, { max: 2 }))))).toEqual([
      'fail',
    ]);
  });

  it('does not apply when the profile maps no such collection', () => {
    const view = turnView({
      expect: { evidence: { offers: { min: 1 } } },
      response: { evidence: {} },
    });
    expect(verdicts(evidenceCount.run(checkContext(view)))[0]).toMatch(
      /no evidence collection "offers"/u,
    );
  });

  it('catches an empty result where items are expected', () => {
    const base = evidenceTurn(products, { min: 1 });
    const mutated = mutate(base, (view) => ({
      ...view,
      response: { ...view.response, evidence: { products: [] } },
    }));
    expect(verdicts(evidenceCount.run(checkContext(mutated)))).toEqual(['fail']);
  });
});
