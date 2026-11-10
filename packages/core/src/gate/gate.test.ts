import { describe, expect, it } from 'vitest';
import { YoklaConfig, type GateConfig } from '../schema/config.ts';
import { Results, RESULTS_SCHEMA_ID } from '../schema/results.ts';
import { baselineOf } from '../baseline/baseline.ts';
import { evaluateGate, percentile } from './gate.ts';

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
  evaluateGate(results, config, baseline === undefined ? undefined : baselineOf(baseline));

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
        cases: ['hidden'],
        message: 'hidden passed in the baseline and is now known-gap',
      },
      {
        rule: 'regression',
        suite: 'factual',
        cases: ['vacuous'],
        message: 'vacuous passed in the baseline and is now unmeasured',
      },
    ]);
    expect(outcome.notices).toContain('dropped passed in the baseline but is not in this run');
  });

  it('compares a case only while its definition holds', () => {
    const defined = (id: string, status: CaseResult['status'], char: string) => ({
      ...kase(id, status),
      definitionSha256: char.repeat(64),
    });
    const before = run([
      defined('stricter', 'pass', '1'),
      defined('same', 'pass', '2'),
      kase('undefined-before', 'pass'),
    ]);
    const now = run([
      defined('stricter', 'fail', '9'),
      defined('same', 'fail', '2'),
      defined('undefined-before', 'fail', '3'),
    ]);
    const outcome = gate(now, { maxFailures: 10 }, before);
    expect(outcome.breaches.map((b) => b.message)).toEqual([
      'same passed in the baseline and is now fail',
      'undefined-before passed in the baseline and is now fail',
    ]);
    expect(outcome.notices).toEqual([
      "stricter changed since the baseline, so it isn't compared with it",
    ]);
    expect(gate(now, {}, before).breaches.map((b) => b.rule)).toEqual([
      'failures',
      'regression',
      'regression',
    ]);
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
    expect(YoklaConfig.parse({ version: 1 })).toEqual({ version: 1, gate: {}, prices: {} });
    expect(YoklaConfig.safeParse({ version: 1, gate: { maxFailure: 1 } }).success).toBe(false);
    expect(
      YoklaConfig.safeParse({ version: 1, gate: { suites: { smoke: { maxFailures: 1 } } } })
        .success,
    ).toBe(false);
    expect(YoklaConfig.safeParse({ version: 1, gate: { maxFailures: -1 } }).success).toBe(false);
    expect(YoklaConfig.safeParse({ version: 2 }).success).toBe(false);
  });
});

/** A case whose turns took these latencies and cost these amounts (null: no cost; undefined: no proxy). */
function timed(
  id: string,
  suite: CaseResult['suite'],
  turns: { latencyMs: number; costUsd?: number | null }[],
  samples = 1,
): CaseResult {
  return {
    ...kase(id, 'pass', suite),
    samples: Array.from({ length: samples }, (_v, index) => ({
      index,
      cache: 'cold' as const,
      turns: turns.map((turn) => ({
        user: 'u',
        checks: [],
        response: { status: 200, latencyMs: turn.latencyMs, evidence: {} },
        ...(turn.costUsd === undefined
          ? {}
          : { proxy: { correlation: 'serial' as const, calls: [], costUsd: turn.costUsd } }),
      })),
    })),
  };
}

describe('percentile', () => {
  it('takes the nearest rank, without interpolating', () => {
    const values = Array.from({ length: 20 }, (_v, i) => i + 1);
    expect([percentile(values, 0.5), percentile(values, 0.95), percentile(values, 1)]).toEqual([
      10, 19, 20,
    ]);
    // 0.95 × 12 = 11.4: the nearest rank rounds up, to the 12th value.
    expect(
      percentile(
        Array.from({ length: 12 }, (_v, i) => i + 1),
        0.95,
      ),
    ).toBe(12);
    expect(percentile([5], 0.95)).toBe(5);
    expect(percentile([], 0.5)).toBeNaN();
  });
});

