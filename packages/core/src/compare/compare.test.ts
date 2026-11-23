import { describe, expect, it } from 'vitest';
import { evaluateGate } from '../gate/gate.ts';
import { Results, RESULTS_SCHEMA_ID } from '../schema/results.ts';
import { Comparison, compareRuns, findingRows, runLabel } from './compare.ts';

type CaseResult = Results['cases'][number];

interface Shape {
  readonly suite?: CaseResult['suite'];
  readonly latencyMs?: number;
  /** null: a call had no cost. */
  readonly costUsd?: number | null;
  readonly definition?: string;
}

/** A case whose one turn took `latencyMs` and cost `costUsd`. */
function kase(id: string, status: CaseResult['status'], shape: Shape = {}): CaseResult {
  const { suite = 'factual', latencyMs = 100, costUsd = 0.001, definition = 'd' } = shape;
  return {
    id,
    suite,
    language: 'tr',
    status,
    unstable: false,
    definitionSha256: definition.repeat(64).slice(0, 64),
    dimensions: [],
    samples: [
      {
        index: 0,
        cache: 'cold',
        turns: [
          {
            user: 'u',
            checks: [],
            response: { status: 200, latencyMs, evidence: {} },
            proxy: { correlation: 'serial', calls: [], costUsd },
          },
        ],
      },
    ],
  };
}

/** A run of these cases, with the proxy's total cost. */
function run(
  id: string,
  cases: CaseResult[],
  change: Partial<Results['run']> = {},
  cost: number | null = cases.reduce(
    (total, c) => total + (c.samples[0]?.turns[0]?.proxy?.costUsd ?? 0),
    0,
  ),
): Results {
  const statuses: Partial<Record<CaseResult['status'], number>> = {};
  for (const c of cases) statuses[c.status] = (statuses[c.status] ?? 0) + 1;
  return Results.parse({
    schema: RESULTS_SCHEMA_ID,
    yokla: { version: '0.0.0-test' },
    run: {
      id,
      startedAt: '2026-11-16T12:00:00.000Z',
      finishedAt: '2026-11-16T12:00:01.000Z',
      durationMs: 1000,
      profile: { target: 't', sha256: 'a'.repeat(64) },
      environment: { node: 'v24.0.0', platform: 'darwin', arch: 'arm64' },
      correlation: 'serial',
      partial: false,
      proxy: {
        correlation: 'serial',
        records: cases.length,
        attributed: cases.length,
        unattributed: 0,
        totals: cost === null ? {} : { costUsd: cost },
        missing: cost === null ? { costUsd: 1 } : {},
      },
      ...change,
    },
    cases,
    checks: [],
    summary: { cases: cases.length, statuses },
  });
}

const swapped = (model: string) => ({
  swaps: [{ upstream: 'fake', asked: 'big', model, calls: 2 }],
});

const compared = (...runs: Results[]) =>
  compareRuns(runs.map((results) => ({ results, gate: evaluateGate(results) })));

describe('runLabel', () => {
  it("names a run by its swaps, or as the app's own", () => {
    expect(runLabel(run('a', []))).toBe('as the app asks');
    expect(runLabel(run('b', [], swapped('mini')))).toBe('fake: big → mini');
    expect(
      runLabel(
        run('c', [], {
          swaps: [
            { upstream: 'fake', asked: 'big', model: 'mini', to: 'gw', calls: 1 },
            { upstream: 'fake', asked: 'small', model: 'nano', calls: 1 },
          ],
        }),
      ),
    ).toBe('fake: big → gw/mini; fake: small → nano');
  });

  it('names the strategy a run sent its attacks with, after its transforms (ADR-0084)', () => {
    expect(runLabel(run('s', [], { strategy: { name: 'hex', messages: 4 } }))).toBe(
      'strategy: hex',
    );
    expect(
      runLabel(
        run('t', [], {
          transforms: [{ kind: 'typos', messages: 1 }],
          strategy: { name: 'base64+roleplay', messages: 1 },
        }),
      ),
    ).toBe('transforms: typos; strategy: base64+roleplay');
  });

  it('names the tool changes and the transforms a run made, after its swaps (ADR-0045)', () => {
    expect(
      runLabel(
        run('d', [], {
          transforms: [
            { kind: 'no-diacritics', messages: 3 },
            { kind: 'typos', messages: 5 },
          ],
        }),
      ),
    ).toBe('transforms: no-diacritics, typos');
    expect(
      runLabel(
        run('e', [], {
          ...swapped('mini'),
          toolChanges: [{ tool: 'search_products', at: '$.results', results: 2 }],
          transforms: [{ kind: 'lowercase', messages: 1 }],
        }),
      ),
    ).toBe('fake: big → mini; reversed: search_products=$.results; transforms: lowercase');
  });
});

