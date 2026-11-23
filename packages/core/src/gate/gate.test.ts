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

const proposed = (c: CaseResult): CaseResult => ({ ...c, review: 'proposed' });

describe('evaluateGate and proposed cases (ADR-0004)', () => {
  it('leaves proposed cases out, whatever their status, and names them in a notice', () => {
    const results = run([
      kase('ok', 'pass'),
      proposed(kase('p-fail', 'fail')),
      proposed(kase('p-error', 'error')),
      proposed(kase('p-unmeasured', 'unmeasured')),
    ]);
    expect(gate(results)).toEqual({
      verdict: 'pass',
      breaches: [],
      problems: [],
      notices: [
        '3 proposed cases not gating until a person approves: p-fail, p-error, p-unmeasured',
      ],
    });
    expect(gate(run([proposed(kase('one', 'pass'))])).notices).toEqual([
      '1 proposed case not gating until a person approves: one',
    ]);
    // An approved case still gates beside them.
    expect(gate(run([kase('a', 'fail'), proposed(kase('p', 'pass'))])).verdict).toBe('broken');
  });

  it('leaves proposed cases out of the latency and cost thresholds', () => {
    const results = run([
      timed('fast', 'perf', [{ latencyMs: 100 }]),
      proposed(timed('slow', 'perf', [{ latencyMs: 9000 }])),
    ]);
    expect(gate(results, { suites: { perf: { latencyP95Ms: 200 } } }).verdict).toBe('pass');
  });

  it("doesn't compare a case that passed in the baseline and is proposed now", () => {
    const before = run([kase('a', 'pass')]);
    const now = run([proposed(kase('a', 'fail'))]);
    expect(gate(now, undefined, before)).toMatchObject({
      verdict: 'pass',
      breaches: [],
    });
    expect(gate(now, undefined, before).notices).toContain(
      "a passed in the baseline but is proposed now, so it isn't compared",
    );
  });
});

