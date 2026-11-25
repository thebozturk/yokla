// Turns per-sample findings into one verdict per dimension and one case status
// (design §13). This is the decision point, so it is tested directly.
//
// Status precedence: error → known-gap / gap-closed → pass / fail, and
// `unmeasured` when no check applied to any turn, or a deciding dimension went
// unmeasured and nothing failed (ADR-0014): never a silent pass.

import { SUITES } from '../schema/common.ts';
import type { Results } from '../schema/results.ts';
import type { AggregationPolicy } from './types.ts';

type CaseResult = Results['cases'][number];
type RunSummary = Results['summary'];
type PassRate = NonNullable<RunSummary['passRate']>;
type Sample = CaseResult['samples'][number];
type DimensionResult = CaseResult['dimensions'][number];
type CheckSummary = Results['checks'][number];

const Z = 1.96;

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/** Wilson 95 % interval for a proportion of `failed` out of `n`; a pass rate's too. */
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

/**
 * Per sample: which dimensions failed, which only passed, which a check couldn't
 * measure without failing; and whether anything errored.
 */
function sampleVerdicts(sample: Sample): {
  failed: Set<string>;
  passed: Set<string>;
  unmeasured: Set<string>;
  error: boolean;
} {
  const failed = new Set<string>();
  const passed = new Set<string>();
  const unmeasured = new Set<string>();
  let error = false;
  for (const turn of sample.turns) {
    if (turn.error !== undefined) error = true;
    // An escalation's approach, which didn't carry the attack, decides nothing (ADR-0101).
    if (turn.approach === true) continue;
    for (const check of turn.checks) {
      for (const finding of check.findings) {
        if (finding.verdict === 'error') error = true;
        else if (finding.verdict === 'fail') failed.add(finding.dimension);
        else passed.add(finding.dimension);
      }
      for (const gap of check.unmeasured ?? []) unmeasured.add(gap.dimension);
    }
  }
  // A failure wins over a gap: the verdict below checks failures first.
  for (const dimension of failed) passed.delete(dimension);
  // Measured on one turn but not on another is not measured: never a pass.
  for (const dimension of unmeasured) passed.delete(dimension);
  return { failed, passed, unmeasured, error };
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
  for (const v of verdicts) {
    for (const name of [...v.failed, ...v.passed, ...v.unmeasured]) names.add(name);
  }

  let unstable = false;
  const dimensions: DimensionResult[] = [...names].toSorted().map((dimension) => {
    const policy = policies[dimension] ?? 'worst-of-n';
    const measured = verdicts.filter((v) => v.failed.has(dimension) || v.passed.has(dimension));
    const failed = measured.filter((v) => v.failed.has(dimension)).length;
    if (policy !== 'advisory' && failed > 0 && failed < measured.length) unstable = true;
    const fails = policy === 'majority-of-n' ? failed * 2 > measured.length : failed > 0;
    const gaps = verdicts.some((v) => v.unmeasured.has(dimension));
    return {
      dimension,
      policy,
      verdict: fails ? 'fail' : gaps ? 'unmeasured' : 'pass',
      samples: measured.length,
      failed,
      ...(measured.length > 1 ? { interval: wilson(failed, measured.length) } : {}),
    };
  });

  // Advisory dimensions are reported but never decide the status.
  const deciding = dimensions.filter((d) => d.policy !== 'advisory');
  let status: CaseResult['status'];
  if (verdicts.some((v) => v.error)) status = 'error';
  else if (deciding.length === 0) status = 'unmeasured';
  else {
    const failing = deciding.some((d) => d.verdict === 'fail');
    const gap = deciding.some((d) => d.verdict === 'unmeasured');
    if (failing) status = knownGap ? 'known-gap' : 'fail';
    else if (gap) status = 'unmeasured';
    else status = knownGap ? 'gap-closed' : 'pass';
  }
  return { status, unstable, dimensions };
}

/**
 * Whether no further sample can change a case's failure (ADR-0038), given its
 * result over the samples so far and the samples it plans: a sample errored;
 * a deciding worst-of-N dimension failed; or a deciding majority-of-N
 * dimension fails even if every remaining sample measures it and passes.
 * Passing is never settled early: a later sample can fail a dimension or
 * leave it unmeasured.
 */
export function settledFailure(result: CaseResult, planned: number): boolean {
  if (result.status === 'error') return true;
  const left = Math.max(0, planned - result.samples.length);
  return result.dimensions.some((d) => {
    if (d.policy === 'advisory') return false;
    if (d.policy === 'majority-of-n') return d.failed * 2 > d.samples + left;
    return d.failed > 0;
  });
}

