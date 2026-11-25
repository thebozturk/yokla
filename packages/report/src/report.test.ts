import {
  CORE_TAXONOMY,
  kindRisks,
  Results,
  RESULTS_SCHEMA_ID,
  runTaxonomy,
  summariseCases,
} from '@yokla/core';
import { describe, expect, it, vi } from 'vitest';
import {
  CONTENT_SECURITY_POLICY,
  htmlReport,
  junitXml,
  markdownReport,
  MARKDOWN_ROWS,
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

/** The summary of a run with this attacker (ADR-0088). */
function attackerSummary(attacker: NonNullable<Results['run']['attacker']>): readonly string[] {
  return terminalSummary(results([], { attacker })).out;
}

function results(cases: CaseResult[], run: Partial<Results['run']> = {}): Results {
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
    summary: summariseCases(cases),
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
      // Passing (pass, gap-closed) over measured (and fail): 3 of 5 (ADR-0076).
      '8 cases: pass 2, fail 2, error 1, known-gap 1, gap-closed 1, unmeasured 1; pass rate 0.600 (3 of 5, 95 % 0.231 to 0.882)',
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
      '2 cases: pass 1, fail 1; pass rate 0.500 (1 of 2, 95 % 0.095 to 0.905)',
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

  it('states what the spans showed, and when they kept coming (ADR-0029)', () => {
    const spans = {
      received: 4,
      attributed: 3,
      unattributed: 1,
      totals: { calls: 4, inputTokens: 400, outputTokens: 40, costUsd: 0.0005 },
      missing: { cachedInputTokens: 4 },
      settled: true,
    };
    const settled = terminalSummary(
      results([kase('a', 'pass')], { correlation: 'traceparent', spans }),
    ).out;
    expect(settled).toContain(
      'spans (traceparent): 4 calls, 1 unattributed; inputTokens 400, outputTokens 40, costUsd 0.0005, cachedInputTokens no value on 4 calls',
    );
    const late = terminalSummary(
      results([kase('a', 'pass')], {
        correlation: 'traceparent',
        spans: { ...spans, settled: false },
      }),
    ).out;
    expect(late.join('\n')).toContain(
      'spans (traceparent): 4 calls, 1 unattributed, still coming when the wait ran out;',
    );
  });

  it("totals yokla's own model calls apart from the target's (ADR-0028)", () => {
    const priced = terminalSummary(
      results([kase('a', 'pass')], { own: { calls: 3, cached: 1, costUsd: 0.0001234567 } }),
    );
    expect(priced.out).toContain("yokla's own model: 3 calls, 1 from the cache; costUsd 0.000123");
    const unpriced = terminalSummary(
      results([kase('a', 'pass')], { own: { calls: 1, cached: 0, costUsd: null } }),
    );
    expect(unpriced.out).toContain("yokla's own model: 1 call, 0 from the cache; costUsd unknown");
    expect(terminalSummary(results([kase('a', 'pass')])).out.join('\n')).not.toContain('own model');
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
    expect(out).toEqual(['1 cases: pass 1; pass rate 1.000 (1 of 1, 95 % 0.206 to 1.000)']);
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

  it('gives the facts the data no longer holds as the reason (ADR-0053)', () => {
    const stale = results([
      kase('hammock-en', 'fixture-missing', {
        samples: [],
        fixture: [
          'the catalog now holds hammock: 1 product, such as HMK-1',
          'the catalog holds no outdoor/x',
        ],
      }),
    ]);
    const reason =
      'fixture missing: the catalog now holds hammock: 1 product, such as HMK-1; the catalog holds no outdoor/x';
    expect(junitXml(stale)).toContain(`<error type="fixture-missing" message="${reason}"></error>`);
    expect(terminalSummary(stale).out.join('\n')).toContain(`hammock-en  ${reason}`);
    expect(htmlReport(stale)).toContain(reason);
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
    tools: ['search_products', 'add_to_cart'],
    toolCalls: [{ name: 'search_products', chars: 28, arguments: '{"q":"SECRET TOOL ARGUMENT"}' }],
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
                seen: { products: [{ tool: 'search_products', item: { id: 'p9', price: 329 } }] },
                proxy: { correlation: 'serial', calls: [call], costUsd: 0.001234567 },
                spans: {
                  calls: [
                    {
                      spanId: 'a1b2c3d4e5f60718',
                      provider: 'openai',
                      model: 'demo-writer-1',
                      durationMs: 7.39,
                      usage: {
                        input: 38,
                        output: 17,
                        cachedInput: null,
                        cacheWrite: null,
                        reasoning: null,
                      },
                      costUsd: 0.000072,
                      error: false,
                    },
                    {
                      spanId: '0f1e2d3c4b5a6978',
                      provider: null,
                      model: null,
                      durationMs: 1.5,
                      usage: {
                        input: null,
                        output: null,
                        cachedInput: null,
                        cacheWrite: null,
                        reasoning: null,
                      },
                      costUsd: null,
                      error: true,
                    },
                  ],
                  costUsd: null,
                },
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
            customer: {
              seed: 'hostile|1',
              ended: 'reached',
              reachedAt: 0,
              calls: [
                {
                  model: 'm',
                  durationMs: 5,
                  usage: { input: 10, output: 2 },
                  costUsd: 0.000014,
                  cached: false,
                },
                {
                  model: 'm',
                  durationMs: 0,
                  usage: { input: 10, output: 2 },
                  costUsd: 0,
                  cached: true,
                },
              ],
              costUsd: 0.000014,
            },
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
      own: { calls: 2, cached: 1, costUsd: 0.000014 },
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
      spans: {
        received: 3,
        attributed: 2,
        unattributed: 1,
        totals: { calls: 3, inputTokens: 38, outputTokens: 17, costUsd: 0.000072 },
        missing: { inputTokens: 1, outputTokens: 1, costUsd: 1 },
        settled: false,
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

  it("shows the run's spans and the calls of each turn's spans (ADR-0029)", () => {
    const page = htmlReport(rich);
    expect(page).toContain(
      '<dt>Spans</dt><dd>traceparent: 3 calls, 2 attributed, 1 unattributed, still coming when the wait ran out;',
    );
    expect(page).toContain(
      '<summary>Model calls from spans: 2 calls, no cost, traceparent</summary>',
    );
    expect(page).toContain(
      '<td><code>a1b2c3d4e5f60718</code></td><td>openai</td><td>demo-writer-1</td>',
    );
    expect(page).toContain('<td><code>0f1e2d3c4b5a6978</code></td><td>–</td><td>–</td>');
    expect(page).toMatch(/<td class="num">[^<]*<\/td><td>failed<\/td><\/tr>/u);
  });

  it("shows a model call's prompt by role and size only", () => {
    const page = htmlReport(rich);
    expect(page).toContain('<td>search_products</td><td>system 20, user 8</td>');
    expect(page).not.toContain('SECRET SYSTEM PROMPT');
    expect(page).not.toContain('SECRET TOOL ARGUMENT');
    expect(page).toContain('<summary>Seen by the model in tool results: products 1</summary>');
    expect(page).toContain(
      'Simulated customer, seed hostile|1: reached the goal after answer 1; 2 calls, 1 from the cache, $0.000014',
    );
    expect(page).toContain(
      '<dt>yokla&#39;s own model</dt><dd>2 calls, 1 from the cache; $0.000014</dd>',
    );
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

type Origin = NonNullable<TurnResult['checks'][number]['findings'][number]['origin']>;

function traced(origin: Origin): Results {
  return results([
    kase('tent-price', 'fail', {
      dimensions: [dimension('fabrication')],
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
                      verdict: 'fail',
                      severity: 'high',
                      message: '"1.169,10 TL" is not the price of any returned product',
                      subject: { kind: 'money', amount: 1169.1, currency: 'TRY' },
                      origin,
                    },
                  ],
                },
              ],
            }),
          ],
        },
      ],
    }),
  ]);
}

