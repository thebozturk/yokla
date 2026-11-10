import { Results, RESULTS_SCHEMA_ID } from '@yokla/core';
import { describe, expect, it } from 'vitest';
import { junitXml, terminalSummary, xmlAttribute, xmlText } from './index.ts';

type CaseResult = Results['cases'][number];
type TurnResult = CaseResult['samples'][number]['turns'][number];
type Dimension = CaseResult['dimensions'][number];

const ANSWER = 'the target answer must never reach a report';

function turn(change: Partial<TurnResult> = {}): TurnResult {
  return {
    user: 'question',
    response: { status: 200, latencyMs: 120, text: ANSWER, evidence: {} },
    checks: [],
    ...change,
  };
}

function failing(check: string, name: string, message: string): TurnResult['checks'][number] {
  return {
    check,
    applicable: true,
    findings: [{ dimension: name, verdict: 'fail', severity: 'high', message }],
  };
}

function dimension(name: string, change: Partial<Dimension> = {}): Dimension {
  return {
    dimension: name,
    policy: 'worst-of-n',
    verdict: 'fail',
    samples: 1,
    failed: 1,
    ...change,
  };
}

function kase(
  id: string,
  status: CaseResult['status'],
  change: Partial<CaseResult> = {},
): CaseResult {
  return {
    id,
    suite: 'factual',
    language: 'tr',
    status,
    unstable: false,
    dimensions: [],
    samples: [{ index: 0, cache: 'cold', turns: [turn()] }],
    ...change,
  };
}

function results(cases: CaseResult[], run: Partial<Results['run']> = {}): Results {
  const statuses: Partial<Record<CaseResult['status'], number>> = {};
  for (const c of cases) statuses[c.status] = (statuses[c.status] ?? 0) + 1;
  const value: Results = {
    schema: RESULTS_SCHEMA_ID,
    yokla: { version: '0.0.0-test' },
    run: {
      id: 'run-1',
      startedAt: '2026-11-10T12:00:00.000Z',
      finishedAt: '2026-11-10T12:00:02.500Z',
      durationMs: 2500,
      profile: { target: 't', sha256: 'a'.repeat(64) },
      environment: { node: 'v24.0.0', platform: 'darwin', arch: 'arm64' },
      correlation: 'none',
      partial: false,
      ...run,
    },
    cases,
    checks: [],
    summary: { cases: cases.length, statuses },
  };
  expect(Results.safeParse(value).success).toBe(true);
  return value;
}

const typeFail = kase('high-chair', 'fail', {
  dimensions: [
    dimension('filter-honesty'),
    dimension('fabrication', { verdict: 'pass', failed: 0 }),
  ],
  samples: [
    {
      index: 0,
      cache: 'cold',
      turns: [
        turn({
          checks: [
            failing(
              'type-matched-or-disclosed',
              'filter-honesty',
              'presents 7 product(s) of other types',
            ),
            failing('price-grounded', 'fabrication', 'a failing finding in a passing dimension'),
          ],
        }),
      ],
    },
  ],
});

const mixed = results([
  kase('stroller', 'pass'),
  typeFail,
  kase('bitcoin', 'fail', {
    suite: 'quality',
    unstable: true,
    dimensions: [dimension('refusal', { policy: 'majority-of-n', samples: 3, failed: 2 })],
    samples: [0, 1, 2].map((index) => ({
      index,
      cache: 'cold' as const,
      turns: [
        turn({
          checks: [
            index === 0
              ? {
                  check: 'over-refusal',
                  applicable: true,
                  findings: [
                    { dimension: 'refusal', verdict: 'pass', severity: 'high', message: 'refused' },
                  ],
                }
              : failing('over-refusal', 'refusal', 'did not refuse'),
          ],
        }),
      ],
    })),
  }),
  kase('broken', 'error', {
    samples: [{ index: 0, cache: 'cold', turns: [turn({ error: 'HTTP 500' })] }],
  }),
  kase('zibin', 'unmeasured'),
  kase('gift-wrap', 'known-gap', { knownGap: { reason: 'not built yet', issue: 'T-12' } }),
  kase('pacifier', 'gap-closed', { knownGap: { reason: 'was missing' } }),
  kase('returns', 'pass', {
    suite: 'quality',
    dimensions: [dimension('deflection', { policy: 'advisory' })],
    samples: [
      {
        index: 0,
        cache: 'cold',
        turns: [
          turn({ checks: [failing('deflection', 'deflection', 'sent only to customer service')] }),
        ],
      },
    ],
  }),
]);

