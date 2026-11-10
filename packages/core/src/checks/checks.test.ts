import { describe, expect, it } from 'vitest';
import type { Results } from '../schema/results.ts';
import { checkContext, mutate, turnView } from '../testing.ts';
import { aggregateCase, summariseChecks, wilson } from './aggregate.ts';
import { runChecks } from './run.ts';
import type { Check } from './types.ts';

type Sample = Results['cases'][number]['samples'][number];
type Turn = Sample['turns'][number];

function turn(checks: Turn['checks'], extra: Partial<Turn> = {}): Turn {
  return { user: 'x', checks, ...extra };
}
const finding = (dimension: string, verdict: 'pass' | 'fail' | 'error') => ({
  dimension,
  verdict,
  severity: 'high' as const,
  message: verdict,
});
const sample = (...turns: Turn[]): Sample => ({ index: 0, cache: 'cold', turns });
const applied = (...findings: ReturnType<typeof finding>[]) => ({
  check: 'c',
  applicable: true,
  findings,
});

describe('wilson', () => {
  it.each([
    [0, 9, 0, 0.2992],
    [9, 9, 0.7008, 1],
    [3, 9, 0.1206, 0.6458],
    [1, 3, 0.0615, 0.7923],
  ])('%d of %d', (failed, n, lower, upper) => {
    expect(wilson(failed, n)).toEqual({ level: 0.95, lower, upper });
  });
});

describe('aggregateCase', () => {
  const fails = sample(turn([applied(finding('fabrication', 'fail'))]));
  const passes = sample(turn([applied(finding('fabrication', 'pass'))]));

  it('fails a worst-of-n dimension when one sample of three fails, and flags it unstable', () => {
    const result = aggregateCase([passes, fails, passes], {}, false);
    expect(result).toEqual({
      status: 'fail',
      unstable: true,
      dimensions: [
        {
          dimension: 'fabrication',
          policy: 'worst-of-n',
          verdict: 'fail',
          samples: 3,
          failed: 1,
          interval: { level: 0.95, lower: 0.0615, upper: 0.7923 },
        },
      ],
    });
  });

  it('uses majority-of-n where the pack says so', () => {
    const policies = { fabrication: 'majority-of-n' } as const;
    expect(aggregateCase([passes, fails, passes], policies, false).status).toBe('pass');
    expect(aggregateCase([fails, fails, passes], policies, false).status).toBe('fail');
  });

  it('counts a dimension only in the samples that measured it', () => {
    const other = sample(turn([applied(finding('tone', 'pass'))]));
    const result = aggregateCase([fails, other], {}, false);
    expect(result.dimensions.map((d) => [d.dimension, d.samples, d.failed])).toEqual([
      ['fabrication', 1, 1],
      ['tone', 1, 0],
    ]);
    expect(result.dimensions.every((d) => d.interval === undefined)).toBe(true);
  });

  it('lets a failing finding win over a passing one in the same sample', () => {
    const mixed = sample(
      turn([applied(finding('fabrication', 'pass'), finding('fabrication', 'fail'))]),
    );
    expect(aggregateCase([mixed], {}, false).status).toBe('fail');
  });

  it('puts errors first: a failed turn or a crashed check makes the case an error', () => {
    const failedTurn = sample(turn([], { error: 'HTTP 500' }));
    const crashed = sample(turn([applied(finding('check-error', 'error'))]));
    expect(aggregateCase([passes, failedTurn], {}, false).status).toBe('error');
    expect(aggregateCase([crashed], {}, false).status).toBe('error');
    expect(aggregateCase([fails, failedTurn], {}, true).status).toBe('error');
  });

  it('is unmeasured when no check applied, never pass', () => {
    const notApplicable = sample(turn([{ check: 'c', applicable: false, findings: [] }]));
    expect(aggregateCase([notApplicable], {}, false)).toEqual({
      status: 'unmeasured',
      unstable: false,
      dimensions: [],
    });
    expect(aggregateCase([sample(turn([]))], {}, true).status).toBe('unmeasured');
  });

  it('reports a known gap as known-gap while it fails and gap-closed once it passes', () => {
    expect(aggregateCase([fails], {}, true).status).toBe('known-gap');
    expect(aggregateCase([passes], {}, true).status).toBe('gap-closed');
  });
});