describe('YoklaConfig', () => {
  it('defaults the gate and rejects unknown keys and suites', () => {
    expect(YoklaConfig.parse({ version: 1 })).toEqual({
      version: 1,
      gate: {},
      judge: {},
      prices: {},
      models: {},
      checks: [],
      plan: { upperBoundFactor: 2 },
    });
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

  it("judges a replayed run's latency as unmeasured, and its cost as recorded (ADR-0040)", () => {
    const replay = { cassetteSha256: 'c'.repeat(64), loose: false, diverged: 0 };
    const replayed = run([timed('a', 'perf', [{ latencyMs: 1, costUsd: 0.001 }])], { replay });
    expect(gate(replayed, { latencyP50Ms: 100, latencyP95Ms: 100 }).breaches).toEqual(
      ['latencyP50Ms', 'latencyP95Ms'].map((name) => ({
        rule: 'unmeasured',
        suite: 'perf',
        cases: ['a'],
        message: `perf: ${name} is set but can't be measured: the run replayed a cassette, so its model answers took no time`,
      })),
    );
    expect(gate(replayed, { latencyP95Ms: 100, allowUnmeasured: true }).verdict).toBe('pass');
    expect(gate(replayed, { costUsd: 0.0009 }).breaches.map((b) => b.message)).toEqual([
      'perf: cost 0.001 USD, 0.0009 allowed',
    ]);
    // A run that recorded a cassette is measured as any other.
    const recorded = run([timed('a', 'perf', [{ latencyMs: 1 }])], { record: { calls: 1 } });
    expect(gate(recorded, { latencyP95Ms: 100 }).verdict).toBe('pass');
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

const tagged = (id: string, status: CaseResult['status'], tags: string[]) => ({
  ...kase(id, status),
  tags,
});

describe('a run limited by tag (ADR-0077)', () => {
  const full = run([
    tagged('thanks', 'pass', ['chitchat']),
    tagged('tents', 'pass', ['search']),
    tagged('jackets', 'pass', ['search']),
  ]);

  it('compares only the cases it ran: a case it did not run is no regression', () => {
    const limited = run([tagged('thanks', 'pass', ['chitchat'])]);
    const outcome = gate(limited, {}, full);
    expect(outcome.verdict).toBe('pass');
    expect(outcome.breaches).toEqual([]);
    expect(outcome.notices).toEqual([
      // The baseline lists its cases by id.
      'jackets passed in the baseline but is not in this run',
      'tents passed in the baseline but is not in this run',
    ]);
  });

  it('still breaks on a regression among the cases it ran', () => {
    const limited = run([
      tagged('tents', 'fail', ['search']),
      tagged('jackets', 'pass', ['search']),
    ]);
    expect(gate(limited, {}, full)).toMatchObject({
      verdict: 'broken',
      breaches: [
        { rule: 'failures', cases: ['tents'] },
        { rule: 'regression', cases: ['tents'] },
      ],
    });
  });
});

/** A redteam case of a kind, its one sample failing or passing one finding (ADR-0089). */
function attack(id: string, kind: string, verdict: 'pass' | 'fail' | undefined, review = false) {
  return {
    ...kase(
      id,
      verdict === 'fail' ? 'fail' : verdict === 'pass' ? 'pass' : 'unmeasured',
      'redteam',
    ),
    kinds: [kind],
    ...(review ? { review: 'proposed' as const } : {}),
    samples: [
      {
        index: 0,
        cache: 'cold' as const,
        turns: [
          {
            user: 'x',
            checks: [
              {
                check: 'answer-text',
                applicable: verdict !== undefined,
                findings:
                  verdict === undefined
                    ? []
                    : [{ dimension: 'd', verdict, severity: 'high' as const, message: 'm' }],
              },
            ],
          },
        ],
      },
    ],
  } satisfies CaseResult;
}

const TAXONOMY = {
  frameworks: [],
  kinds: {
    injection: { severity: 'high' as const, categories: [] },
    card: { severity: 'critical' as const, categories: [] },
  },
  checks: {},
};

/** Results of these cases with the mapping of their kinds. */
const mapped = (cases: CaseResult[]) => ({ ...run(cases), taxonomy: TAXONOMY });

/** A configuration with this gate, parsed. */
const parse = (gateConfig: unknown) => YoklaConfig.safeParse({ version: 1, gate: gateConfig });

describe('evaluateGate with gate.maxRisk (ADR-0089)', () => {
  // Failures are allowed here, so that only the risk decides.
  const loose = { maxFailures: 10, allowUnmeasured: false };

  it('breaks on a kind of the approved cases that scores above it, naming its failing cases', () => {
    const results = mapped([
      attack('a', 'injection', 'fail'),
      attack('b', 'injection', 'pass'),
      attack('c', 'card', 'pass'),
    ]);
    expect(gate(results, { ...loose, maxRisk: 3 })).toMatchObject({
      verdict: 'broken',
      breaches: [
        {
          rule: 'risk',
          suite: 'redteam',
          cases: ['a'],
          message: 'redteam: injection scores 3.75 (1 of 2 trials), above gate.maxRisk 3: a',
        },
      ],
    });
    // A score at the threshold is within it; without it, nothing is scored.
    expect(gate(results, { ...loose, maxRisk: 3.75 }).verdict).toBe('pass');
    expect(gate(results, loose).verdict).toBe('pass');
  });

  it('scores only the approved cases: a proposed case waits for a person', () => {
    const results = mapped([
      attack('a', 'injection', 'fail', true),
      attack('b', 'injection', 'pass'),
    ]);
    expect(gate(results, { ...loose, maxRisk: 0 }).breaches).toEqual([]);
  });

  it('counts a kind with no judged trial, or results without kinds, as unmeasured', () => {
    const unjudged = mapped([attack('a', 'card', undefined)]);
    expect(gate(unjudged, { ...loose, allowUnmeasured: true, maxRisk: 5 }).breaches).toEqual([]);
    // The case is unmeasured too, which the suite counts on its own.
    expect(gate(unjudged, { maxFailures: 10, maxRisk: 5 }).breaches).toContainEqual({
      rule: 'unmeasured',
      suite: 'redteam',
      cases: ['a'],
      message:
        'redteam: gate.maxRisk is set, but no trial of card was judged; unmeasured never counts as a pass',
    });
    // The redteam suite's own allowance counts too.
    expect(
      gate(unjudged, {
        maxFailures: 10,
        maxRisk: 5,
        suites: { redteam: { allowUnmeasured: true } },
      }).breaches,
    ).toEqual([]);
    for (const results of [run([attack('a', 'card', 'fail')]), mapped([kase('b', 'pass')])]) {
      expect(gate(results, { maxFailures: 10, maxRisk: 5 }).breaches).toEqual([
        {
          rule: 'unmeasured',
          suite: 'redteam',
          cases: [],
          message:
            'redteam: gate.maxRisk is set, but no approved case has an attack kind; unmeasured never counts as a pass',
        },
      ]);
    }
  });

  it('takes a threshold from 0 to 10, at the top of gate only', () => {
    expect(parse({ maxRisk: 0 }).success).toBe(true);
    expect(parse({ maxRisk: 10 }).success).toBe(true);
    expect(parse({ maxRisk: 10.5 }).success).toBe(false);
    expect(parse({ maxRisk: -1 }).success).toBe(false);
    expect(parse({ suites: { redteam: { maxRisk: 5 } } }).success).toBe(false);
  });
});