/** How often each check applied, and with what result, across the run. */
export function summariseChecks(cases: readonly CaseResult[]): CheckSummary[] {
  const byCheck = new Map<string, CheckSummary>();
  for (const c of cases) {
    for (const sample of c.samples) {
      // An escalation's approach turns decide nothing, and count in no check's summary (ADR-0101).
      for (const turn of sample.turns.filter((t) => t.approach !== true)) {
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
            else if (check.findings.length === 0 && (check.unmeasured?.length ?? 0) > 0)
              entry.unmeasured = (entry.unmeasured ?? 0) + 1;
            else entry.passed += 1;
          }
          byCheck.set(check.check, entry);
        }
      }
    }
  }
  return [...byCheck.values()].toSorted((a, b) => a.check.localeCompare(b.check));
}

/** Statuses that pass, and that fail; every other status is left out of a pass rate (ADR-0076). */
const PASSING: ReadonlySet<CaseResult['status']> = new Set(['pass', 'gap-closed']);
const FAILING: ReadonlySet<CaseResult['status']> = new Set(['fail']);

const weightOf = (c: CaseResult): number => c.weight ?? 1;

/** At most six decimals: a weight's unit is the author's. */
function roundWeight(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/**
 * The sum of the weights of passing cases over the sum of the weights of
 * measured cases (ADR-0076); undefined when no case was measured. With every
 * weight 1 it is the plain pass rate.
 */
export function weightedPassRate(
  cases: readonly CaseResult[],
): { passed: number; measured: number; rate: number } | undefined {
  let passed = 0;
  let measured = 0;
  for (const c of cases) {
    if (PASSING.has(c.status)) passed += weightOf(c);
    if (PASSING.has(c.status) || FAILING.has(c.status)) measured += weightOf(c);
  }
  if (measured === 0) return undefined;
  return {
    passed: roundWeight(passed),
    measured: roundWeight(measured),
    rate: round(passed / measured),
  };
}

/** The plain pass rate with its Wilson interval, and the weighted one when asked (ADR-0076). */
function passRate(cases: readonly CaseResult[], weighted: boolean): PassRate | undefined {
  const passed = cases.filter((c) => PASSING.has(c.status)).length;
  const measured = passed + cases.filter((c) => FAILING.has(c.status)).length;
  if (measured === 0) return undefined;
  const byWeight = weighted ? weightedPassRate(cases) : undefined;
  return {
    passed,
    measured,
    rate: round(passed / measured),
    interval: wilson(passed, measured),
    ...(byWeight === undefined ? {} : { weighted: byWeight }),
  };
}

function statusCounts(cases: readonly CaseResult[]): RunSummary['statuses'] {
  const statuses: RunSummary['statuses'] = {};
  for (const c of cases) statuses[c.status] = (statuses[c.status] ?? 0) + 1;
  return statuses;
}

function group(cases: readonly CaseResult[], weighted: boolean) {
  const rate = passRate(cases, weighted);
  return {
    cases: cases.length,
    statuses: statusCounts(cases),
    ...(rate === undefined ? {} : { passRate: rate }),
  };
}

/**
 * The run's summary: how many cases, each status, and the pass rate, over the
 * run, per suite and per tag (ADR-0076, ADR-0077). A case with several tags
 * counts in each; a case without tags in none. The weighted rate is there
 * when a case has a weight other than 1.
 */
export function summariseCases(cases: readonly CaseResult[]): RunSummary {
  const weighted = cases.some((c) => weightOf(c) !== 1);
  const bySuite = SUITES.flatMap((suite) => {
    const own = cases.filter((c) => c.suite === suite);
    return own.length === 0 ? [] : [{ suite, ...group(own, weighted) }];
  });
  const names = [...new Set(cases.flatMap((c) => c.tags ?? []))].toSorted();
  const byTag = names.map((tag) => ({
    tag,
    ...group(
      cases.filter((c) => c.tags?.includes(tag) === true),
      weighted,
    ),
  }));
  const rate = passRate(cases, weighted);
  return {
    cases: cases.length,
    statuses: statusCounts(cases),
    ...(rate === undefined ? {} : { passRate: rate }),
    ...(bySuite.length === 0 ? {} : { suites: bySuite }),
    ...(byTag.length === 0 ? {} : { tags: byTag }),
  };
}