describe('summariseChecks', () => {
  it('counts applications, non-applications and outcomes per check', () => {
    const caseResult = {
      id: 'a',
      suite: 'factual' as const,
      language: 'tr',
      status: 'fail' as const,
      unstable: false,
      dimensions: [],
      samples: [
        sample(
          turn([
            { check: 'price', applicable: true, findings: [finding('fabrication', 'fail')] },
            { check: 'stock', applicable: false, findings: [] },
          ]),
          turn([
            { check: 'price', applicable: true, findings: [finding('fabrication', 'pass')] },
            { check: 'stock', applicable: true, findings: [finding('check-error', 'error')] },
          ]),
        ),
      ],
    };
    expect(summariseChecks([caseResult])).toEqual([
      { check: 'price', applied: 2, notApplicable: 0, passed: 1, failed: 1, errors: 0 },
      { check: 'stock', applied: 1, notApplicable: 1, passed: 0, failed: 0, errors: 1 },
    ]);
  });
});

describe('runChecks', () => {
  const says: Check = {
    id: 'says-hello',
    description: 'the answer says hello',
    run: (context) =>
      context.turn.response.text === ''
        ? { applicable: false, reason: 'no text' }
        : {
            applicable: true,
            findings: [
              {
                dimension: 'greeting',
                verdict: context.turn.response.text.includes('hello') ? 'pass' : 'fail',
                severity: 'low',
                message: 'checked',
              },
            ],
          },
  };
  const broken: Check = {
    id: 'broken',
    description: 'always throws',
    run: () => {
      throw new Error('bug in check');
    },
  };

  it('runs every check and records applicability', () => {
    const results = runChecks(
      [says],
      checkContext(turnView({ response: { text: 'hello there' } })),
    );
    expect(results).toEqual([
      {
        check: 'says-hello',
        applicable: true,
        findings: [{ dimension: 'greeting', verdict: 'pass', severity: 'low', message: 'checked' }],
      },
    ]);
    expect(runChecks([says], checkContext(turnView()))).toEqual([
      { check: 'says-hello', applicable: false, findings: [] },
    ]);
  });

  it('turns a crashing check into an error finding and keeps going', () => {
    const results = runChecks([broken, says], checkContext(turnView({ response: { text: 'hi' } })));
    expect(results[0]?.findings[0]).toMatchObject({ dimension: 'check-error', verdict: 'error' });
    expect(results[1]?.findings[0]).toMatchObject({ verdict: 'fail' });
  });

  it('runs only the checks a case names', () => {
    const context = checkContext(turnView({ response: { text: 'hello' } }));
    const onlyBroken = { ...context, case: { ...context.case, checks: ['broken'] } };
    expect(runChecks([broken, says], onlyBroken).map((r) => r.check)).toEqual(['broken']);
  });

  it('detects a changed answer through a mutation that really applied', () => {
    const base = turnView({ response: { text: 'hello' } });
    const mutated = mutate(base, (view) => ({
      ...view,
      response: { ...view.response, text: 'goodbye' },
    }));
    expect(runChecks([says], checkContext(mutated))[0]?.findings[0]?.verdict).toBe('fail');
  });
});

describe('mutate', () => {
  it('refuses a mutation that changes nothing', () => {
    expect(() => mutate({ a: 1 }, (value) => ({ ...value }))).toThrow(/did not change anything/u);
  });
});

describe('advisory dimensions', () => {
  const advisoryFail = sample(turn([applied(finding('deflection', 'fail'))]));
  const both = sample(
    turn([applied(finding('fabrication', 'pass'), finding('deflection', 'fail'))]),
  );
  const policies = { deflection: 'advisory' } as const;

  it('are reported but never fail the case', () => {
    const result = aggregateCase([both], policies, false);
    expect(result.status).toBe('pass');
    expect(result.dimensions.find((d) => d.dimension === 'deflection')).toMatchObject({
      policy: 'advisory',
      verdict: 'fail',
    });
  });

  it('do not count as a measurement on their own', () => {
    expect(aggregateCase([advisoryFail], policies, false).status).toBe('unmeasured');
  });

  it('do not make a case unstable', () => {
    const passing = sample(
      turn([applied(finding('fabrication', 'pass'), finding('deflection', 'pass'))]),
    );
    expect(aggregateCase([both, passing], policies, false).unstable).toBe(false);
  });
});

