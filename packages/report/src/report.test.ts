import { Results, RESULTS_SCHEMA_ID } from '@yokla/core';
import { describe, expect, it, vi } from 'vitest';
import {
  CONTENT_SECURITY_POLICY,
  htmlReport,
  junitXml,
  terminalSummary,
  xmlAttribute,
  xmlText,
} from './index.ts';

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

  it('marks proposed cases, and says they gate once approved (ADR-0004)', () => {
    const { out } = terminalSummary(
      results([{ ...typeFail, review: 'proposed' }, kase('ok', 'pass', { review: 'proposed' })]),
    );
    expect(out.slice(0, 3)).toEqual([
      '2 cases: pass 1, fail 1',
      '  2 proposed: they ran, and gate once a person sets their status to approved',
      '  fail  high-chair  filter-honesty 1/1: presents 7 product(s) of other types [proposed]',
    ]);
    expect(terminalSummary(mixed).out.join('\n')).not.toContain('proposed');
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

  it('skips a proposed case whatever its status, and keeps the status in the message', () => {
    const proposed = junitXml(results([{ ...typeFail, review: 'proposed' }]));
    expect(proposed).toContain('tests="1" failures="0" errors="0" skipped="1"');
    expect(proposed).toContain(
      '<skipped message="proposed, not approved yet: fail: filter-honesty 1/1: presents 7 product(s) of other types"/>',
    );
    expect(proposed).not.toContain('<failure');
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

/** Every tag of a page. */
function tags(page: string): { name: string; closing: boolean; attributes: string }[] {
  return [...page.matchAll(/<(\/?)([!a-z][a-z0-9]*)([^<>]*)>/giu)].map((match) => ({
    name: (match[2] ?? '').toLowerCase(),
    closing: match[1] === '/',
    attributes: match[3] ?? '',
  }));
}

/** Text as the HTML report escapes it. */
function escapeHtml(text: string): string {
  return xmlText(text).replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

describe('htmlReport (ADR-0023)', () => {
  const HOSTILE = [
    '<script>alert(1)</script>',
    '<img src=x onerror=alert(1)>',
    '"><a href="https://example.com/">x</a>',
    "'><style>body { display: none }</style>",
    '<meta http-equiv="refresh" content="0; url=https://example.com/">',
    '</pre></details></body>',
  ].join('\n');

  const call = {
    id: 'call-1',
    upstream: 'anthropic',
    model: 'model-a',
    status: 200,
    durationMs: 812.4,
    stream: true,
    usage: { input: 1200, output: 80, cachedInput: 1000, cacheWrite: null, reasoning: null },
    costUsd: 0.001234567,
    prompt: [
      { role: 'system' as const, chars: 20, sha256: 'b'.repeat(64), text: 'SECRET SYSTEM PROMPT' },
      { role: 'user' as const, chars: 8, sha256: 'c'.repeat(64), text: 'question' },
    ],
  };

  const rich = results(
    [
      kase('stroller', 'pass', {
        dimensions: [dimension('fabrication', { verdict: 'pass', failed: 0 })],
        samples: [
          {
            index: 0,
            cache: 'cold',
            turns: [
              turn({
                checks: [
                  {
                    check: 'price-grounded',
                    applicable: true,
                    findings: [
                      {
                        dimension: 'fabrication',
                        verdict: 'pass',
                        severity: 'high',
                        message: '1 amount(s) match returned prices',
                      },
                    ],
                  },
                ],
              }),
            ],
          },
        ],
      }),
      kase('hostile', 'fail', {
        review: 'proposed',
        unstable: true,
        dimensions: [
          dimension('fabrication', {
            samples: 2,
            interval: { level: 0.95, lower: 0.0945, upper: 0.9055 },
          }),
        ],
        samples: [
          {
            index: 0,
            cache: 'cold',
            turns: [
              {
                user: HOSTILE,
                requestId: 'req-1',
                response: {
                  status: 200,
                  latencyMs: 1532.6,
                  firstTextMs: 210.2,
                  route: HOSTILE,
                  text: HOSTILE,
                  evidence: { products: [{ id: 'p1', name: HOSTILE, price: 5 }] },
                },
                issues: [HOSTILE],
                proxy: { correlation: 'serial', calls: [call], costUsd: 0.001234567 },
                observed: {
                  source: 'target-logs',
                  correlation: 'order',
                  fields: { route: HOSTILE, costUsd: 0.0012 },
                },
                checks: [
                  {
                    check: 'price-grounded',
                    applicable: true,
                    findings: [
                      {
                        dimension: 'fabrication',
                        verdict: 'fail',
                        severity: 'high',
                        message: HOSTILE,
                        evidence: { raw: HOSTILE },
                      },
                    ],
                  },
                  {
                    check: 'cost-budget',
                    applicable: true,
                    findings: [],
                    unmeasured: [{ dimension: 'cost', reason: 'no model proxy data' }],
                  },
                  { check: 'policy-claim', applicable: false, findings: [] },
                  { check: 'stock-claim', applicable: false, findings: [] },
                ],
              },
            ],
          },
          {
            index: 1,
            cache: 'warm',
            turns: [turn({ error: HOSTILE, response: undefined })],
          },
        ],
      }),
      kase('greeting', 'unmeasured', { suite: 'quality', language: 'en' }),
      kase('known', 'known-gap', { knownGap: { reason: HOSTILE, issue: '#12' } }),
    ],
    {
      partial: true,
      correlation: 'serial',
      issues: [HOSTILE],
      profile: { target: HOSTILE, sha256: 'a'.repeat(64) },
      proxy: {
        correlation: 'serial',
        records: 2,
        attributed: 1,
        unattributed: 1,
        totals: { calls: 2, costUsd: 0.001234567, inputTokens: 1200 },
        missing: { reasoningTokens: 2 },
        prompts: 'full',
      },
      observation: {
        source: 'target-logs',
        correlation: 'order',
        lines: 3,
        matched: 2,
        unmatched: 1,
        totals: { costUsd: 0.0012 },
        missing: {},
      },
    },
  );
  rich.checks.push(
    { check: 'price-grounded', applied: 2, notApplicable: 0, passed: 1, failed: 1, errors: 0 },
    { check: 'policy-claim', applied: 0, notApplicable: 2, passed: 0, failed: 0, errors: 0 },
    {
      check: 'cost-budget',
      applied: 1,
      notApplicable: 1,
      passed: 0,
      failed: 0,
      errors: 0,
      unmeasured: 1,
    },
  );

  const ALLOWED = new Set(
    '!doctype html head meta title style body section h1 h2 h3 h4 p dl dt dd ul li div table thead tbody tr th td details summary pre code span a'.split(
      ' ',
    ),
  );

  it('has no script, loads nothing and links nowhere else', () => {
    const page = htmlReport(rich);
    const found = tags(page);
    // Text is escaped, so every "<" opens a tag of the report's own.
    expect(page.split('<').length - 1).toBe(found.length);
    expect(found.filter((tag) => !ALLOWED.has(tag.name))).toEqual([]);
    expect(
      found.filter((tag) => /\s(?:on[a-z]+|src|srcset|action)\s*=/iu.test(tag.attributes)),
    ).toEqual([]);
    const hrefs = found.flatMap((tag) =>
      [...tag.attributes.matchAll(/href="([^"]*)"/gu)].map((m) => m[1]),
    );
    expect(hrefs.length).toBeGreaterThan(0);
    expect(hrefs.filter((href) => href?.startsWith('#case-') !== true)).toEqual([]);
    const opened = (name: string) => found.filter((tag) => tag.name === name && !tag.closing);
    expect(opened('meta')).toHaveLength(4);
    expect(opened('style')).toHaveLength(1);
    expect(opened('body')).toHaveLength(1);
    expect(page).toContain(
      `<meta http-equiv="Content-Security-Policy" content="${CONTENT_SECURITY_POLICY}">`,
    );
    expect(CONTENT_SECURITY_POLICY).toBe("default-src 'none'; style-src 'unsafe-inline'");
  });

  it('shows untrusted text as text', () => {
    const page = htmlReport(rich);
    const escaped = escapeHtml(HOSTILE);
    // As text: the user's message, the answer, its route, the turn's issue and error, the
    // finding and the known gap (each in the case table, the case's summary and its body), the
    // target and the run's issue. The evidence and observed fields are escaped JSON.
    expect(page.split(escaped).length - 1).toBe(13);
    expect(page).toContain(escapeHtml(JSON.stringify(HOSTILE)));
    expect(page).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(page).not.toContain('<script');
    expect(page).not.toContain('https://example.com/">');
  });

  it('gives the same bytes for the same results, whenever it is rendered', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2031-01-01T00:00:00Z'));
      const first = htmlReport(rich);
      vi.setSystemTime(new Date('2032-06-15T12:00:00Z'));
      expect(htmlReport(rich)).toBe(first);
      expect(first).not.toMatch(/203[12]/u);
    } finally {
      vi.useRealTimers();
    }
  });

  it('puts the cases that did not pass first and open, and the passed ones closed', () => {
    const details = [
      ...htmlReport(rich).matchAll(/<details class="case" id="case-([^"]+)"( open)?>/gu),
    ].map((match) => `${match[1] ?? ''}${match[2] ?? ''}`);
    expect(details).toEqual(['hostile open', 'greeting open', 'known open', 'stroller']);
  });

  it("shows a model call's prompt by role and size only", () => {
    const page = htmlReport(rich);
    expect(page).toContain('<td>system 20, user 8</td>');
    expect(page).not.toContain('SECRET SYSTEM PROMPT');
    expect(page).not.toContain('b'.repeat(64));
    expect(page).toContain('$0.001235');
  });

  it('shows what was measured, what was not, and what never applied', () => {
    const page = htmlReport(rich);
    expect(page).toContain('<span class="status warn">unmeasured</span></td><td>cost</td>');
    expect(page).toContain('no model proxy data');
    expect(page).toContain('Not applicable: policy-claim, stock-claim');
    expect(page).toContain('<code>policy-claim</code><span class="mark">never applied</span>');
    expect(page).not.toContain('<code>price-grounded</code><span class="mark">never applied');
    expect(page).toContain('partial: the run stopped early');
    expect(page).toContain('2 of 3 turns matched, by order');
    expect(page).toContain('reasoningTokens no value on 2 calls');
    expect(page).toContain('[proposed]');
    expect(page).toContain('[unstable]');
    expect(page).toContain('0.095 to 0.905');
  });

  it('matches its snapshot', async () => {
    await expect(htmlReport(rich)).toMatchFileSnapshot('./__snapshots__/report.html');
  });
});
