import { Results, RESULTS_SCHEMA_ID, type Case } from '@yokla/core';
import { describe, expect, it } from 'vitest';
import {
  CASE_ROW_SCHEMA_ID,
  CaseRow,
  caseRows,
  RESULT_ROW_SCHEMA_ID,
  ResultRow,
  resultRows,
  turnVerdict,
} from './index.ts';

function kase(id: string, change: Partial<Case> = {}): Case {
  return {
    id,
    suite: 'quality',
    language: 'tr',
    tags: [],
    turns: [{ user: 'merhaba', expect: { answer: { contains: ['merhaba'] } } }],
    ...change,
  };
}

/** A case's provenance with this review status. */
function provenance(status: 'proposed' | 'rejected'): Partial<Case> {
  return { provenance: { source: 'generator', evidence: 'from the data', status } };
}

describe('case rows (ADR-0096)', () => {
  it('writes an approved case: its labels, its first message, and each turn with its expectations', () => {
    const { rows, skipped } = caseRows([
      kase('greet', {
        tags: ['chitchat'],
        turns: [
          { user: 'merhaba', expect: { answer: { contains: ['merhaba'] } } },
          { user: 've sonra?' },
        ],
      }),
    ]);
    expect(skipped).toEqual([]);
    expect(rows).toEqual([
      {
        schema: CASE_ROW_SCHEMA_ID,
        id: 'greet',
        suite: 'quality',
        language: 'tr',
        tags: ['chitchat'],
        message: 'merhaba',
        turns: [
          { message: 'merhaba', expect: { answer: { contains: ['merhaba'] } } },
          { message: 've sonra?', expect: {} },
        ],
      },
    ]);
    expect(CaseRow.safeParse(rows[0]).success).toBe(true);
  });

  it('names each case it leaves out, with why, and keeps the order of the rest', () => {
    const { rows, skipped } = caseRows([
      kase('a'),
      kase('draft', provenance('proposed')),
      kase('dropped', provenance('rejected')),
      kase('chat', {
        turns: [],
        customer: {
          persona: 'a camper',
          goal: 'buy a tent',
          maxTurns: 3,
          reached: { route: 'cart' },
        },
      }),
      kase('b'),
    ]);
    expect(rows.map((row) => row.id)).toEqual(['a', 'b']);
    expect(skipped).toEqual([
      { id: 'draft', reason: 'proposed: only approved cases are written' },
      { id: 'dropped', reason: 'rejected: only approved cases are written' },
      { id: 'chat', reason: 'a simulated customer has no written turns' },
    ]);
  });
});

type CaseResult = Results['cases'][number];
type Turn = CaseResult['samples'][number]['turns'][number];

function finding(check: string, dimension: string, verdict: 'pass' | 'fail', message = check) {
  return {
    check,
    applicable: true,
    findings: [{ dimension, verdict, severity: 'high' as const, message }],
  };
}

function turn(change: Partial<Turn> = {}): Turn {
  return {
    user: 'merhaba',
    response: { status: 200, latencyMs: 120, text: 'Merhaba!', evidence: {} },
    checks: [finding('answer-text', 'answer-content', 'pass')],
    ...change,
  };
}

function run(cases: CaseResult[]): Results {
  return Results.parse({
    schema: RESULTS_SCHEMA_ID,
    yokla: { version: '0.0.0-test' },
    run: {
      id: 'run-1',
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

function result(
  id: string,
  samples: readonly (readonly Turn[])[],
  change: Partial<CaseResult> = {},
) {
  return {
    id,
    suite: 'quality' as const,
    language: 'tr',
    status: 'pass' as const,
    unstable: false,
    dimensions: [],
    samples: samples.map((turns, index) => ({ index, cache: 'cold' as const, turns: [...turns] })),
    ...change,
  };
}

describe('result rows (ADR-0096)', () => {
  it('writes a row per turn of each sample, with what was sent, the answer and its findings', () => {
    const rows = resultRows(
      run([
        result(
          'greet',
          [
            [turn(), turn({ user: 've?', response: undefined, checks: [], error: 'HTTP 500' })],
            [turn({ proxy: { correlation: 'serial', calls: [], costUsd: 0.002 } })],
          ],
          { tags: ['chitchat'], status: 'error' },
        ),
      ]),
    );
    expect(rows).toEqual([
      {
        schema: RESULT_ROW_SCHEMA_ID,
        run: 'run-1',
        case: 'greet',
        suite: 'quality',
        language: 'tr',
        tags: ['chitchat'],
        sample: 0,
        turn: 0,
        message: 'merhaba',
        answer: 'Merhaba!',
        latencyMs: 120,
        costUsd: null,
        verdict: 'pass',
        status: 'error',
        findings: [
          {
            check: 'answer-text',
            dimension: 'answer-content',
            verdict: 'pass',
            severity: 'high',
            message: 'answer-text',
          },
        ],
      },
      {
        schema: RESULT_ROW_SCHEMA_ID,
        run: 'run-1',
        case: 'greet',
        suite: 'quality',
        language: 'tr',
        tags: ['chitchat'],
        sample: 0,
        turn: 1,
        message: 've?',
        answer: null,
        latencyMs: null,
        costUsd: null,
        verdict: 'unmeasured',
        status: 'error',
        findings: [],
        error: 'HTTP 500',
      },
      expect.objectContaining({ sample: 1, turn: 0, costUsd: 0.002 }),
    ]);
    for (const row of rows) expect(ResultRow.safeParse(row).success).toBe(true);
  });

  it('reads a turn’s cost from its spans without a proxy, and a case without tags as none', () => {
    const [row] = resultRows(
      run([result('a', [[turn({ spans: { calls: [], costUsd: 0.003 } })]])]),
    );
    expect(row).toMatchObject({ costUsd: 0.003, tags: [] });
  });

  it('gives a turn the verdict a sample of it would get, by the case’s policies', () => {
    const policies = { tone: 'advisory' } as const;
    const failed = turn({ checks: [finding('answer-text', 'answer-content', 'fail')] });
    expect(turnVerdict(failed, policies)).toBe('fail');
    expect(turnVerdict(turn(), policies)).toBe('pass');
    expect(turnVerdict(turn({ checks: [] }), policies)).toBe('unmeasured');
    // An advisory finding never fails a turn; alone, it leaves it unmeasured.
    const advisory = finding('tone-check', 'tone', 'fail');
    expect(turnVerdict(turn({ checks: [advisory] }), policies)).toBe('unmeasured');
    expect(
      turnVerdict(
        turn({ checks: [finding('answer-text', 'answer-content', 'pass'), advisory] }),
        policies,
      ),
    ).toBe('pass');
    expect(turnVerdict(turn({ error: 'HTTP 500' }), policies)).toBe('unmeasured');
  });

  it('reads the policies the run recorded, and leaves a threshold’s to the run', () => {
    const advisoryOnly = result(
      'a',
      [[turn({ checks: [finding('tone-check', 'tone', 'fail')] })]],
      {
        dimensions: [
          { dimension: 'tone', policy: 'advisory', verdict: 'fail', samples: 1, failed: 1 },
          { dimension: 'latency', policy: 'percentile', verdict: 'pass', samples: 1, failed: 0 },
        ],
      },
    );
    const gating = result('b', [[turn({ checks: [finding('tone-check', 'tone', 'fail')] })]]);
    const rows = resultRows(run([advisoryOnly, gating]));
    expect(rows.map((row) => [row.case, row.verdict])).toEqual([
      ['a', 'unmeasured'],
      ['b', 'fail'],
    ]);
  });
});
