import { describe, expect, it } from 'vitest';
import { checkContext, mutate, stubLanguagePack, turnView } from '../testing.ts';
import {
  answeredWithinDeadline,
  answerText,
  costBudget,
  evidenceCount,
  FAULT_JUDGES,
  gracefulUnderFault,
  routeExpected,
} from './generic.ts';
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

describe('clarifying turns', () => {
  it('evidence-count does not apply when the target asked a clarifying question', () => {
    const view = turnView({
      expect: { evidence: { products: { min: 1 } } },
      response: { evidence: { products: [] } },
      clarifying: true,
    });
    expect(verdicts(evidenceCount.run(checkContext(view)))).toEqual([
      'n/a: the target asked a clarifying question',
    ]);
  });
});

const runGraceful = (faults: TurnView['faults']) =>
  gracefulUnderFault.run(checkContext(turnView({ faults })));

const runDeadline = (latencyMs: number, deadlineMs: unknown) =>
  answeredWithinDeadline.run(
    checkContext(turnView({ expect: { deadlineMs }, response: { latencyMs } })),
  );

describe('graceful-under-fault', () => {
  it('passes an answer under faults, fails no usable answer, and says why', () => {
    expect(runGraceful({ failure: undefined })).toMatchObject({ findings: [{ verdict: 'pass' }] });
    expect(runGraceful({ failure: 'HTTP 500' })).toMatchObject({
      findings: [
        {
          dimension: 'resilience',
          verdict: 'fail',
          message: 'gave no usable answer under the injected faults: HTTP 500',
        },
      ],
    });
  });

  it('does not apply to a turn without faults', () => {
    expect(runGraceful(undefined)).toEqual({
      applicable: false,
      reason: 'the turn injects no faults',
    });
  });
});

describe('answered-within-deadline', () => {
  it('passes an answer within the deadline, the deadline itself included, and fails a later one', () => {
    expect(runDeadline(4999, 5000)).toMatchObject({
      findings: [{ verdict: 'pass', dimension: 'deadline' }],
    });
    expect(runDeadline(5000, 5000)).toMatchObject({ findings: [{ verdict: 'pass' }] });
    expect(runDeadline(5001, 5000)).toMatchObject({
      findings: [{ verdict: 'fail', message: 'answered in 5001 ms, deadline 5000 ms' }],
    });
  });

  it('does not apply without a valid deadline', () => {
    expect(runDeadline(10, undefined)).toMatchObject({ applicable: false });
    expect(runDeadline(10, 0)).toMatchObject({ applicable: false });
  });

  it('is one of the fault judges, with graceful-under-fault', () => {
    expect([...FAULT_JUDGES].toSorted()).toEqual([
      'answered-within-deadline',
      'graceful-under-fault',
    ]);
  });
});

const runBudget = (budget: unknown, proxy: TurnView['proxy']) =>
  costBudget.run(checkContext(turnView({ expect: { budget }, proxy })));

describe('cost-budget', () => {
  it('judges the cost and the number of model calls against the budget, boundaries included', () => {
    expect(
      runBudget({ costUsd: 0.002, modelCalls: 2 }, { calls: 2, costUsd: 0.002 }),
    ).toMatchObject({
      findings: [
        { dimension: 'cost', verdict: 'pass', message: '2 model calls, budget 2' },
        { dimension: 'cost', verdict: 'pass', message: 'cost 0.002 USD, budget 0.002 USD' },
      ],
    });
    expect(verdicts(runBudget({ costUsd: 0.002 }, { calls: 1, costUsd: 0.0021 }))).toEqual([
      'fail',
    ]);
    expect(verdicts(runBudget({ modelCalls: 1 }, { calls: 2, costUsd: null }))).toEqual(['fail']);
  });

  it('reports cost as unmeasured without proxy data or with a call that has no cost', () => {
    expect(runBudget({ costUsd: 1 }, undefined)).toEqual({
      applicable: true,
      findings: [],
      unmeasured: [{ dimension: 'cost', reason: 'no model proxy data for this turn' }],
    });
    expect(runBudget({ costUsd: 1, modelCalls: 5 }, { calls: 2, costUsd: null })).toMatchObject({
      findings: [{ verdict: 'pass', message: '2 model calls, budget 5' }],
      unmeasured: [{ dimension: 'cost', reason: 'a model call of the turn has no cost' }],
    });
  });

  it('does not apply without a budget, and refuses an empty one', () => {
    expect(runBudget(undefined, { calls: 1, costUsd: 0 })).toMatchObject({ applicable: false });
    expect(runBudget({}, { calls: 1, costUsd: 0 })).toMatchObject({ applicable: false });
  });
});