function line(origin: Origin): string {
  return terminalSummary(traced(origin)).out[1] ?? '';
}

describe('the origin of a finding (ADR-0033)', () => {
  it('says each stage in words, counting calls from 1', () => {
    expect(
      line({ stage: 'input', call: 1, role: 'tool', tool: 'search_products', match: 'money' }),
    ).toContain('; origin: what the model was sent (call 2, tool search_products)');
    expect(line({ stage: 'input', call: 0, role: 'system', match: 'number' })).toContain(
      '; origin: what the model was sent (call 1, system message, as a bare number)',
    );
    expect(line({ stage: 'model', call: 0, match: 'money' })).toContain(
      '; origin: the model (call 1)',
    );
    expect(line({ stage: 'app' })).toContain('; origin: the app');
    expect(line({ stage: 'app', reason: 'the turn made no model call' })).toContain(
      '; origin: the app (the turn made no model call)',
    );
    expect(line({ stage: 'unknown', reason: 'no model proxy data for this turn' })).toContain(
      '; origin: unknown (no model proxy data for this turn)',
    );
  });

  it('shows it in JUnit and in the HTML report, and nothing for a finding without one', () => {
    const run = traced({ stage: 'model', call: 0, match: 'money' });
    expect(junitXml(run)).toContain(
      'price-grounded (fabrication): "1.169,10 TL" is not the price of any returned product; origin: the model (call 1)',
    );
    expect(htmlReport(run)).toContain('origin: the model (call 1)');
    expect(junitXml(mixed)).not.toContain('origin:');
  });
});