describe('terminalSummary', () => {
  it('counts statuses in a fixed order and explains every case that did not plainly pass', () => {
    const { out } = terminalSummary(mixed);
    expect(out).toEqual([
      '8 cases: pass 2, fail 2, error 1, known-gap 1, gap-closed 1, unmeasured 1',
      '  fail        high-chair  filter-honesty 1/1: presents 7 product(s) of other types',
      '  fail        bitcoin     refusal 2/3: did not refuse [unstable]',
      '  error       broken      sample 0, turn 0: HTTP 500',
      '  unmeasured  zibin       no check applied to any turn',
      '  known-gap   gift-wrap   known gap: not built yet (T-12)',
      '  gap-closed  pacifier    passes now; remove the known-gap marker and update the baseline',
      '  advisory    returns     deflection 1/1: sent only to customer service',
    ]);
  });

  it('reports turn errors and run issues on stderr', () => {
    const { err } = terminalSummary(results(mixed.cases, { issues: ['logs unreadable'] }));
    expect(err).toEqual(['  broken [sample 0]: HTTP 500', '  run: logs unreadable']);
  });

  it('states what the model proxy recorded, and what it could not price', () => {
    const { out } = terminalSummary(
      results([kase('a', 'pass')], {
        correlation: 'serial',
        proxy: {
          correlation: 'serial',
          records: 3,
          attributed: 2,
          unattributed: 1,
          totals: { calls: 3, inputTokens: 900, outputTokens: 120, costUsd: 0.0012345678 },
          missing: { costUsd: 1, cachedInputTokens: 3 },
        },
      }),
    );
    expect(out).toContain(
      'model proxy (serial): 3 calls, 1 unattributed; inputTokens 900, outputTokens 120, costUsd 0.001235 (no value on 1 call), cachedInputTokens no value on 3 calls',
    );
  });

  it('says which threshold went unmeasured, and why', () => {
    const gap = {
      check: 'cost-budget',
      applicable: true,
      findings: [],
      unmeasured: [{ dimension: 'cost', reason: 'no model proxy data for this turn' }],
    };
    const { out } = terminalSummary(
      results([
        kase('budgeted', 'unmeasured', {
          dimensions: [dimension('cost', { verdict: 'unmeasured', samples: 0, failed: 0 })],
          samples: [
            { index: 0, cache: 'cold', turns: [turn({ checks: [gap] }), turn({ checks: [gap] })] },
          ],
        }),
      ]),
    );
    expect(out).toContain(
      '  unmeasured  budgeted  unmeasured cost: no model proxy data for this turn',
    );
  });

  it('shows one line for a clean run and never the answers', () => {
    const { out, err } = terminalSummary(results([kase('a', 'pass')]));
    expect(out).toEqual(['1 cases: pass 1']);
    expect(err).toEqual([]);
    expect(JSON.stringify(terminalSummary(mixed))).not.toContain(ANSWER);
  });
});

