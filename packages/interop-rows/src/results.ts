// Result rows (ADR-0096): a run as neutral rows, one per turn of each sample,
// for a tool or a dashboard that reads rows. A row holds what was sent, the
// answer's text, the turn's latency and cost, its verdict, the case's status
// and the turn's findings. It holds the target's answers, as the results
// file does; it leaves out the evidence, the model calls and the rest.

import { aggregateCase, CaseStatus, z, type AggregationPolicy, type Results } from '@yokla/core';

export const RESULT_ROW_SCHEMA_ID = 'yokla.result-row/v1';

type CaseResult = Results['cases'][number];
type TurnResult = CaseResult['samples'][number]['turns'][number];

/** A turn's verdict: as a sample of that one turn would aggregate. */
export const TurnVerdict = z.enum(['pass', 'fail', 'unmeasured']);
export type TurnVerdict = z.output<typeof TurnVerdict>;

export const ResultRow = z
  .object({
    schema: z.literal(RESULT_ROW_SCHEMA_ID),
    run: z.string().min(1),
    case: z.string().min(1),
    suite: z.string().min(1),
    language: z.string().min(1),
    tags: z.array(z.string()),
    sample: z.int().nonnegative(),
    turn: z.int().nonnegative(),
    /** The message as sent. */
    message: z.string(),
    /** The answer's text; null when the turn has none. */
    answer: z.string().nullable(),
    latencyMs: z.number().nonnegative().nullable(),
    /** The target's model cost of the turn; null when nothing measured it. */
    costUsd: z.number().nonnegative().nullable(),
    verdict: TurnVerdict,
    /** The case's status in the run. */
    status: CaseStatus,
    findings: z.array(
      z.object({
        check: z.string(),
        dimension: z.string(),
        verdict: z.string(),
        severity: z.string(),
        message: z.string(),
      }),
    ),
    /** Why the turn couldn't be judged. */
    error: z.string().optional(),
  })
  .meta({ title: 'yokla result row v1' });
export type ResultRow = z.output<typeof ResultRow>;

/**
 * A turn's verdict by the case's policies: the status a sample of that one
 * turn would get. `fail` when a dimension that gates failed, `pass` when one
 * passed and none failed or went unmeasured, `unmeasured` otherwise.
 */
export function turnVerdict(
  turn: TurnResult,
  policies: Readonly<Record<string, AggregationPolicy>>,
): TurnVerdict {
  if (turn.error !== undefined) return 'unmeasured';
  const { status } = aggregateCase(
    [{ index: 0, cache: 'cold', turns: [{ user: turn.user, checks: turn.checks }] }],
    policies,
    false,
  );
  return status === 'pass' || status === 'fail' ? status : 'unmeasured';
}

/** A case's aggregation policies, as its dimensions recorded them in the run. */
function policiesOf(c: CaseResult): Record<string, AggregationPolicy> {
  const policies: Record<string, AggregationPolicy> = {};
  for (const { dimension, policy } of c.dimensions) {
    // A threshold's mean or percentile isn't a turn's to decide (design §13).
    if (policy !== 'mean' && policy !== 'percentile') policies[dimension] = policy;
  }
  return policies;
}

/** A run as rows, case by case, sample by sample, turn by turn (ADR-0096). */
export function resultRows(results: Results): ResultRow[] {
  return results.cases.flatMap((c) => {
    const policies = policiesOf(c);
    return c.samples.flatMap((sample) =>
      sample.turns.map((turn, index): ResultRow => ({
        schema: RESULT_ROW_SCHEMA_ID,
        run: results.run.id,
        case: c.id,
        suite: c.suite,
        language: c.language,
        tags: [...(c.tags ?? [])],
        sample: sample.index,
        turn: index,
        message: turn.user,
        answer: turn.response?.text ?? null,
        latencyMs: turn.response?.latencyMs ?? null,
        costUsd: turn.proxy?.costUsd ?? turn.spans?.costUsd ?? null,
        verdict: turnVerdict(turn, policies),
        status: c.status,
        findings: turn.checks.flatMap((check) =>
          check.findings.map((finding) => ({
            check: check.check,
            dimension: finding.dimension,
            verdict: finding.verdict,
            severity: finding.severity,
            message: finding.message,
          })),
        ),
        ...(turn.error === undefined ? {} : { error: turn.error }),
      })),
    );
  });
}
