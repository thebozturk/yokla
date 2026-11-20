import { describe, expect, it } from 'vitest';
import { buildSchemas } from '../schema/build.ts';
import { CASE_STATUSES, Results } from '../schema/results.ts';
import { summariseCases, weightedPassRate, wilson } from './aggregate.ts';

type CaseResult = Results['cases'][number];

function kase(
  id: string,
  status: CaseResult['status'],
  change: Partial<CaseResult> = {},
): CaseResult {
  return {
    id,
    suite: 'factual',
    language: 'en',
    status,
    unstable: false,
    dimensions: [],
    samples: [],
    ...change,
  };
}

describe('weightedPassRate (ADR-0076)', () => {
  it('sums the weights of passing cases over those of measured cases', () => {
    const cases = [
      kase('a', 'pass', { weight: 30 }),
      kase('b', 'fail', { weight: 10 }),
      kase('c', 'gap-closed', { weight: 0.5 }),
      kase('d', 'fail'),
    ];
    expect(weightedPassRate(cases)).toEqual({ passed: 30.5, measured: 41.5, rate: 0.7349 });
  });

  it('is the plain rate when every weight is 1', () => {
    const cases = [kase('a', 'pass'), kase('b', 'fail'), kase('c', 'pass'), kase('d', 'fail')];
    const rate = weightedPassRate(cases);
    expect(rate).toEqual({ passed: 2, measured: 4, rate: 0.5 });
    expect(rate?.rate).toBe(summariseCases(cases).passRate?.rate);
  });

  it('leaves unmeasured, error, known-gap and fixture-missing cases out of both sums', () => {
    const measured = [kase('a', 'pass', { weight: 3 }), kase('b', 'fail', { weight: 1 })];
    const left = (['unmeasured', 'error', 'known-gap', 'fixture-missing'] as const).map((status) =>
      kase(status, status, { weight: 1000 }),
    );
    expect(weightedPassRate([...measured, ...left])).toEqual(weightedPassRate(measured));
    expect(weightedPassRate(measured)).toEqual({ passed: 3, measured: 4, rate: 0.75 });
    expect(weightedPassRate(left)).toBeUndefined();
    // Every status is either counted or left out on purpose.
    expect(CASE_STATUSES).toHaveLength(7);
  });
});

