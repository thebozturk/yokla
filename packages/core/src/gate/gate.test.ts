import { describe, expect, it } from 'vitest';
import { YoklaConfig, type GateConfig } from '../schema/config.ts';
import { Results, RESULTS_SCHEMA_ID } from '../schema/results.ts';
import { evaluateGate } from './gate.ts';

type CaseResult = Results['cases'][number];

function kase(id: string, status: CaseResult['status'], suite: CaseResult['suite'] = 'factual') {
  return {
    id,
    suite,
    language: 'tr',
    status,
    unstable: false,
    dimensions: [],
    samples: [],
  } satisfies CaseResult;
}

function run(cases: CaseResult[], change: Partial<Results['run']> = {}): Results {
  const statuses: Partial<Record<CaseResult['status'], number>> = {};
  for (const c of cases) statuses[c.status] = (statuses[c.status] ?? 0) + 1;
  return Results.parse({
    schema: RESULTS_SCHEMA_ID,
    yokla: { version: '0.0.0-test' },
    run: {
      id: 'r',
      startedAt: '2026-11-10T12:00:00.000Z',
      finishedAt: '2026-11-10T12:00:01.000Z',
      durationMs: 1000,
      profile: { target: 't', sha256: 'a'.repeat(64) },
      environment: { node: 'v24.0.0', platform: 'darwin', arch: 'arm64' },
      correlation: 'none',
      partial: false,
      ...change,
    },
    cases,
    checks: [],
    summary: { cases: cases.length, statuses },
  });
}

const gate = (results: Results, config?: GateConfig, baseline?: Results) =>
  evaluateGate(results, config, baseline);

describe('evaluateGate thresholds', () => {
  it('passes a run where every case passes or is a known gap', () => {
    expect(gate(run([kase('a', 'pass'), kase('b', 'known-gap')]))).toEqual({
      verdict: 'pass',
      breaches: [],
      problems: [],
      notices: [],
    });
  });

  it('allows no failing case by default, and up to maxFailures', () => {
    const results = run([kase('a', 'fail'), kase('b', 'fail'), kase('c', 'pass')]);
    expect(gate(results)).toMatchObject({
      verdict: 'broken',
      breaches: [
        {
          rule: 'failures',
          suite: 'factual',
          cases: ['a', 'b'],
          message: 'factual: 2 failing cases, 0 allowed: a, b',
        },
      ],
    });
    expect(gate(results, { maxFailures: 1 }).verdict).toBe('broken');
    expect(gate(results, { maxFailures: 2 }).verdict).toBe('pass');
  });

  it('never lets unmeasured pass unless the suite allows it', () => {
    const results = run([kase('a', 'unmeasured')]);
    expect(gate(results).breaches).toEqual([
      {
        rule: 'unmeasured',
        suite: 'factual',
        cases: ['a'],
        message: 'factual: 1 unmeasured case; unmeasured never counts as a pass: a',
      },
    ]);
    expect(gate(results, { allowUnmeasured: true }).verdict).toBe('pass');
  });

  it('applies thresholds per suite, falling back to the gate-wide ones', () => {
    const results = run([
      kase('f1', 'fail', 'factual'),
      kase('q1', 'fail', 'quality'),
      kase('q2', 'unmeasured', 'quality'),
    ]);
    const config: GateConfig = {
      maxFailures: 1,
      suites: { quality: { maxFailures: 0, allowUnmeasured: true } },
    };
    expect(gate(results, config).breaches.map((b) => b.message)).toEqual([
      'quality: 1 failing case, 0 allowed: q1',
    ]);
  });

  it("can't judge a run with an error or a missing fixture, or a partial run", () => {
    const outcome = gate(
      run([kase('a', 'error'), kase('b', 'fixture-missing'), kase('c', 'fail')], { partial: true }),
    );
    expect(outcome.verdict).toBe('unjudgeable');
    expect(outcome.problems).toEqual([
      'the run is partial: it stopped before every case ran',
      '1 error case: a',
      '1 fixture-missing case: b',
    ]);
    expect(outcome.breaches).toHaveLength(1);
    expect(gate(run([kase('a', 'error')])).verdict).toBe('unjudgeable');
    expect(gate(run([kase('a', 'pass')], { partial: true })).verdict).toBe('unjudgeable');
  });

  it('asks to remove the marker of a closed gap, without breaking the gate', () => {
    expect(gate(run([kase('a', 'gap-closed')]))).toMatchObject({
      verdict: 'pass',
      notices: ['a passes now; remove its known-gap marker and update the baseline'],
    });
  });
});

describe('evaluateGate with a baseline', () => {
  const baseline = run([
    kase('kept', 'pass'),
    kase('broke', 'pass'),
    kase('vacuous', 'pass'),
    kase('hidden', 'pass'),
    kase('closed', 'pass'),
    kase('was-failing', 'fail'),
    kase('dropped', 'pass'),
  ]);

  it('breaks on every case that passed in the baseline and no longer passes', () => {
    const current = run([
      kase('kept', 'pass'),
      kase('broke', 'fail'),
      kase('vacuous', 'unmeasured'),
      kase('hidden', 'known-gap'),
      kase('closed', 'gap-closed'),
      kase('was-failing', 'fail'),
    ]);
    const outcome = gate(current, { maxFailures: 10, allowUnmeasured: true }, baseline);
    expect(outcome.verdict).toBe('broken');
    expect(outcome.breaches).toEqual([
      {
        rule: 'regression',
        suite: 'factual',
        cases: ['broke'],
        message: 'broke passed in the baseline and is now fail',
      },
      {
        rule: 'regression',
        suite: 'factual',
        cases: ['vacuous'],
        message: 'vacuous passed in the baseline and is now unmeasured',
      },
      {
        rule: 'regression',
        suite: 'factual',
        cases: ['hidden'],
        message: 'hidden passed in the baseline and is now known-gap',
      },
    ]);
    expect(outcome.notices).toContain('dropped passed in the baseline but is not in this run');
  });

  it('passes when the baseline passes still pass, and notes another profile', () => {
    const current = run([kase('kept', 'pass')], {
      profile: { target: 't', sha256: 'b'.repeat(64) },
    });
    expect(gate(current, {}, run([kase('kept', 'pass')]))).toEqual({
      verdict: 'pass',
      breaches: [],
      problems: [],
      notices: ['the baseline was made with another profile'],
    });
  });
});

describe('YoklaConfig', () => {
  it('defaults the gate and rejects unknown keys and suites', () => {
    expect(YoklaConfig.parse({ version: 1 })).toEqual({ version: 1, gate: {} });
    expect(YoklaConfig.safeParse({ version: 1, gate: { maxFailure: 1 } }).success).toBe(false);
    expect(
      YoklaConfig.safeParse({ version: 1, gate: { suites: { smoke: { maxFailures: 1 } } } })
        .success,
    ).toBe(false);
    expect(YoklaConfig.safeParse({ version: 1, gate: { maxFailures: -1 } }).success).toBe(false);
    expect(YoklaConfig.safeParse({ version: 2 }).success).toBe(false);
  });
});
