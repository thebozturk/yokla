// yokla plan (design §14, ADR-0014): what running some cases would cost,
// estimated from a calibration run, never guessed. A planned turn costs what
// the same case cost per turn in the calibration, when it ran there with the
// same definition (ADR-0011); otherwise the mean over every calibrated turn.

import type { Results } from '../schema/results.ts';

export interface PlannedCase {
  readonly id: string;
  readonly definitionSha256: string;
  readonly turns: number;
  readonly samples: number;
}

export type Plan =
  | {
      readonly ok: true;
      /** Planned turns: each case's turns times its samples. */
      readonly turns: number;
      readonly cases: number;
      /** Planned cases priced from their own calibration. */
      readonly ownCalibration: number;
      /** The mean cost of a calibrated turn, for the other cases. */
      readonly meanTurnUsd: number;
      readonly estimateUsd: number;
      readonly upperUsd: number;
      readonly factor: number;
    }
  | { readonly ok: false; readonly problem: string };

function counted(count: number, noun: string): string {
  return `${String(count)} ${noun}${count === 1 ? '' : 's'}`;
}

/** The mean of costs already checked to be numbers. */
function mean(costs: readonly (number | null)[]): number {
  return costs.reduce<number>((total, cost) => total + (cost ?? 0), 0) / costs.length;
}

export function plan(cases: readonly PlannedCase[], calibration: Results, factor: number): Plan {
  if (calibration.run.proxy === undefined) {
    return {
      ok: false,
      problem: 'the calibration run has no model proxy data: run it with a model proxy',
    };
  }
  const perCase = new Map<string, { definition: string | undefined; costs: (number | null)[] }>();
  for (const c of calibration.cases) {
    const costs = c.samples.flatMap((sample) =>
      sample.turns
        .filter((turn) => turn.response !== undefined)
        .map((turn) => turn.proxy?.costUsd ?? null),
    );
    perCase.set(c.id, { definition: c.definitionSha256, costs });
  }
  const all = [...perCase.values()].flatMap((entry) => entry.costs);
  if (all.length === 0) return { ok: false, problem: 'the calibration run has no answered turn' };
  const unpriced = all.filter((cost) => cost === null).length;
  if (unpriced > 0) {
    return {
      ok: false,
      problem: `${counted(unpriced, 'calibrated turn')} of ${String(all.length)} ${unpriced === 1 ? 'has' : 'have'} no cost: give their models a price, or run the calibration again`,
    };
  }
  const meanTurnUsd = mean(all);

  let estimateUsd = 0;
  let turns = 0;
  let ownCalibration = 0;
  for (const c of cases) {
    const own = perCase.get(c.id);
    const usable =
      own !== undefined && own.definition === c.definitionSha256 && own.costs.length > 0;
    if (usable) ownCalibration += 1;
    const planned = c.turns * c.samples;
    turns += planned;
    estimateUsd += planned * (usable ? mean(own.costs) : meanTurnUsd);
  }
  return {
    ok: true,
    turns,
    cases: cases.length,
    ownCalibration,
    meanTurnUsd,
    estimateUsd,
    upperUsd: estimateUsd * factor,
    factor,
  };
}