describe('junitXml', () => {
  const xml = junitXml(mixed);

  it('writes one testsuite per suite with JUnit counts; unmeasured and known gaps are skipped', () => {
    expect(xml).toMatch(/^<\?xml version="1\.0" encoding="UTF-8"\?>\n<testsuites name="yokla" /u);
    expect(xml).toContain(
      '<testsuites name="yokla" tests="8" failures="2" errors="1" skipped="2" time="2.500">',
    );
    expect(xml).toContain(
      '<testsuite name="factual" tests="6" failures="1" errors="1" skipped="2" time="0.720" timestamp="2026-11-10T12:00:00.000Z">',
    );
    expect(xml).toContain(
      '<testsuite name="quality" tests="2" failures="1" errors="0" skipped="0" time="0.480"',
    );
    expect(xml.trimEnd().endsWith('</testsuites>')).toBe(true);
  });

  it('writes the failing findings of the deciding dimensions as the failure', () => {
    expect(xml).toContain(
      [
        '    <testcase name="high-chair" classname="yokla.factual" time="0.120">',
        '      <failure type="fail" message="filter-honesty 1/1: presents 7 product(s) of other types">sample 0, turn 0: type-matched-or-disclosed (filter-honesty): presents 7 product(s) of other types</failure>',
        '    </testcase>',
      ].join('\n'),
    );
    expect(xml).not.toContain('a failing finding in a passing dimension');
  });

  it('maps each status to its element', () => {
    expect(xml).toContain('<testcase name="stroller" classname="yokla.factual" time="0.120"/>');
    expect(xml).toContain(
      '<error type="error" message="sample 0, turn 0: HTTP 500">sample 0, turn 0: HTTP 500</error>',
    );
    expect(xml).toContain('<skipped message="unmeasured: no check applied to any turn"/>');
    expect(xml).toContain('<skipped message="known gap: not built yet (T-12)"/>');
    expect(xml).toContain(
      '<system-out>gap closed: passes now; remove the known-gap marker and update the baseline</system-out>',
    );
    expect(xml).toMatch(/<failure type="fail" message="refusal 2\/3: did not refuse">/u);
    expect(xml).toContain('<system-out>unstable: the samples disagree</system-out>');
    expect(xml).toContain(
      '<system-out>advisory: sample 0, turn 0: deflection (deflection): sent only to customer service</system-out>',
    );
  });

  it('never writes the answers', () => {
    expect(xml).not.toContain(ANSWER);
  });

  it('counts a missing fixture as an error and reports check errors', () => {
    const checkError = {
      check: 'price-grounded',
      applicable: true,
      findings: [
        {
          dimension: 'check-error',
          verdict: 'error' as const,
          severity: 'high' as const,
          message: 'check "price-grounded" failed: boom',
        },
      ],
    };
    const broken = results([
      kase('no-fixture', 'fixture-missing'),
      kase('check-broke', 'error', {
        samples: [{ index: 0, cache: 'cold', turns: [turn({ checks: [checkError] })] }],
      }),
    ]);
    const out = junitXml(broken);
    expect(out).toContain('tests="2" failures="0" errors="2" skipped="0"');
    expect(out).toContain('<error type="fixture-missing" message="fixture-missing"></error>');
    expect(out).toContain(
      '<error type="error" message="sample 0, turn 0: check &quot;price-grounded&quot; failed: boom">',
    );
    expect(terminalSummary(broken).out).toContain(
      '  error            check-broke  sample 0, turn 0: check "price-grounded" failed: boom',
    );
  });

  it('escapes what XML cannot carry as is', () => {
    expect(xmlText('a < b && c > "d"')).toBe('a &lt; b &amp;&amp; c &gt; "d"');
    expect(xmlAttribute('say "hi"\nnext\ttab')).toBe('say &quot;hi&quot;&#10;next&#9;tab');
    expect(xmlText('bell\u0007 lone\uD800 ok 😀 \uE000ﬁ～')).toBe(
      'bell\uFFFD lone\uFFFD ok 😀 \uE000ﬁ～',
    );
    const hostile = results([
      kase('x', 'fail', {
        dimensions: [dimension('d')],
        samples: [
          {
            index: 0,
            cache: 'cold',
            turns: [turn({ checks: [failing('c', 'd', '</failure><x a="1">\u0001')] })],
          },
        ],
      }),
    ]);
    const out = junitXml(hostile);
    expect(out).toContain('&lt;/failure&gt;&lt;x a=&quot;1&quot;&gt;�');
    expect(out).not.toContain('<x a=');
  });
});