describe('summariseCases (ADR-0076, ADR-0077)', () => {
  it('counts statuses and gives the pass rate with its Wilson interval', () => {
    const summary = summariseCases([
      kase('a', 'pass'),
      kase('b', 'pass'),
      kase('c', 'fail'),
      kase('d', 'unmeasured'),
    ]);
    expect(summary).toEqual({
      cases: 4,
      statuses: { pass: 2, fail: 1, unmeasured: 1 },
      passRate: { passed: 2, measured: 3, rate: 0.6667, interval: wilson(2, 3) },
      suites: [
        {
          suite: 'factual',
          cases: 4,
          statuses: { pass: 2, fail: 1, unmeasured: 1 },
          passRate: { passed: 2, measured: 3, rate: 0.6667, interval: wilson(2, 3) },
        },
      ],
    });
    expect(wilson(2, 3)).toEqual({ level: 0.95, lower: 0.2077, upper: 0.9385 });
  });

  it('has no pass rate when no case was measured: unmeasured is never a pass', () => {
    expect(summariseCases([kase('a', 'unmeasured'), kase('b', 'error')])).toEqual({
      cases: 2,
      statuses: { unmeasured: 1, error: 1 },
      suites: [{ suite: 'factual', cases: 2, statuses: { unmeasured: 1, error: 1 } }],
    });
    expect(summariseCases([])).toEqual({ cases: 0, statuses: {} });
  });

  it('groups by suite in the order of the suite list', () => {
    const summary = summariseCases([
      kase('a', 'pass', { suite: 'redteam' }),
      kase('b', 'fail', { suite: 'quality' }),
      kase('c', 'pass', { suite: 'quality' }),
    ]);
    expect(summary.suites?.map((s) => [s.suite, s.cases, s.passRate?.rate])).toEqual([
      ['quality', 2, 0.5],
      ['redteam', 1, 1],
    ]);
  });

  it('counts a case with two tags in each, and a case without tags in none', () => {
    const summary = summariseCases([
      kase('thanks', 'fail', { tags: ['chitchat', 'english'] }),
      kase('tents', 'pass', { tags: ['english', 'search'] }),
      kase('plain', 'fail'),
    ]);
    expect(summary.tags).toEqual([
      {
        tag: 'chitchat',
        cases: 1,
        statuses: { fail: 1 },
        passRate: { passed: 0, measured: 1, rate: 0, interval: wilson(0, 1) },
      },
      {
        tag: 'english',
        cases: 2,
        statuses: { fail: 1, pass: 1 },
        passRate: { passed: 1, measured: 2, rate: 0.5, interval: wilson(1, 2) },
      },
      {
        tag: 'search',
        cases: 1,
        statuses: { pass: 1 },
        passRate: { passed: 1, measured: 1, rate: 1, interval: wilson(1, 1) },
      },
    ]);
    expect(summary.cases).toBe(3);
    expect(summariseCases([kase('a', 'pass')]).tags).toBeUndefined();
  });

  it('adds the weighted rate, over the run, each suite and each tag, once a weight is not 1', () => {
    const summary = summariseCases([
      kase('heavy', 'fail', { weight: 900, tags: ['search'] }),
      kase('light', 'pass', { tags: ['search', 'chitchat'] }),
      kase('mid', 'pass', { weight: 99, suite: 'quality' }),
    ]);
    expect(summary.passRate?.weighted).toEqual({ passed: 100, measured: 1000, rate: 0.1 });
    expect(summary.suites?.map((s) => [s.suite, s.passRate?.weighted?.rate])).toEqual([
      ['quality', 1],
      ['factual', 0.0011],
    ]);
    expect(summary.tags?.map((t) => [t.tag, t.passRate?.weighted?.rate])).toEqual([
      ['chitchat', 1],
      ['search', 0.0011],
    ]);
    const unweighted = summariseCases([kase('a', 'pass'), kase('b', 'fail', { tags: ['x'] })]);
    expect(unweighted.passRate?.weighted).toBeUndefined();
    expect(unweighted.tags?.[0]?.passRate?.weighted).toBeUndefined();
  });

  it('is a summary the results schema accepts', () => {
    const cases = [kase('a', 'pass', { weight: 2, tags: ['x'] }), kase('b', 'fail')];
    expect(Results.shape.summary.safeParse(summariseCases(cases)).success).toBe(true);
  });
});

const weighed = (weight: unknown) => ({
  version: 1,
  cases: [{ id: 'c', suite: 'quality', language: 'en', weight, turns: [{ user: 'hi' }] }],
});

describe('a case weight (ADR-0076)', () => {
  const { caseFile } = buildSchemas({ languages: ['en'], domainPacks: [{ id: 'shop' }] });

  it('is a positive number', () => {
    for (const weight of [1, 0.25, 18_000])
      expect(caseFile.safeParse(weighed(weight)).success).toBe(true);
  });

  it('rejects zero, a negative number and anything else', () => {
    for (const weight of [0, -1, '3', Number.POSITIVE_INFINITY, null])
      expect(caseFile.safeParse(weighed(weight)).success, String(weight)).toBe(false);
  });

  it('is 1 when left out', () => {
    const parsed = caseFile.parse({
      version: 1,
      cases: [{ id: 'c', suite: 'quality', language: 'en', turns: [{ user: 'hi' }] }],
    });
    expect(parsed.cases[0]?.weight).toBeUndefined();
    expect(weightedPassRate([kase('c', 'pass')])).toEqual({ passed: 1, measured: 1, rate: 1 });
  });
});