describe('cases that stopped early (ADR-0038)', () => {
  const stopped = results(
    [
      { ...typeFail, samplesPlanned: 3 },
      kase('stroller', 'pass', {
        samples: [0, 1, 2].map((index) => ({ index, cache: 'cold' as const, turns: [turn()] })),
      }),
    ],
    { sampling: { stopEarly: true } },
  );

  it('says how many samples ran, and where a case stopped', () => {
    const { out } = terminalSummary(stopped);
    expect(out[1]).toBe('  --stop-early: 4 samples ran of 6 planned');
    expect(out[2]).toContain('presents 7 product(s) of other types [stopped after 1 of 3 samples]');
    expect(htmlReport(stopped)).toContain('[stopped after 1 of 3 samples]');
  });

  it('says nothing of it in a run without --stop-early', () => {
    expect(terminalSummary(mixed).out.join('\n')).not.toContain('stop');
  });
});

describe('transformed messages (ADR-0045)', () => {
  const transformed = results(
    [
      kase('stroller', 'pass', {
        samples: [
          {
            index: 0,
            cache: 'cold' as const,
            turns: [turn({ user: 'Cadir onerir misin?', written: 'Çadır önerir misin?' })],
          },
        ],
      }),
    ],
    {
      transforms: [
        { kind: 'no-diacritics', messages: 1 },
        { kind: 'typos', messages: 0 },
      ],
    },
  );

  it('names the transforms and how many messages each changed', () => {
    expect(terminalSummary(transformed).out).toContain(
      'transforms: no-diacritics (1 message), typos (0 messages)',
    );
    expect(htmlReport(transformed)).toContain('no-diacritics: 1 message; typos: 0 messages');
  });

  it('names the strategy and how many messages it rewrote (ADR-0084)', () => {
    const encoded = results([], { strategy: { name: 'base64+roleplay', messages: 2 } });
    expect(terminalSummary(encoded).out).toContain('strategy: base64+roleplay (2 messages)');
    expect(htmlReport(encoded)).toContain('base64+roleplay: 2 messages');
    expect(terminalSummary(transformed).out.join('\n')).not.toContain('strategy:');
  });

  it('names the attacker, its bound and the cases it adapted (ADR-0087)', () => {
    const escalated = results([], { attacker: { strategy: 'escalation', limit: 5, cases: 12 } });
    expect(terminalSummary(escalated).out).toContain(
      'attacker: escalation, at most 5 turns, 12 cases',
    );
    const sampled = results([], { attacker: { strategy: 'best-of-n', limit: 1, cases: 1 } });
    expect(terminalSummary(sampled).out).toContain('attacker: best-of-n, 1 attempt, 1 case');
    expect(terminalSummary(transformed).out.join('\n')).not.toContain('attacker:');
  });

  it('names the bounds of iterative, tree and translate (ADR-0088)', () => {
    expect(attackerSummary({ strategy: 'iterative', limit: 4, cases: 2 })).toContain(
      'attacker: iterative, 4 attempts, 2 cases',
    );
    expect(
      attackerSummary({ strategy: 'tree', limit: 12, branches: 3, depth: 2, cases: 2 }),
    ).toContain('attacker: tree, 3 branches to depth 2, at most 12 attempts, 2 cases');
    expect(
      attackerSummary({ strategy: 'tree', limit: 1, branches: 1, depth: 1, cases: 1 }),
    ).toContain('attacker: tree, 1 branch to depth 1, at most 1 attempt, 1 case');
    // Results without the tree's shape still name its bound.
    expect(attackerSummary({ strategy: 'tree', limit: 12, depth: 2, cases: 2 })).toContain(
      'attacker: tree, at most 12 attempts, 2 cases',
    );
    expect(attackerSummary({ strategy: 'tree', limit: 12, branches: 3, cases: 2 })).toContain(
      'attacker: tree, at most 12 attempts, 2 cases',
    );
    expect(attackerSummary({ strategy: 'translate', limit: 1, cases: 3 })).toContain(
      'attacker: translate, into 1 other language, 3 cases',
    );
    expect(attackerSummary({ strategy: 'translate', limit: 2, cases: 3 })).toContain(
      'attacker: translate, into 2 other languages, 3 cases',
    );
  });

  it('shows the message as the case wrote it under the one sent', () => {
    const page = htmlReport(transformed);
    const sent = page.indexOf('Cadir onerir misin?');
    const written = page.indexOf('Çadır önerir misin?');
    expect(sent).toBeGreaterThan(-1);
    expect(written).toBeGreaterThan(sent);
    expect(page).toContain('As the case wrote it');
  });

  it('says nothing of transforms in a run without them', () => {
    expect(terminalSummary(mixed).out.join('\n')).not.toContain('transforms');
    expect(htmlReport(mixed)).not.toContain('As the case wrote it');
  });
});