describe('evaluateGate latency and cost thresholds (ADR-0014)', () => {
  const fast = Array.from({ length: 20 }, (_v, i) => ({ latencyMs: (i + 1) * 100 }));

  it('judges the p50 and p95 of every answered turn of the suite, every sample pooled', () => {
    const results = run([
      timed('a', 'perf', fast.slice(0, 10)),
      timed('b', 'perf', fast.slice(10)),
      timed('q', 'quality', [{ latencyMs: 99_999 }]),
    ]);
    expect(
      gate(results, { suites: { perf: { latencyP95Ms: 1900, latencyP50Ms: 1000 } } }).verdict,
    ).toBe('pass');
    expect(gate(results, { suites: { perf: { latencyP95Ms: 1899 } } }).breaches).toEqual([
      {
        rule: 'latency',
        suite: 'perf',
        cases: ['a', 'b'],
        message: 'perf: latency p95 1900 ms, 1899 allowed',
      },
    ]);
    expect(gate(results, { suites: { perf: { latencyP50Ms: 999 } } }).breaches[0]?.message).toBe(
      'perf: latency p50 1000 ms, 999 allowed',
    );
    // The samples of one case are pooled too: a slow second sample counts.
    const pooled = run([
      {
        ...kase('a', 'pass', 'perf'),
        samples: [100, 5000].map((latencyMs, index) => ({
          index,
          cache: 'cold' as const,
          turns: [{ user: 'u', checks: [], response: { status: 200, latencyMs, evidence: {} } }],
        })),
      },
    ]);
    expect(gate(pooled, { latencyP50Ms: 100 }).verdict).toBe('pass');
    expect(gate(pooled, { latencyP95Ms: 4999 }).verdict).toBe('broken');
  });

  it('judges the mean cost per answered turn and the total', () => {
    const results = run([
      timed('a', 'perf', [
        { latencyMs: 1, costUsd: 0.001 },
        { latencyMs: 1, costUsd: 0.003 },
      ]),
    ]);
    expect(gate(results, { costPerTurnUsd: 0.002, costUsd: 0.004 }).verdict).toBe('pass');
    expect(
      gate(results, { costPerTurnUsd: 0.0019, costUsd: 0.0039 }).breaches.map((b) => b.message),
    ).toEqual([
      'perf: cost per turn 0.002 USD, 0.0019 allowed',
      'perf: cost 0.004 USD, 0.0039 allowed',
    ]);
  });

  it('breaks on a threshold it cannot measure, unless the suite allows unmeasured', () => {
    const noCost = run([
      timed('a', 'perf', [
        { latencyMs: 1, costUsd: 0.001 },
        { latencyMs: 1, costUsd: null },
        { latencyMs: 1 },
      ]),
    ]);
    expect(gate(noCost, { costUsd: 1 }).breaches).toEqual([
      {
        rule: 'unmeasured',
        suite: 'perf',
        cases: ['a'],
        message: "perf: costUsd is set but can't be measured: 2 answered turns without a cost",
      },
    ]);
    expect(gate(noCost, { costUsd: 1, allowUnmeasured: true }).verdict).toBe('pass');
    const silent = run([
      {
        ...kase('a', 'pass', 'perf'),
        samples: [{ index: 0, cache: 'cold', turns: [{ user: 'u', checks: [] }] }],
      },
    ]);
    expect(
      gate(silent, { latencyP95Ms: 1, costPerTurnUsd: 1 }).breaches.map((b) => b.message),
    ).toEqual([
      "perf: latencyP95Ms is set but can't be measured: no answered turn",
      "perf: costPerTurnUsd is set but can't be measured: no answered turn",
    ]);
  });

  it('lets a suite override the gate-wide thresholds', () => {
    const results = run([
      timed('a', 'perf', [{ latencyMs: 500 }]),
      timed('b', 'quality', [{ latencyMs: 500 }]),
    ]);
    expect(
      gate(results, { latencyP95Ms: 100, suites: { perf: { latencyP95Ms: 1000 } } }).breaches.map(
        (b) => b.suite,
      ),
    ).toEqual(['quality']);
  });
});
