import { describe, expect, it } from 'vitest';
import { Results, RESULTS_SCHEMA_ID } from './results.ts';

const minimal = {
  schema: RESULTS_SCHEMA_ID,
  yokla: { version: '0.1.0' },
  run: {
    id: 'run-1',
    startedAt: '2026-11-09T10:00:00.000Z',
    finishedAt: '2026-11-09T10:00:05.000Z',
    durationMs: 5000,
    profile: { target: 'demo-shop', sha256: 'a'.repeat(64) },
    environment: { node: 'v26.5.0', platform: 'darwin', arch: 'arm64' },
    correlation: 'none',
    partial: false,
  },
  cases: [
    {
      id: 'tents-tr',
      suite: 'factual',
      language: 'tr',
      status: 'fail',
      unstable: false,
      dimensions: [
        { dimension: 'fabrication', policy: 'worst-of-n', verdict: 'fail', samples: 1, failed: 1 },
      ],
      samples: [
        {
          index: 0,
          cache: 'cold',
          turns: [
            {
              user: 'Çadır önerir misin?',
              response: {
                status: 200,
                latencyMs: 12,
                text: '…',
                evidence: { products: [{ id: 'TNT-004' }] },
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
                      message: '809,55 TL matches no returned product',
                      evidence: { amount: 809.55 },
                    },
                  ],
                },
                { check: 'stock-claim', applicable: false, findings: [] },
              ],
            },
          ],
        },
      ],
    },
  ],
  checks: [
    { check: 'price-grounded', applied: 1, notApplicable: 0, passed: 0, failed: 1, errors: 0 },
  ],
  summary: { cases: 1, statuses: { fail: 1 } },
};

describe('results.v1', () => {
  it('accepts a valid results file', () => {
    expect(Results.safeParse(minimal).success).toBe(true);
  });

  it('accepts fields added later within v1', () => {
    const later = {
      ...minimal,
      costs: { totalUsd: 0.01 },
      run: { ...minimal.run, budget: { cap: 1 } },
    };
    expect(Results.safeParse(later).success).toBe(true);
  });

  it.each([
    ['another major version', { ...minimal, schema: 'yokla.results/v2' }],
    ['an unknown case status', { ...minimal, cases: [{ ...minimal.cases[0], status: 'flaky' }] }],
    [
      'a malformed profile hash',
      { ...minimal, run: { ...minimal.run, profile: { target: 'x', sha256: 'abc' } } },
    ],
    ['a missing summary', { ...minimal, summary: undefined }],
  ])('rejects %s', (_name, input) => {
    expect(Results.safeParse(input).success).toBe(false);
  });
});
