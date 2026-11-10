import { describe, expect, it } from 'vitest';
import { Results, RESULTS_SCHEMA_ID } from '../schema/results.ts';
import { plan } from './plan.ts';

type CaseResult = Results['cases'][number];
const sha = (char: string) => char.repeat(64);

/** A calibrated case: per sample, the costs of its answered turns. */
function calibrated(id: string, definition: string, samples: (number | null)[][]): CaseResult {
  return {
    id,
    suite: 'perf',
    language: 'tr',
    definitionSha256: definition,
    status: 'pass',
    unstable: false,
    dimensions: [],
    samples: samples.map((costs, index) => ({
      index,
      cache: 'cold' as const,
      turns: costs.map((costUsd) => ({
        user: 'u',
        checks: [],
        response: { status: 200, latencyMs: 10, evidence: {} },
        proxy: { correlation: 'serial' as const, calls: [], costUsd },
      })),
    })),
  };
}

function calibration(cases: CaseResult[], proxy = true): Results {
  return Results.parse({
    schema: RESULTS_SCHEMA_ID,
    yokla: { version: '0.1.0' },
    run: {
      id: 'cal',
      startedAt: '2026-11-10T12:00:00.000Z',
      finishedAt: '2026-11-10T12:00:01.000Z',
      durationMs: 1000,
      profile: { target: 't', sha256: sha('a') },
      environment: { node: 'v24.0.0', platform: 'darwin', arch: 'arm64' },
      correlation: proxy ? 'serial' : 'none',
      partial: false,
      ...(proxy
        ? {
            proxy: {
              correlation: 'serial',
              records: 0,
              attributed: 0,
              unattributed: 0,
              totals: {},
              missing: {},
            },
          }
        : {}),
    },
    cases,
    checks: [],
    summary: { cases: cases.length, statuses: {} },
  });
}

describe('plan', () => {
  const cal = calibration([
    calibrated('tents', sha('1'), [[0.002, 0.004], [0.003]]),
    calibrated('stoves', sha('2'), [[0.001]]),
  ]);

  it('prices a case from its own calibration, and the others at the mean turn', () => {
    const estimate = plan(
      [
        { id: 'tents', definitionSha256: sha('1'), turns: 2, samples: 3 },
        { id: 'stoves', definitionSha256: sha('9'), turns: 1, samples: 1 },
        { id: 'new-case', definitionSha256: sha('3'), turns: 1, samples: 2 },
      ],
      cal,
      2,
    );
    // tents: 0.003 a turn × 6 turns; the mean turn is 0.0025 for the other 3 turns.
    expect(estimate).toEqual({
      ok: true,
      turns: 9,
      cases: 3,
      ownCalibration: 1,
      meanTurnUsd: expect.closeTo(0.0025, 12) as unknown,
      estimateUsd: expect.closeTo(0.018 + 0.0075, 12) as unknown,
      upperUsd: expect.closeTo(0.051, 12) as unknown,
      factor: 2,
    });
  });

  it('leaves turns that got no answer out of the calibration', () => {
    const withError = calibrated('tents', sha('1'), [[0.002]]);
    const sample = withError.samples[0];
    const unanswered: CaseResult = {
      ...withError,
      samples:
        sample === undefined
          ? []
          : [{ ...sample, turns: [...sample.turns, { user: 'u', checks: [], error: 'HTTP 500' }] }],
    };
    expect(
      plan(
        [{ id: 'tents', definitionSha256: sha('1'), turns: 1, samples: 1 }],
        calibration([unanswered]),
        2,
      ),
    ).toMatchObject({ ok: true, meanTurnUsd: 0.002, estimateUsd: 0.002 });
  });

  it('refuses to guess: no proxy data, no answered turn, or calibrated turns without a cost', () => {
    const cases = [{ id: 'tents', definitionSha256: sha('1'), turns: 1, samples: 1 }];
    expect(plan(cases, calibration([calibrated('tents', sha('1'), [[0.001]])], false), 2)).toEqual({
      ok: false,
      problem: 'the calibration run has no model proxy data: run it with a model proxy',
    });
    expect(plan(cases, calibration([calibrated('tents', sha('1'), [[]])]), 2)).toEqual({
      ok: false,
      problem: 'the calibration run has no answered turn',
    });
    expect(
      plan(cases, calibration([calibrated('tents', sha('1'), [[0.001, null, null]])]), 2),
    ).toEqual({
      ok: false,
      problem:
        '2 calibrated turns of 3 have no cost: give their models a price, or run the calibration again',
    });
  });
});