describe('weights and tags (ADR-0076, ADR-0077)', () => {
  const failed = (id: string, change: Partial<CaseResult>) =>
    kase(id, 'fail', {
      dimensions: [dimension('request')],
      samples: [
        {
          index: 0,
          cache: 'cold',
          turns: [turn({ checks: [failing('request-handled', 'request', 'showed cards')] })],
        },
      ],
      ...change,
    });
  const cases = [
    failed('thanks', { weight: 3, tags: ['chitchat'] }),
    kase('tents', 'pass', { weight: 50, tags: ['search', 'chitchat'] }),
    failed('jackets', { weight: 1200, tags: ['search'] }),
    kase('gift-wrap', 'known-gap', { weight: 9000, tags: ['search'] }),
  ];
  const heavy = results(cases);
  const plain = results(cases.map(({ weight: _weight, ...rest }) => rest));

  it('shows the weighted pass rate beside the plain one, and the failing cases heaviest first', () => {
    const { out } = terminalSummary(heavy);
    expect(out).toEqual([
      // 50 of 1253 by weight; the known gap is left out of both sums.
      '4 cases: pass 1, fail 2, known-gap 1; pass rate 0.333 (1 of 3, 95 % 0.061 to 0.792), weighted 0.040',
      '  fail       jackets    request 1/1: showed cards [weight 1200] [tags: search]',
      '  fail       thanks     request 1/1: showed cards [weight 3] [tags: chitchat]',
      // A known gap is no failure: it keeps its place after them.
      '  known-gap  gift-wrap  known gap: no reason given [weight 9000] [tags: search]',
      'by tag:',
      '  chitchat  2 cases: pass 1, fail 1; pass rate 0.500 (1 of 2, 95 % 0.095 to 0.905), weighted 0.943',
      '  search    3 cases: pass 1, fail 1, known-gap 1; pass rate 0.500 (1 of 2, 95 % 0.095 to 0.905), weighted 0.040',
    ]);
  });

  it('shows neither the weighted rate nor weights when every weight is 1', () => {
    const { out } = terminalSummary(plain);
    expect(out[0]).toBe(
      '4 cases: pass 1, fail 2, known-gap 1; pass rate 0.333 (1 of 3, 95 % 0.061 to 0.792)',
    );
    // As the results list them, with their tags.
    expect(out[1]).toBe('  fail       thanks     request 1/1: showed cards [tags: chitchat]');
    expect(out.join('\n')).not.toMatch(/weight/u);
  });

  it('says nothing by tag when no case has a tag', () => {
    const { out } = terminalSummary(results([kase('a', 'pass'), failed('b', {})]));
    expect(out.join('\n')).not.toMatch(/by tag|tags:/u);
    expect(htmlReport(results([kase('a', 'pass')]))).not.toMatch(/By tag|<th>Tags<\/th>/u);
  });

  it('has a By tag table, the most failing tag first, and each case its tags', () => {
    const page = htmlReport(plain);
    expect(page).toContain(
      '<tr><td><code>chitchat</code></td><td class="num">2</td><td>pass 1, fail 1</td><td class="num">0.500 (1 of 2)</td><td class="num">0.095 to 0.905</td></tr>',
    );
    expect(page.indexOf('<code>chitchat</code></td><td class="num">2')).toBeLessThan(
      page.indexOf('<code>search</code></td><td class="num">3'),
    );
    expect(page).toContain('<td>factual</td><td>tr</td><td>search, chitchat</td>');
    expect(page).not.toContain('Weighted pass rate');
  });

  it('lists the tag with the most failing cases first, before the name decides', () => {
    const page = htmlReport(
      results([
        kase('a', 'pass', { tags: ['alpha'] }),
        failed('b', { tags: ['zeta'] }),
        failed('c', { tags: ['zeta', 'beta'] }),
        failed('d', { tags: ['beta'] }),
        failed('e', { tags: ['gamma'] }),
      ]),
    );
    const order = [...page.matchAll(/<tr><td><code>([a-z]+)<\/code><\/td><td class="num">/gu)].map(
      (m) => m[1],
    );
    expect(order).toEqual(['beta', 'zeta', 'gamma', 'alpha']);
    const { out } = terminalSummary(
      results([kase('a', 'pass', { tags: ['alpha'] }), failed('b', { tags: ['zeta'] })]),
    );
    expect(out.slice(-2).map((row) => row.trim().split(' ')[0])).toEqual(['zeta', 'alpha']);
  });

  it('puts the heaviest failing case first in the HTML report, with both rates', () => {
    const page = htmlReport(heavy);
    expect(page).toContain(
      '<p>4 cases; pass rate 0.333 (1 of 3, 95 % 0.061 to 0.792), weighted 0.040</p>',
    );
    const order = [...page.matchAll(/<details class="case" id="case-([^"]+)"/gu)].map((m) => m[1]);
    expect(order).toEqual(['jackets', 'thanks', 'gift-wrap', 'tents']);
    expect(page).toContain('<th class="num">Weighted pass rate</th>');
    expect(page).toContain('<span class="mark">[weight 1200]</span>');
  });

  it('matches its snapshot with weights and tags', async () => {
    await expect(htmlReport(heavy)).toMatchFileSnapshot('./__snapshots__/report-weighted.html');
  });
});

