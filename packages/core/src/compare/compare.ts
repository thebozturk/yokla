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
  /** What the run changed, or "as the app asks" (runLabel). */
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
        /**
         * Its failing findings, one row per turn, check and dimension that failed
         * in a run (ADR-0095); none when its definition differs.
         */
        findings: z
          .array(
            z.object({
              /** The turn's index in the case's samples. */
              turn: z.int().nonnegative(),
              check: z.string(),
              dimension: z.string(),
              /** In each run, how many samples failed it; null when the case or the turn isn't there. */
              failed: z.array(z.int().nonnegative().nullable()),
              /** In each run, the first failing message; null when it didn't fail there. */
              messages: z.array(z.string().nullable()),
            }),
          )
          .optional(),
        /** A row fails in one run and not in another (ADR-0095). */
        findingsDiffer: z.boolean().optional(),
        /** In each run, the target's model cost of the case; null when unknown or not there. */
        costUsd: z.array(z.number().nonnegative().nullable()).optional(),
        /** In each run, the median latency of the case's answered turns; null with none. */
        latencyMs: z.array(z.number().nonnegative().nullable()).optional(),
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

/**
 * A run named by what it changed: its swaps (ADR-0042), such as "fake:
 * demo-writer-1 → demo-writer-mini", its tool changes (ADR-0043) and its
 * transforms (ADR-0045) and its strategy (ADR-0084); "as the app asks" for
 * a run that changed nothing.
 */
export function runLabel(results: Results): string {
  const swaps = (results.run.swaps ?? []).map(
    (swap) =>
      `${swap.upstream}: ${swap.asked} → ${swap.to === undefined ? '' : `${swap.to}/`}${swap.model}`,
  );
  const reversals = (results.run.toolChanges ?? []).map(
    (change) => `reversed: ${change.tool}=${change.at}`,
  );
  const transforms = results.run.transforms ?? [];
  const parts = [
    ...swaps,
    ...reversals,
    ...(transforms.length === 0
      ? []
      : [`transforms: ${transforms.map((transform) => transform.kind).join(', ')}`]),
    ...(results.run.strategy === undefined ? [] : [`strategy: ${results.run.strategy.name}`]),
  ];
  return parts.length === 0 ? 'as the app asks' : parts.join('; ');
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
    label: runLabel(results),
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

type CaseResult = Results['cases'][number];
type FindingRow = NonNullable<Comparison['cases'][number]['findings']>[number];

/**
 * A case's failing findings across runs (ADR-0095): one row per turn, check
 * and dimension that failed in some run, with how many of each run's samples
 * failed it and the first failing message there.
 */
export function findingRows(found: readonly (CaseResult | undefined)[]): FindingRow[] {
  const rows = new Map<
    string,
    FindingRow & { failed: (number | null)[]; messages: (string | null)[] }
  >();
  found.forEach((c, run) => {
    if (c === undefined) return;
    for (const sample of c.samples) {
      const counted = new Set<string>();
      sample.turns.forEach((turn, index) => {
        for (const check of turn.checks) {
          for (const finding of check.findings) {
            if (finding.verdict !== 'fail') continue;
            const key = JSON.stringify([index, check.check, finding.dimension]);
            let row = rows.get(key);
            if (row === undefined) {
              row = {
                turn: index,
                check: check.check,
                dimension: finding.dimension,
                failed: found.map(() => null),
                messages: found.map(() => null),
              };
              rows.set(key, row);
            }
            if (!counted.has(key)) {
              counted.add(key);
              row.failed[run] = (row.failed[run] ?? 0) + 1;
            }
            row.messages[run] ??= finding.message;
          }
        }
      });
    }
  });
  // A run that has the case and the turn, and didn't fail the row, failed it in no sample.
  for (const row of rows.values()) {
    found.forEach((c, run) => {
      if (row.failed[run] === null && c?.samples.some((sample) => sample.turns.length > row.turn)) {
        row.failed[run] = 0;
      }
    });
  }
  return [...rows.values()].toSorted(
    (a, b) =>
      a.turn - b.turn || a.check.localeCompare(b.check) || a.dimension.localeCompare(b.dimension),
  );
}

/** Whether a row fails in one run that has it and not in another. */
function rowsDiffer(rows: readonly FindingRow[]): boolean {
  return rows.some(
    (row) => new Set(row.failed.flatMap((count) => (count === null ? [] : [count > 0]))).size > 1,
  );
}

/** The target's model cost of a case, from the proxy or the spans; null when a turn's isn't known. */
function caseCost(c: CaseResult): number | null {
  let total = 0;
  for (const sample of c.samples) {
    for (const turn of sample.turns) {
      const cost = turn.proxy?.costUsd ?? turn.spans?.costUsd;
      if (cost === undefined || cost === null) return null;
      total += cost;
    }
  }
  return total;
}

/** The median latency of a case's answered turns; null with none. */
function caseLatency(c: CaseResult): number | null {
  const latencies = c.samples
    .flatMap((sample) => sample.turns.flatMap((turn) => turn.response?.latencyMs ?? []))
    .toSorted((a, b) => a - b);
  return latencies.length === 0 ? null : percentile(latencies, 0.5);
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
    const changed = definitions.size > 1;
    // A case whose definition differs isn't compared (ADR-0011).
    const findings = changed ? [] : findingRows(found);
    return {
      id,
      suite: present[0]?.suite ?? '',
      statuses: found.map((c) => c?.status ?? null),
      differs: new Set(present.map((c) => c.status)).size > 1,
      changed,
      findings,
      findingsDiffer: rowsDiffer(findings),
      costUsd: found.map((c) => (c === undefined ? null : caseCost(c))),
      latencyMs: found.map((c) => (c === undefined ? null : caseLatency(c))),
    };
  });
  // The cases whose verdict the run changed come first, then those whose findings it changed.
  const statusMoved = (c: (typeof cases)[number]) => c.differs && !c.changed;
  const ordered = [
    ...cases.filter((c) => statusMoved(c)),
    ...cases.filter((c) => !statusMoved(c) && c.findingsDiffer),
    ...cases.filter((c) => !statusMoved(c) && !c.findingsDiffer),
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
