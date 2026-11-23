import { COMPARISON_SCHEMA_ID, type Comparison } from '@yokla/core';
import { describe, expect, it } from 'vitest';
import { changeOf, comparisonText } from './compare.ts';

const run = (id: string, label: string, verdict: 'pass' | 'broken', costUsd: number | null) => ({
  id,
  label,
  profileSha256: 'a'.repeat(64),
  gate: {
    verdict,
    breaches: verdict === 'pass' ? [] : ['factual: 1 failing case, 0 allowed: a'],
    problems: [],
  },
  statuses: verdict === 'pass' ? { pass: 2 } : { pass: 1, fail: 1 },
  costUsd,
  costPerTurnUsd: costUsd === null ? null : costUsd / 2,
  latencyP50Ms: 120.4,
  latencyP95Ms: null,
});

const comparison: Comparison = {
  schema: COMPARISON_SCHEMA_ID,
  runs: [
    run('r1', 'as the app asks', 'pass', 0.008),
    run('r2', 'fake: big → mini', 'pass', 0.004),
    run('r3', 'fake: big → nano', 'broken', null),
  ],
  cases: [
    {
      id: 'a',
      suite: 'factual',
      statuses: ['pass', 'pass', 'fail'],
      differs: true,
      changed: false,
    },
    {
      id: 'long-id',
      suite: 'factual',
      statuses: ['pass', null, 'pass'],
      differs: false,
      changed: true,
    },
    {
      id: 'b',
      suite: 'factual',
      statuses: ['pass', 'pass', 'pass'],
      differs: false,
      changed: false,
    },
  ],
  cheapest: { runs: ['r2'], costUsd: 0.004 },
  notices: ['the runs were made with different profiles'],
};

describe('comparisonText (ADR-0042)', () => {
  it('shows each run, the cases that differ, and the cheapest run that passes', () => {
    expect(comparisonText(comparison)).toEqual([
      '3 runs compared:',
      '  A  as the app asks  (run r1)',
      '     gate pass; pass 2; 0.008000 USD, 0.004000 USD a turn; latency p50 120 ms, p95 -',
      '  B  fake: big → mini  (run r2)',
      '     gate pass; pass 2; 0.004000 USD, 0.002000 USD a turn; latency p50 120 ms, p95 -',
      '  C  fake: big → nano  (run r3)',
      '     gate broken; pass 1, fail 1; cost unknown, per turn unknown; latency p50 120 ms, p95 -',
      '     - factual: 1 failing case, 0 allowed: a',
      '2 cases differ (A / B / C):',
      '  a        pass / pass / fail',
      '  long-id  pass / missing / pass  [definition differs: not compared]',
      'every case fails the same findings in every run',
      'cheapest passing run: B (fake: big → mini), 0.004000 USD',
      'note: the runs were made with different profiles',
    ]);
  });

  it('says why no cheapest run is named, and when every case agrees', () => {
    const lines = comparisonText({
      ...comparison,
      cases: comparison.cases.filter((c) => !c.differs && !c.changed),
      cheapest: null,
      noCheapest: 'no run passes the gate',
      notices: [],
    });
    expect(lines.slice(-3)).toEqual([
      'every case has the same status in every run',
      'every case fails the same findings in every run',
      'cheapest passing run: none named: no run passes the gate',
    ]);
  });
});

const row = (failed: (number | null)[], messages: (string | null)[] = failed.map(() => null)) => ({
  turn: 1,
  check: 'price-grounded',
  dimension: 'fabrication',
  failed,
  messages,
});

describe('the findings that changed (ADR-0095)', () => {
  it('reads each later run against the first', () => {
    expect(changeOf(row([0, 2]), 1)).toBe('new');
    expect(changeOf(row([1, 0]), 1)).toBe('gone');
    expect(changeOf(row([1, 3]), 1)).toBe('kept');
    expect(changeOf(row([0, 0]), 1)).toBeUndefined();
    expect(changeOf(row([1, null]), 1)).toBeUndefined();
    // A base that lacks the case: what fails later is new.
    expect(changeOf(row([null, 1]), 1)).toBe('new');
  });

  it('lists each later run’s new and gone findings, and counts the kept', () => {
    const lines = comparisonText({
      ...comparison,
      cases: [
        {
          id: 'a',
          suite: 'factual',
          statuses: ['pass', 'fail', 'fail'],
          differs: true,
          changed: false,
          findingsDiffer: true,
          findings: [
            { ...row([0, 1, 1], [null, '"9 TL" is not a price', 'again']), turn: 0 },
            { ...row([1, 0, 1], ['stock', null, 'stock']), check: 'stock-claim' },
            { ...row([1, 1, 1], ['policy', 'policy', 'policy']), check: 'policy-claim' },
          ],
        },
        {
          id: 'half',
          suite: 'factual',
          statuses: ['fail', 'fail', 'fail'],
          differs: false,
          changed: false,
          findingsDiffer: true,
          findings: [row([1, 0, 1], ['stock', null, 'stock'])],
        },
        {
          id: 'quiet',
          suite: 'factual',
          statuses: ['pass', 'pass', 'pass'],
          differs: false,
          changed: false,
          findingsDiffer: false,
          findings: [row([1, 1, 1])],
        },
      ],
    });
    const start = lines.indexOf('2 cases with findings that differ, each run against A:');
    expect(lines.slice(start, start + 9)).toEqual([
      '2 cases with findings that differ, each run against A:',
      '  a  B: 1 new, 1 gone, 1 kept',
      '    new   turn 0  price-grounded (fabrication): "9 TL" is not a price',
      '    gone  turn 1  stock-claim (fabrication): stock',
      '  a  C: 1 new, 0 gone, 2 kept',
      '    new   turn 0  price-grounded (fabrication): again',
      // C keeps what A failed: no line for it.
      '  half  B: 0 new, 1 gone, 0 kept',
      '    gone  turn 1  price-grounded (fabrication): stock',
      'cheapest passing run: B (fake: big → mini), 0.004000 USD',
    ]);
  });
});