describe('compareRuns (ADR-0042)', () => {
  const big = run('big', [
    kase('a', 'pass', { costUsd: 0.004 }),
    kase('b', 'pass', { costUsd: 0.004 }),
  ]);
  const mini = run(
    'mini',
    [kase('a', 'pass', { costUsd: 0.002, latencyMs: 300 }), kase('b', 'pass', { costUsd: 0.002 })],
    swapped('mini'),
  );
  const nano = run(
    'nano',
    [kase('a', 'fail', { costUsd: 0.001 }), kase('b', 'pass', { costUsd: 0.001 })],
    swapped('nano'),
  );

  it('names the cheapest run that passes the gate, not the cheapest run', () => {
    const comparison = compared(big, mini, nano);
    expect(Comparison.safeParse(comparison).success).toBe(true);
    expect(comparison.cheapest).toEqual({ runs: ['mini'], costUsd: 0.004 });
    expect(comparison.noCheapest).toBeUndefined();
    expect(comparison.runs.map((r) => [r.id, r.label, r.gate.verdict, r.costUsd])).toEqual([
      ['big', 'as the app asks', 'pass', 0.008],
      ['mini', 'fake: big → mini', 'pass', 0.004],
      ['nano', 'fake: big → nano', 'broken', 0.002],
    ]);
    expect(comparison.runs[2]?.gate.breaches).toEqual(['factual: 1 failing case, 0 allowed: a']);
  });

  it('puts the cases whose status differs first, a status per run', () => {
    const { cases } = compared(big, mini, nano);
    expect(cases).toMatchObject([
      {
        id: 'a',
        suite: 'factual',
        statuses: ['pass', 'pass', 'fail'],
        differs: true,
        changed: false,
      },
      {
        id: 'b',
        suite: 'factual',
        statuses: ['pass', 'pass', 'pass'],
        differs: false,
        changed: false,
      },
    ]);
  });

  it('measures cost per answered turn and latency percentiles over every answered turn', () => {
    const [, summary] = compared(big, mini).runs;
    expect(summary).toMatchObject({
      costPerTurnUsd: 0.002,
      latencyP50Ms: 100,
      latencyP95Ms: 300,
      statuses: { pass: 2 },
    });
    const silent = run('silent', [{ ...kase('a', 'unmeasured'), samples: [] }]);
    expect(compared(big, silent).runs[1]).toMatchObject({
      costPerTurnUsd: null,
      latencyP50Ms: null,
      latencyP95Ms: null,
    });
  });

  it('names no cheapest run when none passes, or a passing run has no known cost', () => {
    expect(compared(nano, nano)).toMatchObject({
      cheapest: null,
      noCheapest: 'no run passes the gate',
    });
    const unknown = run('unknown', [kase('a', 'pass', { costUsd: null })], {}, null);
    expect(compared(mini, unknown)).toMatchObject({
      cheapest: null,
      noCheapest: "the cost of run unknown isn't known, so no run can be named the cheapest",
    });
    expect(compared(mini, unknown).runs[1]).toMatchObject({ costUsd: null, costPerTurnUsd: null });
    // Without a proxy or spans, no cost is known.
    const { proxy: _proxy, ...bare } = mini.run;
    expect(compared(big, { ...mini, run: bare }).noCheapest).toBe(
      "the cost of run mini isn't known, so no run can be named the cheapest",
    );
    // Runs that tie are all named.
    expect(compared(mini, run('twin', mini.cases)).cheapest).toEqual({
      runs: ['mini', 'twin'],
      costUsd: 0.004,
    });
  });

  it('moves a case whose status differs ahead of those that agree', () => {
    const first = run('first', [kase('b', 'pass'), kase('a', 'pass')]);
    const second = run('second', [kase('b', 'pass'), kase('a', 'fail')]);
    expect(compared(first, second).cases.map((c) => c.id)).toEqual(['a', 'b']);
  });

  it('reads the cost from spans when no proxy measured it', () => {
    const { proxy: _proxy, ...spanned } = big.run;
    const fromSpans = {
      ...big,
      run: {
        ...spanned,
        spans: {
          received: 2,
          attributed: 2,
          unattributed: 0,
          totals: { costUsd: 0.003 },
          missing: {},
          settled: true,
        },
      },
    };
    expect(compared(fromSpans, mini).runs[0]?.costUsd).toBe(0.003);
  });

  it("doesn't compare a case whose definition differs, and shows one a run lacks", () => {
    const other = run('other', [kase('a', 'fail', { definition: 'e' }), kase('c', 'pass')]);
    const { cases } = compared(big, other);
    expect(cases).toMatchObject([
      { id: 'a', suite: 'factual', statuses: ['pass', 'fail'], differs: true, changed: true },
      { id: 'b', suite: 'factual', statuses: ['pass', null], differs: false, changed: false },
      { id: 'c', suite: 'factual', statuses: [null, 'pass'], differs: false, changed: false },
    ]);
  });

  it('notes runs from different profiles, and runs that replayed a cassette', () => {
    const elsewhere = run('elsewhere', big.cases, {
      profile: { target: 't', sha256: 'b'.repeat(64) },
      replay: { cassetteSha256: 'c'.repeat(64), loose: false, diverged: 0 },
    });
    expect(compared(big, elsewhere).notices).toEqual([
      'the runs were made with different profiles',
      "run elsewhere replayed a cassette: its latency isn't the model's (ADR-0040)",
    ]);
    expect(compared(big, mini).notices).toEqual([]);
  });
});

