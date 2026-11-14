// yokla plan (design §14, ADR-0014): what running some cases would cost,
// estimated from a calibration run, never guessed. A planned turn costs what
// the same case cost per turn in the calibration, when it ran there with the
// same definition (ADR-0011); otherwise the mean over every calibrated turn.
// A case with a simulated customer has no fixed turns: a sample of it costs
// what one cost in its own calibration, the customer's calls included
// (ADR-0028); without that calibration, the plan says so and gives no figure.

import type { Results } from '../schema/results.ts';

export interface PlannedCase {
  readonly id: string;
  readonly definitionSha256: string;
  readonly turns: number;
  readonly samples: number;
  /** A simulated customer instead of fixed turns (ADR-0028). */
  readonly simulated?: boolean;
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
  const perCase = new Map<
    string,
    {
      definition: string | undefined;
      costs: (number | null)[];
      /** Per sample: its turns' cost and its customer's, and how many turns it took. */
      samples: { cost: number | null; turns: number }[];
    }
  >();
  for (const c of calibration.cases) {
    const costs = c.samples.flatMap((sample) =>
      sample.turns
        .filter((turn) => turn.response !== undefined)
        .map((turn) => turn.proxy?.costUsd ?? null),
    );
    const samples = c.samples.map((sample) => {
      const answered = sample.turns.filter((turn) => turn.response !== undefined);
      const parts = [
        ...answered.map((turn) => turn.proxy?.costUsd ?? null),
        ...(sample.customer === undefined ? [] : [sample.customer.costUsd]),
      ];
      return {
        cost: parts.includes(null) ? null : parts.reduce<number>((t, cost) => t + (cost ?? 0), 0),
        turns: answered.length,
      };
    });
    perCase.set(c.id, { definition: c.definitionSha256, costs, samples });
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
    if (c.simulated === true) {
      const calibrated =
        own !== undefined && own.definition === c.definitionSha256 ? own.samples : [];
      if (calibrated.length === 0) {
        return {
          ok: false,
          problem: `case "${c.id}" has a simulated customer, which has no fixed turns: calibrate it with a run of its own`,
        };
      }
      if (calibrated.some((sample) => sample.cost === null)) {
        return {
          ok: false,
          problem: `case "${c.id}" has a calibrated sample without a cost: give its models, and the customer model, a price`,
        };
      }
      ownCalibration += 1;
      const meanTurns = calibrated.reduce((t, s) => t + s.turns, 0) / calibrated.length;
      turns += Math.round(meanTurns * c.samples);
      estimateUsd += c.samples * mean(calibrated.map((sample) => sample.cost));
      continue;
    }
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
