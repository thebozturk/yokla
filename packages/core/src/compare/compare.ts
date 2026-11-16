// Comparing runs (ADR-0042): the same cases, run once per model the proxy
// swapped in. Each run keeps its own gate verdict; the comparison sets the
// cases' statuses side by side, with each run's cost and latency, and names
// the cheapest run that passes the gate. It reads results alone (ADR-0007).

import { z } from 'zod';
import { percentile, type GateOutcome } from '../gate/gate.ts';
import { CaseStatus, type Results } from '../schema/results.ts';

export const COMPARISON_SCHEMA_ID = 'yokla.comparison/v1';

const Run = z.object({
  id: z.string(),
  /** The run's swaps, or "as the app asks". */
  label: z.string(),
  profileSha256: z.string(),
  gate: z.object({
    verdict: z.enum(['pass', 'broken', 'unjudgeable']),
    breaches: z.array(z.string()),
    problems: z.array(z.string()),
  }),
  statuses: z.partialRecord(CaseStatus, z.int().nonnegative()),
  /** The target's model cost; null when a call had none, or no proxy or span measured it. */
  costUsd: z.number().nullable(),
  /** The mean cost of an answered turn; null as costUsd is, or with no answered turn. */
  costPerTurnUsd: z.number().nullable(),
  /** Over every answered turn, every sample pooled; null with none. */
  latencyP50Ms: z.number().nullable(),
  latencyP95Ms: z.number().nullable(),
});

export const Comparison = z
  .object({
    schema: z.literal(COMPARISON_SCHEMA_ID),
    runs: z.array(Run),
    cases: z.array(
      z.object({
        id: z.string(),
        suite: z.string(),
        /** The case's status in each run, in the runs' order; null when it didn't run there. */
        statuses: z.array(CaseStatus.nullable()),
        /** Its statuses differ between the runs that have it. */
        differs: z.boolean(),
        /** Its definition differs between runs: its statuses aren't compared (ADR-0011). */
        changed: z.boolean(),
      }),
    ),
    /** The cheapest runs that pass the gate, by run id; null when none can be named. */
    cheapest: z.object({ runs: z.array(z.string()), costUsd: z.number() }).nullable(),
    /** Why no cheapest run is named. */
    noCheapest: z.string().optional(),
    notices: z.array(z.string()),
  })
  .meta({ title: 'yokla comparison v1' });
export type Comparison = z.output<typeof Comparison>;

/** "fake: demo-writer-1 → demo-writer-mini", or "as the app asks" for a run with no swap. */
export function swapLabel(results: Results): string {
  const swaps = results.run.swaps ?? [];
  if (swaps.length === 0) return 'as the app asks';
  return swaps
    .map(
      (swap) =>
        `${swap.upstream}: ${swap.asked} → ${swap.to === undefined ? '' : `${swap.to}/`}${swap.model}`,
    )
    .join('; ');
}

/** The target's model cost of a run, from the proxy or else its spans; null when unknown. */
function costOf(results: Results): number | null {
  const measured = results.run.proxy ?? results.run.spans;
  if (measured === undefined || (measured.missing['costUsd'] ?? 0) > 0) return null;
  return measured.totals['costUsd'] ?? 0;
}

function answeredTurns(results: Results) {
  return results.cases.flatMap((c) =>
    c.samples.flatMap((sample) => sample.turns.filter((turn) => turn.response !== undefined)),
  );
}

function summaryOf(results: Results, gate: GateOutcome) {
  const turns = answeredTurns(results);
  const latencies = turns.map((turn) => turn.response?.latencyMs ?? 0).toSorted((a, b) => a - b);
  const cost = costOf(results);
  return {
    id: results.run.id,
    label: swapLabel(results),
    profileSha256: results.run.profile.sha256,
    gate: {
      verdict: gate.verdict,
      breaches: gate.breaches.map((breach) => breach.message),
      problems: [...gate.problems],
    },
    statuses: results.summary.statuses,
    costUsd: cost,
    costPerTurnUsd: cost === null || turns.length === 0 ? null : cost / turns.length,
    latencyP50Ms: latencies.length === 0 ? null : percentile(latencies, 0.5),
    latencyP95Ms: latencies.length === 0 ? null : percentile(latencies, 0.95),
  };
}

/** Compares two or more runs, each with the verdict its gate gave. */
export function compareRuns(
  runs: readonly { readonly results: Results; readonly gate: GateOutcome }[],
): Comparison {
  const summaries = runs.map((run) => summaryOf(run.results, run.gate));
  const notices: string[] = [];
  if (new Set(summaries.map((run) => run.profileSha256)).size > 1) {
    notices.push('the runs were made with different profiles');
  }
  for (const { results } of runs) {
    if (results.run.replay !== undefined) {
      notices.push(
        `run ${results.run.id} replayed a cassette: its latency isn't the model's (ADR-0040)`,
      );
    }
  }

  const ids: string[] = [];
  for (const { results } of runs) {
    for (const c of results.cases) if (!ids.includes(c.id)) ids.push(c.id);
  }
  const cases = ids.map((id) => {
    const found = runs.map(({ results }) => results.cases.find((c) => c.id === id));
    const present = found.flatMap((c) => (c === undefined ? [] : [c]));
    const definitions = new Set(present.flatMap((c) => c.definitionSha256 ?? []));
    return {
      id,
      suite: present[0]?.suite ?? '',
      statuses: found.map((c) => c?.status ?? null),
      differs: new Set(present.map((c) => c.status)).size > 1,
      changed: definitions.size > 1,
    };
  });
  // The cases whose verdict the model changed come first.
  const ordered = [
    ...cases.filter((c) => c.differs && !c.changed),
    ...cases.filter((c) => !(c.differs && !c.changed)),
  ];

  const passing = summaries.filter((run) => run.gate.verdict === 'pass');
  const unknown = passing.filter((run) => run.costUsd === null);
  let cheapest: Comparison['cheapest'] = null;
  let noCheapest: string | undefined;
  if (passing.length === 0) {
    noCheapest = 'no run passes the gate';
  } else if (unknown.length > 0) {
    noCheapest = `the cost of ${unknown.map((run) => `run ${run.id}`).join(', ')} isn't known, so no run can be named the cheapest`;
  } else {
    const least = Math.min(...passing.map((run) => run.costUsd ?? Number.POSITIVE_INFINITY));
    cheapest = {
      runs: passing.filter((run) => run.costUsd === least).map((run) => run.id),
      costUsd: least,
    };
  }

  return {
    schema: COMPARISON_SCHEMA_ID,
    runs: summaries,
    cases: ordered,
    cheapest,
    ...(noCheapest === undefined ? {} : { noCheapest }),
    notices,
  };
}