/** A check result that couldn't measure `dimension`. */
const gap = (dimension: string) => ({
  check: 'budget',
  applicable: true,
  findings: [],
  unmeasured: [{ dimension, reason: 'no data' }],
});

describe('unmeasured dimensions (ADR-0014)', () => {
  it('makes a case with an unmeasured deciding dimension unmeasured, never a pass', () => {
    const result = aggregateCase(
      [sample(turn([applied(finding('price', 'pass')), gap('cost')]))],
      {},
      false,
    );
    expect(result.status).toBe('unmeasured');
    expect(result.dimensions).toEqual([
      { dimension: 'cost', policy: 'worst-of-n', verdict: 'unmeasured', samples: 0, failed: 0 },
      { dimension: 'price', policy: 'worst-of-n', verdict: 'pass', samples: 1, failed: 0 },
    ]);
  });

  it('lets a failure win over an unmeasured dimension', () => {
    const result = aggregateCase(
      [sample(turn([applied(finding('price', 'fail')), gap('cost')]))],
      {},
      false,
    );
    expect(result.status).toBe('fail');
    const known = aggregateCase(
      [sample(turn([applied(finding('price', 'fail')), gap('cost')]))],
      {},
      true,
    );
    expect(known.status).toBe('known-gap');
  });

  it('treats a dimension measured on one turn or sample but not another as unmeasured', () => {
    const turns = aggregateCase(
      [sample(turn([applied(finding('cost', 'pass'))]), turn([gap('cost')]))],
      {},
      false,
    );
    expect(turns.dimensions[0]).toMatchObject({
      dimension: 'cost',
      verdict: 'unmeasured',
      samples: 0,
    });
    const samples = aggregateCase(
      [sample(turn([applied(finding('cost', 'pass'))])), sample(turn([gap('cost')]))],
      {},
      false,
    );
    expect(samples.dimensions[0]).toMatchObject({ verdict: 'unmeasured', samples: 1 });
    expect(samples.status).toBe('unmeasured');
    // A failure measured anywhere still fails the dimension.
    const failed = aggregateCase(
      [sample(turn([applied(finding('cost', 'fail'))]), turn([gap('cost')]))],
      {},
      false,
    );
    expect(failed.dimensions[0]).toMatchObject({ verdict: 'fail' });
  });

  it("can't close a known gap it didn't measure", () => {
    expect(aggregateCase([sample(turn([gap('cost')]))], {}, true).status).toBe('unmeasured');
  });

  it('ignores an advisory unmeasured dimension, and counts unmeasured results apart in the summary', () => {
    const advisory = aggregateCase(
      [sample(turn([applied(finding('price', 'pass')), gap('style')]))],
      { style: 'advisory' },
      false,
    );
    expect(advisory.status).toBe('pass');
    const results = aggregateCase([sample(turn([gap('cost')]))], {}, false);
    const summary = summariseChecks([
      {
        id: 'c',
        suite: 'perf',
        language: 'tr',
        status: results.status,
        unstable: false,
        dimensions: results.dimensions,
        samples: [sample(turn([gap('cost')]))],
      },
    ]);
    expect(summary).toEqual([
      {
        check: 'budget',
        applied: 1,
        notApplicable: 0,
        passed: 0,
        failed: 0,
        errors: 0,
        unmeasured: 1,
      },
    ]);
  });

  it('records the unmeasured dimensions a check reports', () => {
    const results = runChecks(
      [
        {
          id: 'budget',
          description: 'x',
          run: () => ({
            applicable: true,
            findings: [],
            unmeasured: [{ dimension: 'cost', reason: 'no data' }],
          }),
        },
        {
          id: 'plain',
          description: 'y',
          run: () => ({ applicable: true, findings: [], unmeasured: [] }),
        },
      ],
      checkContext(turnView()),
    );
    expect(results).toEqual([
      {
        check: 'budget',
        applicable: true,
        findings: [],
        unmeasured: [{ dimension: 'cost', reason: 'no data' }],
      },
      { check: 'plain', applicable: true, findings: [] },
    ]);
  });
});