/** A redteam case of these kinds, its one turn judged by these checks (ADR-0089). */
function attackCase(
  id: string,
  kinds: readonly string[],
  checks: TurnResult['checks'],
): CaseResult {
  const fails = checks.some((check) => check.findings.some((f) => f.verdict === 'fail'));
  return kase(id, fails ? 'fail' : 'pass', {
    suite: 'redteam',
    kinds: [...kinds],
    samples: [{ index: 0, cache: 'cold', turns: [turn({ checks })] }],
  });
}

const passing = (check: string): TurnResult['checks'][number] => ({
  check,
  applicable: true,
  findings: [{ dimension: 'd', verdict: 'pass', severity: 'high', message: 'ok' }],
});

/** Results of these cases with the mapping and the risk a run writes (ADR-0089). */
function mappedResults(cases: CaseResult[]): Results {
  const base = results(cases);
  const taxonomy = runTaxonomy(CORE_TAXONOMY, cases);
  const risk = kindRisks(cases, CORE_TAXONOMY.kinds);
  return {
    ...base,
    summary: { ...base.summary, ...(risk.length === 0 ? {} : { risk }) },
    ...(taxonomy === undefined ? {} : { taxonomy }),
  };
}

describe('the frameworks and the risk in the reports (ADR-0089)', () => {
  const mappedRun = mappedResults([
    attackCase('inj', ['injection'], [failing('answer-text', 'd', 'canary')]),
    attackCase('card', ['card'], [failing('card-number', 'd', 'card'), passing('pii-leak')]),
    attackCase('safe', ['internals'], [passing('internals-leak')]),
  ]);

  it('names, per framework, each category a failing finding names, and each kind that scored', () => {
    const out = terminalSummary(mappedRun).out;
    const at = out.indexOf('frameworks, mapped by yokla, not a compliance assessment:');
    expect(at).toBeGreaterThan(-1);
    expect(out.slice(at)).toEqual([
      'frameworks, mapped by yokla, not a compliance assessment:',
      '  OWASP Top 10 for LLM Applications 2025: LLM01 Prompt Injection (1 case), LLM02 Sensitive Information Disclosure (1 case)',
      '  OWASP Top 10 for Agentic Applications 2026: ASI01 Agent Goal Hijack (1 case)',
      '  MITRE ATLAS 2026.07: AML.TA0005 Execution (1 case), AML.TA0010 Exfiltration (1 case)',
      '  NIST AI RMF 1.0: MEASURE 2.7 Security and resilience (1 case), MEASURE 2.10 Privacy (1 case)',
      '  ISO/IEC 42001 2023: A.6.2.4 AI system verification and validation (2 cases)',
      '  GDPR Regulation (EU) 2016/679: Article 32 Security of processing (1 case)',
      '  KVKK Law No. 6698: Article 12 Obligations on data security (1 case)',
      '  EU AI Act Regulation (EU) 2024/1689: Article 15 Accuracy, robustness and cybersecurity (1 case)',
      'risk by attack kind, from 0 to 10:',
      `  card (critical): 10 of 10, 95 % ${String(mappedRun.summary.risk?.[0]?.scoreInterval?.lower)} to 10; 1 of 1 trial succeeded`,
      `  injection (high): 7.5 of 10, 95 % ${String(mappedRun.summary.risk?.[1]?.scoreInterval?.lower)} to 7.5; 1 of 1 trial succeeded`,
    ]);
  });

  it('says nothing of the frameworks when no finding failed', () => {
    const quiet = mappedResults([attackCase('safe', ['internals'], [passing('internals-leak')])]);
    expect(quiet.taxonomy).toBeDefined();
    expect(terminalSummary(quiet).out.join('\n')).not.toContain('frameworks');
    expect(terminalSummary(results([kase('a', 'pass')])).out.join('\n')).not.toContain('risk');
  });

  it("shows each framework with its categories, and every kind's risk, in the HTML report", () => {
    const page = htmlReport(mappedRun);
    expect(page).toContain('<section id="frameworks"><h2>Frameworks</h2>');
    expect(page).toContain('The categories are mapped by yokla, not a compliance assessment.');
    expect(page).toContain('<h3>OWASP Top 10 for LLM Applications 2025</h3>');
    expect(page).toContain(
      '<tr><td><code>LLM02</code></td><td>Sensitive Information Disclosure</td><td class="num">1</td><td>card</td></tr>',
    );
    // A category the run tested and no finding failed shows no case.
    expect(page).toContain(
      '<tr><td><code>LLM07</code></td><td>System Prompt Leakage</td><td class="num">0</td><td></td></tr>',
    );
    expect(page).toContain('<h3>Risk by attack kind</h3>');
    expect(page).toContain(
      '<tr><td><code>internals</code></td><td>low</td><td class="num">0 of 1</td>',
    );
    expect(page).toContain('0 of 10, 95 % 0 to');
    expect(htmlReport(results([kase('a', 'pass')]))).not.toContain('id="frameworks"');
  });

  it('names only the frameworks a failing finding names, and the risk only of kinds that scored', () => {
    // The injection passed: its frameworks are in the mapping, with no failing category.
    const cardOnly = mappedResults([
      attackCase('card', ['card'], [failing('card-number', 'd', 'card')]),
      attackCase('inj', ['injection'], [passing('injection-canary')]),
    ]);
    expect(cardOnly.taxonomy?.frameworks.map((framework) => framework.id)).toContain(
      'owasp-agentic',
    );
    const lines = terminalSummary(cardOnly).out.join('\n');
    expect(lines).toContain('OWASP Top 10 for LLM Applications 2025: LLM02');
    expect(lines).not.toContain('Agentic');
    expect(lines).not.toContain('EU AI Act');
    // A mapped check failing a case of no kind names its categories, and scores no kind.
    const claim = mappedResults([
      kase('price', 'fail', {
        samples: [
          {
            index: 0,
            cache: 'cold',
            turns: [turn({ checks: [failing('pii-leak', 'd', 'leak')] })],
          },
        ],
      }),
    ]);
    const out = terminalSummary(claim).out;
    expect(out).toContain(
      '  OWASP Top 10 for LLM Applications 2025: LLM02 Sensitive Information Disclosure (1 case)',
    );
    expect(out.join('\n')).not.toContain('risk by attack kind');
    expect(htmlReport(claim)).not.toContain('Risk by attack kind');
  });

  it('shows a kind without a judged trial as unmeasured', () => {
    const unjudged = mappedResults([
      attackCase('a', ['card'], [{ check: 'card-number', applicable: false, findings: [] }]),
      attackCase('b', ['injection'], [failing('answer-text', 'd', 'canary')]),
    ]);
    const page = htmlReport(unjudged);
    expect(page).toContain(
      '<tr><td><code>card</code></td><td>critical</td><td class="num">0 of 0</td><td class="num">unmeasured</td><td class="num">unmeasured</td></tr>',
    );
    expect(terminalSummary(unjudged).out.join('\n')).not.toContain('card (critical)');
  });
});

