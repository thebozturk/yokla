// Turns per-sample findings into one verdict per dimension and one case status
// (design §13). This is the decision point, so it is tested directly.
//
// Status precedence: error → known-gap / gap-closed → pass / fail, and
// `unmeasured` when no check applied to any turn (never a silent pass).

import type { Results } from '../schema/results.ts';
import type { AggregationPolicy } from './types.ts';

type CaseResult = Results['cases'][number];
type Sample = CaseResult['samples'][number];
type DimensionResult = CaseResult['dimensions'][number];
type CheckSummary = Results['checks'][number];

const Z = 1.96;

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/** Wilson 95 % interval for `failed` out of `n`. */
export function wilson(failed: number, n: number): { level: 0.95; lower: number; upper: number } {
  if (n === 0) return { level: 0.95, lower: 0, upper: 1 };
  const p = failed / n;
  const z2 = Z * Z;
  const centre = (p + z2 / (2 * n)) / (1 + z2 / n);
  const half = (Z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / (1 + z2 / n);
  return {
    level: 0.95,
    lower: round(Math.max(0, centre - half)),
    upper: round(Math.min(1, centre + half)),
  };
}

/** Per sample: which dimensions failed, which only passed; and whether anything errored. */
function sampleVerdicts(sample: Sample): {
  failed: Set<string>;
  passed: Set<string>;
  error: boolean;
} {
  const failed = new Set<string>();
  const passed = new Set<string>();
  let error = false;
  for (const turn of sample.turns) {
    if (turn.error !== undefined) error = true;
    for (const check of turn.checks) {
      for (const finding of check.findings) {
        if (finding.verdict === 'error') error = true;
        else if (finding.verdict === 'fail') failed.add(finding.dimension);
        else passed.add(finding.dimension);
      }
    }
  }
  for (const dimension of failed) passed.delete(dimension);
  return { failed, passed, error };
}

export interface CaseAggregate {
  readonly status: CaseResult['status'];
  readonly unstable: boolean;
  readonly dimensions: DimensionResult[];
}

export function aggregateCase(
  samples: readonly Sample[],
  policies: Readonly<Record<string, AggregationPolicy>>,
  knownGap: boolean,
): CaseAggregate {
  const verdicts = samples.map(sampleVerdicts);
  const names = new Set<string>();
  for (const v of verdicts) for (const name of [...v.failed, ...v.passed]) names.add(name);

  let unstable = false;
  const dimensions: DimensionResult[] = [...names].toSorted().map((dimension) => {
    const policy = policies[dimension] ?? 'worst-of-n';
    const measured = verdicts.filter((v) => v.failed.has(dimension) || v.passed.has(dimension));
    const failed = measured.filter((v) => v.failed.has(dimension)).length;
    if (failed > 0 && failed < measured.length) unstable = true;
    const fails = policy === 'worst-of-n' ? failed > 0 : failed * 2 > measured.length;
    return {
      dimension,
      policy,
      verdict: fails ? 'fail' : 'pass',
      samples: measured.length,
      failed,
      ...(measured.length > 1 ? { interval: wilson(failed, measured.length) } : {}),
    };
  });

  let status: CaseResult['status'];
  if (verdicts.some((v) => v.error)) status = 'error';
  else if (dimensions.length === 0) status = 'unmeasured';
  else {
    const failing = dimensions.some((d) => d.verdict === 'fail');
    if (knownGap) status = failing ? 'known-gap' : 'gap-closed';
    else status = failing ? 'fail' : 'pass';
  }
  return { status, unstable, dimensions };
}

/** How often each check applied, and with what result, across the run. */
export function summariseChecks(cases: readonly CaseResult[]): CheckSummary[] {
  const byCheck = new Map<string, CheckSummary>();
  for (const c of cases) {
    for (const sample of c.samples) {
      for (const turn of sample.turns) {
        for (const check of turn.checks) {
          const entry = byCheck.get(check.check) ?? {
            check: check.check,
            applied: 0,
            notApplicable: 0,
            passed: 0,
            failed: 0,
            errors: 0,
          };
          if (!check.applicable) entry.notApplicable += 1;
          else {
            entry.applied += 1;
            if (check.findings.some((f) => f.verdict === 'error')) entry.errors += 1;
            else if (check.findings.some((f) => f.verdict === 'fail')) entry.failed += 1;
            else entry.passed += 1;
          }
          byCheck.set(check.check, entry);
        }
      }
    }
  }
  return [...byCheck.values()].toSorted((a, b) => a.check.localeCompare(b.check));
}