type Turn = CaseResult['samples'][number]['turns'][number];

/** A turn whose checks give these findings: [check, dimension, verdict, message]. */
function judged(findings: readonly (readonly [string, string, 'pass' | 'fail', string])[]): Turn {
  return {
    user: 'u',
    response: { status: 200, latencyMs: 100, evidence: {} },
    checks: findings.map(([check, dimension, verdict, message]) => ({
      check,
      applicable: true,
      findings: [{ dimension, verdict, severity: 'high', message }],
    })),
  };
}

/** A case of these samples, each a list of turns. */
function sampled(id: string, samples: readonly (readonly Turn[])[], definition = 'd'): CaseResult {
  return {
    id,
    suite: 'factual',
    language: 'tr',
    status: 'fail',
    unstable: false,
    definitionSha256: definition.repeat(64).slice(0, 64),
    dimensions: [],
    samples: samples.map((turns, index) => ({ index, cache: 'cold', turns: [...turns] })),
  };
}

/** A case whose every turn cost this much, as the proxy measured it. */
const withCost = (c: CaseResult, costUsd: number | null): CaseResult => ({
  ...c,
  samples: c.samples.map((sample) => ({
    ...sample,
    turns: sample.turns.map((turn) => ({
      ...turn,
      proxy: { correlation: 'serial' as const, calls: [], costUsd },
    })),
  })),
});

/** A passing turn that took this long. */
function timed(latencyMs: number): Turn {
  return {
    user: 'u',
    response: { status: 200, latencyMs, evidence: {} },
    checks: [],
  };
}

const fabricated = judged([['price-grounded', 'fabrication', 'fail', '"9 TL" is not a price']]);
const grounded = judged([['price-grounded', 'fabrication', 'pass', 'grounded']]);