/** A judge check with this many verdicts, and a gap for each reason (ADR-0099). */
function judgeCheck(verdicts: number, gaps: readonly string[]): TurnResult['checks'][number] {
  return {
    check: 'judge',
    applicable: true,
    findings: Array.from({ length: verdicts }, () => ({
      dimension: 'bias',
      verdict: 'pass' as const,
      severity: 'high' as const,
      message: 'x',
    })),
    ...(gaps.length === 0
      ? {}
      : { unmeasured: gaps.map((reason) => ({ dimension: 'bias', reason })) }),
  };
}

/** A run judged on bias, a case per turn with these checks. */
function judged(checks: TurnResult['checks'][]): Results {
  return results(
    checks.map((turnChecks, index) =>
      kase(`c${String(index)}`, 'pass', {
        samples: [{ index: 0, cache: 'cold', turns: [turn({ checks: turnChecks })] }],
      }),
    ),
    {
      judge: {
        model: 'judge-1',
        dimensions: ['bias'],
        gated: [],
        calibration: { items: 4, misjudged: [] },
      },
    },
  );
}

describe('the judge in the summary (ADR-0090)', () => {
  it('names the model, each dimension as gating or advisory, and the calibration', () => {
    const summary = (judge: NonNullable<Results['run']['judge']>) =>
      terminalSummary(results([], { judge })).out;
    expect(
      summary({
        model: 'judge-1',
        dimensions: ['unsafe-advice'],
        gated: [],
        calibration: { items: 4, misjudged: [] },
      }),
    ).toContain('judge: judge-1, unsafe-advice (advisory); 4 of 4 calibration items judged right');
    expect(
      summary({
        model: 'judge-1',
        dimensions: ['unsafe-advice'],
        gated: ['unsafe-advice'],
        calibration: {
          items: 1,
          misjudged: [
            {
              dimension: 'unsafe-advice',
              language: 'en',
              user: 'u',
              expected: 'fail',
              got: 'pass',
            },
          ],
        },
        unmeasured: 'the judge misjudged 1 of 1 calibration item',
      }),
    ).toContain(
      'judge: judge-1, unsafe-advice (gating); unmeasured: the judge misjudged 1 of 1 calibration item',
    );
    expect(
      summary({
        dimensions: ['unsafe-advice'],
        gated: [],
        calibration: { items: 0, misjudged: [] },
        unmeasured: 'no judge model',
      }),
    ).toContain('judge: none, unsafe-advice (advisory); unmeasured: no judge model');
    expect(terminalSummary(results([])).out.join('\n')).not.toContain('judge:');
  });

  it("counts the judged turns' verdicts left unmeasured, by reason, when there are any (ADR-0099)", () => {
    const CUT = "the judge's reply stopped at maxTokens (400): raise models.judge.maxTokens";
    const run = judged([
      [judgeCheck(2, [])],
      [judgeCheck(0, [CUT, CUT])],
      [failing('answer', 'not-empty', 'empty'), judgeCheck(1, ['the cost cap stopped the judge'])],
    ]);
    const lines = terminalSummary(run).out;
    const at = lines.indexOf('  3 of 6 verdicts unmeasured:');
    expect(lines[at - 1]).toBe(
      'judge: judge-1, bias (advisory); 4 of 4 calibration items judged right',
    );
    expect(lines.slice(at + 1, at + 3)).toEqual([
      `    ${CUT} (2 verdicts)`,
      '    the cost cap stopped the judge (1 verdict)',
    ]);
    // The Markdown summary says the same, from the same parts (ADR-0094).
    expect(markdownReport(run)).toContain(`  3 of 6 verdicts unmeasured:\n    ${CUT} (2 verdicts)`);
    // Every verdict read: no line.
    expect(terminalSummary(judged([[judgeCheck(2, [])]])).out.join('\n')).not.toContain(
      'unmeasured',
    );
    // A run-wide reason already says why every verdict is unmeasured.
    const discarded = judged([[judgeCheck(0, ['the judge misjudged 1 of 4 calibration items'])]]);
    discarded.run.judge = {
      model: 'judge-1',
      dimensions: ['bias'],
      gated: [],
      calibration: { items: 4, misjudged: [] },
      unmeasured: 'the judge misjudged 1 of 4 calibration items',
    };
    expect(terminalSummary(discarded).out.join('\n')).not.toContain('verdict unmeasured');
    expect(terminalSummary(discarded).out.join('\n')).not.toContain('verdicts unmeasured');
  });
});

