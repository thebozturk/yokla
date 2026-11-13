import { describe, expect, it } from 'vitest';
import { checkContext, mutate, proxyCalls, stubLanguagePack, turnView } from '../testing.ts';
import {
  answeredWithinDeadline,
  answerText,
  costBudget,
  evidenceCount,
  UNANSWERED_JUDGES,
  gracefulUnderFault,
  routeExpected,
  statusAllowed,
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

  it('checks that the answer is not empty: a letter or a digit, in any script', () => {
    const run = (text: string) =>
      verdicts(answerText.run(checkContext(answerTurn(text, { notEmpty: true }))));
    expect(run('Merhaba!')).toEqual(['pass']);
    expect(run('42')).toEqual(['pass']);
    expect(run('Ω')).toEqual(['pass']);
    expect(run('')).toEqual(['fail']);
    expect(run('  ...!? \n')).toEqual(['fail']);
    expect(
      verdicts(answerText.run(checkContext(answerTurn('', { notEmpty: true, contains: ['x'] })))),
    ).toEqual(['fail', 'fail']);
  });

  it('catches an answer emptied', () => {
    const base = answerTurn('Size nasıl yardımcı olabilirim?', { notEmpty: true });
    const emptied = mutate(base, (view) => ({
      ...view,
      response: { ...view.response, text: ' ' },
    }));
    expect(verdicts(answerText.run(checkContext(base)))).toEqual(['pass']);
    expect(verdicts(answerText.run(checkContext(emptied)))).toEqual(['fail']);
  });
});

const statusTurn = (status: number, allowStatus: unknown): TurnView =>
  turnView({ expect: { allowStatus }, response: { status } });

const runStatus = (status: number, allowStatus: unknown) =>
  statusAllowed.run(checkContext(statusTurn(status, allowStatus)));

describe('status-allowed', () => {
  it('passes a 2xx and a listed status, and fails any other', () => {
    expect(verdicts(runStatus(200, [400]))).toEqual(['pass']);
    expect(verdicts(runStatus(204, [400]))).toEqual(['pass']);
    expect(verdicts(runStatus(400, [400, 413]))).toEqual(['pass']);
    expect(verdicts(runStatus(413, [400, 413]))).toEqual(['pass']);
    expect(verdicts(runStatus(500, [400, 413]))).toEqual(['fail']);
    expect(verdicts(runStatus(422, [400]))).toEqual(['fail']);
    expect(runStatus(500, [400])).toMatchObject({
      findings: [
        {
          dimension: 'robustness',
          message: 'answered with 500, which is neither 2xx nor one of 400',
          evidence: { status: 500, allowed: [400] },
        },
      ],
    });
  });

  it('does not apply when the turn allows no other status, or a 2xx', () => {
    expect(runStatus(500, undefined)).toMatchObject({ applicable: false });
    expect(runStatus(500, [200])).toMatchObject({ applicable: false });
    expect(runStatus(500, [])).toMatchObject({ applicable: false });
  });

  it('catches a status changed to one the turn does not allow', () => {
    const base = statusTurn(400, [400]);
    const crashed = mutate(base, (view) => ({
      ...view,
      response: { ...view.response, status: 500 },
    }));
    expect(verdicts(statusAllowed.run(checkContext(base)))).toEqual(['pass']);
    expect(verdicts(statusAllowed.run(checkContext(crashed)))).toEqual(['fail']);
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

  it('is one of the judges of an unanswered turn, with graceful-under-fault and status-allowed', () => {
    expect([...UNANSWERED_JUDGES].toSorted()).toEqual([
      'answered-within-deadline',
      'graceful-under-fault',
      'status-allowed',
    ]);
  });
});

const runBudget = (budget: unknown, proxy: TurnView['proxy']) =>
  costBudget.run(checkContext(turnView({ expect: { budget }, proxy })));

describe('cost-budget', () => {
  it('judges the cost and the number of model calls against the budget, boundaries included', () => {
    expect(
      runBudget({ costUsd: 0.002, modelCalls: 2 }, { calls: proxyCalls(2), costUsd: 0.002 }),
    ).toMatchObject({
      findings: [
        { dimension: 'cost', verdict: 'pass', message: '2 model calls, budget 2' },
        { dimension: 'cost', verdict: 'pass', message: 'cost 0.002 USD, budget 0.002 USD' },
      ],
    });
    expect(
      verdicts(runBudget({ costUsd: 0.002 }, { calls: proxyCalls(1), costUsd: 0.0021 })),
    ).toEqual(['fail']);
    expect(verdicts(runBudget({ modelCalls: 1 }, { calls: proxyCalls(2), costUsd: null }))).toEqual(
      ['fail'],
    );
  });

  it('reports cost as unmeasured without proxy data or with a call that has no cost', () => {
    expect(runBudget({ costUsd: 1 }, undefined)).toEqual({
      applicable: true,
      findings: [],
      unmeasured: [{ dimension: 'cost', reason: 'no model proxy data for this turn' }],
    });
    expect(
      runBudget({ costUsd: 1, modelCalls: 5 }, { calls: proxyCalls(2), costUsd: null }),
    ).toMatchObject({
      findings: [{ verdict: 'pass', message: '2 model calls, budget 5' }],
      unmeasured: [{ dimension: 'cost', reason: 'a model call of the turn has no cost' }],
    });
  });

  it('does not apply without a budget, and refuses an empty one', () => {
    expect(runBudget(undefined, { calls: proxyCalls(1), costUsd: 0 })).toMatchObject({
      applicable: false,
    });
    expect(runBudget({}, { calls: proxyCalls(1), costUsd: 0 })).toMatchObject({
      applicable: false,
    });
    expect(runBudget({ inputTokens: 10 }, { calls: proxyCalls(1), costUsd: 0 })).toEqual({
      applicable: false,
      reason: 'the budget sets no cost and no call count',
    });
  });
});
