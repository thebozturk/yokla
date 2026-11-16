import { COMPARISON_SCHEMA_ID, type Comparison } from '@yokla/core';
import { describe, expect, it } from 'vitest';
import { comparisonText } from './compare.ts';

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
    expect(lines.slice(-2)).toEqual([
      'every case has the same status in every run',
      'cheapest passing run: none named: no run passes the gate',
    ]);
  });
});
