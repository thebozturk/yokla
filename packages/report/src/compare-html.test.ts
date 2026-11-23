import { compareRuns, evaluateGate, Results, RESULTS_SCHEMA_ID } from '@yokla/core';
import { describe, expect, it } from 'vitest';
import { comparisonHtml } from './compare-html.ts';
import { CONTENT_SECURITY_POLICY } from './html.ts';

type CaseResult = Results['cases'][number];
type Turn = CaseResult['samples'][number]['turns'][number];

/** A turn with this answer, failing these checks: [check, dimension, message]. */
function turn(
  user: string,
  text: string,
  failing: readonly (readonly [string, string, string])[] = [],
): Turn {
  return {
    user,
    response: { status: 200, latencyMs: 100, text, evidence: {} },
    checks: failing.map(([check, dimension, message]) => ({
      check,
      applicable: true,
      findings: [{ dimension, verdict: 'fail', severity: 'high', message }],
    })),
  };
}

function kase(
  id: string,
  status: CaseResult['status'],
  samples: readonly (readonly Turn[])[],
  definition = 'd',
): CaseResult {
  return {
    id,
    suite: 'factual',
    language: 'tr',
    status,
    unstable: false,
    definitionSha256: definition.repeat(64).slice(0, 64),
    dimensions: [],
    samples: samples.map((turns, index) => ({ index, cache: 'cold', turns: [...turns] })),
  };
}

function run(id: string, cases: CaseResult[]): Results {
  return Results.parse({
    schema: RESULTS_SCHEMA_ID,
    yokla: { version: '0.0.0-test' },
    run: {
      id,
      startedAt: '2026-11-23T12:00:00.000Z',
      finishedAt: '2026-11-23T12:00:01.000Z',
      durationMs: 1000,
      profile: { target: 't', sha256: 'a'.repeat(64) },
      environment: { node: 'v24.0.0', platform: 'darwin', arch: 'arm64' },
      correlation: 'serial',
      partial: false,
    },
    cases,
    checks: [],
    summary: { cases: cases.length, statuses: {} },
  });
}

const page = (...runs: Results[]) =>
  comparisonHtml(
    compareRuns(runs.map((results) => ({ results, gate: evaluateGate(results) }))),
    runs,
  );

const FABRICATED: readonly [string, string, string] = [
  'price-grounded',
  'fabrication',
  '"9 TL" is not a price',
];

const STOCK: readonly [string, string, string] = ['stock-claim', 'availability', 'no stock data'];

/** A turn whose one check passes, with this message. */
function passed(user: string, text: string, message: string): Turn {
  return {
    ...turn(user, text),
    checks: [
      {
        check: 'policy-claim',
        applicable: true,
        findings: [{ dimension: 'policy', verdict: 'pass', severity: 'high', message }],
      },
    ],
  };
}

const before = run('before', [
  kase('tents', 'pass', [[turn('Çadır?', 'Kubbe çadır 100 TL')]]),
  kase('inside', 'fail', [[turn('Stok?', 'Var', [STOCK])]]),
  kase('stable', 'fail', [[turn('Fiyat?', '9 TL', [FABRICATED])]]),
  kase('same', 'pass', [[turn('Merhaba', 'Merhaba!')]]),
  kase('moved', 'pass', [[turn('a', 'old')]]),
]);
const after = run('after', [
  kase('tents', 'fail', [
    [turn('Çadır?', 'Kubbe çadır 100 TL')],
    [turn('Çadır?', 'Kubbe çadır <b>9 TL</b>', [FABRICATED])],
  ]),
  kase('same', 'pass', [[passed('Merhaba', 'Merhaba!', 'a passing finding')]]),
  kase('moved', 'pass', [[turn('a', 'new')]], 'e'),
  kase('inside', 'fail', [[turn('Stok?', 'Var', [FABRICATED])]]),
  kase('stable', 'fail', [[turn('Fiyat?', '9 TL', [FABRICATED])]]),
]);

describe('the comparison page (ADR-0095)', () => {
  const html = page(before, after);

  it('is one static page, under the HTML report’s rules', () => {
    expect(html).toMatch(/^<!doctype html>\n/u);
    expect(html).toContain(`content="${CONTENT_SECURITY_POLICY}"`);
    expect(html).not.toMatch(/<script|<link|src=|https?:/u);
    expect(html).toContain("This page holds the target's answers.");
  });

  it('opens the cases that changed, first, and leaves the others closed', () => {
    expect(html).toContain('<details class="case" id="case-tents" open>');
    expect(html).toContain('<details class="case" id="case-moved" open>');
    // Its status held, its findings didn't.
    expect(html).toContain('<details class="case" id="case-inside" open>');
    expect(html).toContain('<details class="case" id="case-stable">');
    expect(html).toContain('<details class="case" id="case-same">');
    expect(html.indexOf('id="case-tents"')).toBeLessThan(html.indexOf('id="case-same"'));
  });

  it('marks what a later run gained, and shows each run’s answer, escaped, side by side', () => {
    expect(html).toContain('B: 1 new, 0 gone');
    expect(html).toContain('failed in 1 <span class="new">new</span>');
    expect(html).toContain('<span class="muted">&quot;9 TL&quot; is not a price</span>');
    // B's failing sample is shown: its second.
    expect(html).toContain('<h4>B, sample 1</h4>');
    expect(html).toContain('<pre class="text">Kubbe çadır &lt;b&gt;9 TL&lt;/b&gt;</pre>');
    expect(html).toContain('<pre class="text">Kubbe çadır 100 TL</pre>');
    expect(html).toContain('price-grounded (fabrication): &quot;9 TL&quot; is not a price');
    expect(html).toContain('B: 1 new, 1 gone');
  });

  it('says nothing of a run that changed nothing, and lists only failing findings', () => {
    expect(html).not.toContain('B: 0 new, 0 gone');
    expect(html).not.toContain('a passing finding');
  });

  it('marks what a later run lost, reversed', () => {
    const reversed = page(after, before);
    expect(reversed).toContain('B: 0 new, 1 gone');
    expect(reversed).toContain('<span class="gone">gone</span>');
  });

  it('says why a case whose definition differs isn’t compared', () => {
    expect(html).toContain('definition differs: not compared');
    expect(html).toContain("The case's definition differs between the runs");
  });

  it('shows a turn one run lacks, and a case one run lacks', () => {
    const longer = run('longer', [
      kase('same', 'pass', [[turn('Merhaba', 'Merhaba!'), turn('Ve?', 'Ve.')]]),
    ]);
    const shorter = run('shorter', [
      kase('same', 'pass', [[turn('Merhaba', 'Merhaba!')]]),
      kase('only', 'pass', [[turn('x', 'y')]]),
    ]);
    const text = page(longer, shorter);
    expect(text).toContain('No such turn in this run.');
    expect(text).toContain('<span class="muted">missing</span>');
  });

  it('shows each run’s message when a transform changed it', () => {
    const plain = run('plain', [kase('same', 'pass', [[turn('Çadır?', 'Evet')]])]);
    const folded = run('folded', [kase('same', 'pass', [[turn('Cadir?', 'Evet')]])]);
    const text = page(plain, folded);
    expect(text).toContain('<pre class="text">Çadır?</pre>');
    expect(text).toContain('<pre class="text">Cadir?</pre>');
  });
});