describe('what changed inside a case (ADR-0095)', () => {
  it('has a row per turn, check and dimension that failed, with each run’s failing samples', () => {
    const before = sampled('a', [[grounded, grounded]]);
    const after = sampled('a', [
      [grounded, fabricated],
      [grounded, judged([['price-grounded', 'fabrication', 'fail', 'another']])],
    ]);
    expect(findingRows([before, after])).toEqual([
      {
        turn: 1,
        check: 'price-grounded',
        dimension: 'fabrication',
        failed: [0, 2],
        messages: [null, '"9 TL" is not a price'],
      },
    ]);
  });

  it('counts a sample once, however many findings fail the row in it, and orders the rows', () => {
    const twice = judged([
      ['stock-claim', 'fabrication', 'fail', 'first'],
      ['stock-claim', 'fabrication', 'fail', 'second'],
      ['policy-claim', 'fabrication', 'fail', 'policy'],
      ['price-grounded', 'answer', 'fail', 'answer'],
      ['stock-claim', 'availability', 'fail', 'availability'],
    ]);
    const rows = findingRows([sampled('a', [[twice], [twice]])]);
    expect(
      rows.map((row) => [row.turn, row.check, row.dimension, row.failed, row.messages]),
    ).toEqual([
      [0, 'policy-claim', 'fabrication', [2], ['policy']],
      [0, 'price-grounded', 'answer', [2], ['answer']],
      [0, 'stock-claim', 'availability', [2], ['availability']],
      [0, 'stock-claim', 'fabrication', [2], ['first']],
    ]);
    const later = findingRows([sampled('a', [[grounded, fabricated], [fabricated]])]);
    expect(later.map((row) => [row.turn, row.failed])).toEqual([
      [0, [1]],
      [1, [1]],
    ]);
  });

  it('marks a run that lacks the case, or the turn, apart from one that passed it', () => {
    const rows = findingRows([
      sampled('a', [[grounded, fabricated]]),
      undefined,
      sampled('a', [[grounded]]),
    ]);
    expect(rows.map((row) => row.failed)).toEqual([[1, null, null]]);
    const passed = findingRows([sampled('a', [[fabricated]]), sampled('a', [[grounded]])]);
    expect(passed.map((row) => row.failed)).toEqual([[1, 0]]);
  });

  it('says whether the findings differ, and gives each run’s cost and latency of the case', () => {
    const slow = sampled('a', [
      [{ ...fabricated, response: { status: 200, latencyMs: 300, evidence: {} } }],
    ]);
    const first = run('first', [
      withCost(sampled('a', [[grounded], [grounded], [grounded]]), 0.001),
    ]);
    const second = run('second', [withCost(slow, null)]);
    const [row] = compared(first, second).cases;
    expect(row).toMatchObject({
      findingsDiffer: true,
      costUsd: [0.003, null],
      latencyMs: [100, 300],
    });
    expect(row?.costUsd?.[0]).toBeCloseTo(0.003, 10);
    const same = compared(first, first).cases[0];
    expect(same?.findingsDiffer).toBe(false);
    expect(same?.findings).toEqual([]);
  });

  it('reads a case’s cost from its spans without a proxy, and knows none without either', () => {
    const spanned: CaseResult = {
      ...sampled('a', [[grounded]]),
      samples: [
        {
          index: 0,
          cache: 'cold',
          turns: [{ ...grounded, spans: { calls: [], costUsd: 0.002 } }],
        },
      ],
    };
    const bare = sampled('a', [[grounded]]);
    const { cases } = compared(run('x', [spanned]), run('y', [bare]));
    expect(cases[0]?.costUsd).toEqual([0.002, null]);
    const unanswered: CaseResult = {
      ...bare,
      samples: [{ index: 0, cache: 'cold', turns: [{ user: 'u', checks: [] }] }],
    };
    expect(compared(run('x', [unanswered]), run('y', [bare])).cases[0]?.latencyMs).toEqual([
      null,
      100,
    ]);
  });

  it('puts the cases whose findings differ after those whose status differs', () => {
    const moved = { ...sampled('moved', [[grounded]]), status: 'pass' as const };
    const changedInside = sampled('inside', [[fabricated]]);
    const same = sampled('same', [[fabricated]]);
    const before = run('before', [same, changedInside, moved]);
    const after = run('after', [
      same,
      sampled('inside', [[judged([['stock-claim', 'fabrication', 'fail', 'stock']])]]),
      sampled('moved', [[fabricated]]),
    ]);
    expect(compared(before, after).cases.map((c) => [c.id, c.differs, c.findingsDiffer])).toEqual([
      ['moved', true, true],
      ['inside', false, true],
      ['same', false, false],
    ]);
  });

  it('counts a row the same that fails in every run that has it, however often', () => {
    const once = run('once', [
      sampled('a', [
        [grounded, fabricated],
        [grounded, grounded],
      ]),
    ]);
    const twice = run('twice', [
      sampled('a', [
        [grounded, fabricated],
        [grounded, fabricated],
      ]),
    ]);
    const shorter = run('shorter', [sampled('a', [[fabricated]])]);
    const often = compared(once, twice).cases[0];
    expect(often?.findings?.map((row) => row.failed)).toEqual([[1, 2]]);
    expect(often?.findingsDiffer).toBe(false);
    // The shorter run lacks turn 1: its row there isn't a change.
    const lacking = compared(once, shorter).cases[0];
    expect(lacking?.findings?.find((row) => row.turn === 1)?.failed).toEqual([1, null]);
    expect(lacking?.findingsDiffer).toBe(true);
    const onlyLacking = compared(
      run('long', [sampled('a', [[fabricated, fabricated]])]),
      run('short', [sampled('a', [[fabricated]])]),
    ).cases[0];
    expect(onlyLacking?.findingsDiffer).toBe(false);
  });

  it('gives the median latency of a case’s answered turns', () => {
    const three = run('three', [sampled('a', [[timed(300)], [timed(100)], [timed(200)]])]);
    expect(compared(three, three).cases[0]?.latencyMs).toEqual([200, 200]);
  });

  it('gives a case whose definition differs no rows', () => {
    const before = run('before', [sampled('a', [[fabricated]])]);
    const after = run('after', [sampled('a', [[grounded]], 'e')]);
    expect(compared(before, after).cases[0]).toMatchObject({
      changed: true,
      findings: [],
      findingsDiffer: false,
    });
  });
});