describe('the Markdown summary (ADR-0094)', () => {
  const proposed = kase('draft', 'fail', {
    review: 'proposed',
    tags: ['search'],
    dimensions: [dimension('request')],
    samples: [
      {
        index: 0,
        cache: 'cold',
        turns: [turn({ checks: [failing('request-handled', 'request', 'showed | cards\nagain')] })],
      },
    ],
  });
  const run = results([...mixed.cases, proposed], { issues: ['logs unreadable'] });
  const broken = {
    verdict: 'broken' as const,
    breaches: [
      {
        rule: 'failures' as const,
        suite: 'factual',
        cases: ['high-chair'],
        message: 'factual: 1 failing case, more than 0',
      },
    ],
    problems: [],
    notices: ['compared with the baseline'],
  };

  it('says what the terminal summary says, as Markdown', async () => {
    await expect(markdownReport(run)).toMatchFileSnapshot('./__snapshots__/summary.md');
  });

  it('opens with the gate’s verdict, and lists its breaches, problems and notices', async () => {
    await expect(markdownReport(run, broken)).toMatchFileSnapshot(
      './__snapshots__/summary-gate.md',
    );
    const passed = markdownReport(run, {
      verdict: 'pass',
      breaches: [],
      problems: [],
      notices: [],
    });
    expect(passed.split('\n')[0]).toBe('### yokla: the gate passed');
    expect(passed).not.toContain('**The gate**');
    const unjudgeable = markdownReport(run, {
      verdict: 'unjudgeable',
      breaches: [],
      problems: ['a case is in error'],
      notices: [],
    });
    expect(unjudgeable.split('\n')[0]).toBe("### yokla: the gate can't judge the run");
    expect(unjudgeable).toContain("**The gate**\n\n- can't judge: a case is in error\n");
  });

  it('holds no answer, and keeps each row on one line, its pipes escaped', () => {
    const text = markdownReport(run, broken);
    expect(text).not.toContain(ANSWER);
    expect(text).toContain(
      '| fail | `draft` | request 1/1: showed \\| cards again [proposed] [tags: search] |',
    );
  });

  it('escapes a backslash in a cell, and keeps a list item on one line', () => {
    const slashed = kase('slash', 'fail', {
      dimensions: [dimension('request')],
      samples: [
        {
          index: 0,
          cache: 'cold',
          turns: [turn({ checks: [failing('request-handled', 'request', 'a \\| b')] })],
        },
      ],
    });
    const text = markdownReport(results([slashed]), {
      ...broken,
      breaches: broken.breaches.map((breach) => ({ ...breach, message: 'two\n  lines' })),
    });
    expect(text).toContain('| fail | `slash` | request 1/1: a \\\\\\| b |');
    expect(text).toContain('\n- two lines\n');
  });

  it('shows the first cases in its table, and says how many more there are', () => {
    const many = Array.from({ length: MARKDOWN_ROWS + 1 }, (_, index) =>
      kase(`case-${String(index).padStart(3, '0')}`, 'unmeasured'),
    );
    const text = markdownReport(results(many));
    const rows = text.split('\n').filter((row) => row.startsWith('| unmeasured |'));
    expect(rows).toHaveLength(MARKDOWN_ROWS);
    expect(rows.at(-1)).toContain('`case-099`');
    expect(text).toContain('\nAnd 1 more, which the HTML report lists.\n');
    const exactly = markdownReport(results(many.slice(0, MARKDOWN_ROWS)));
    expect(exactly).not.toContain('more, which');
  });

  it('leaves out what a run doesn’t have', () => {
    const text = markdownReport(results([kase('stroller', 'pass')]));
    expect(text).toBe(
      '### yokla\n\nRun `run-1` against `t`.\n\n- 1 cases: pass 1; pass rate 1.000 (1 of 1, 95 % 0.206 to 1.000)\n',
    );
  });
});
