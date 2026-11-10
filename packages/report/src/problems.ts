// What went wrong in a case, read from results.v1 alone (ADR-0007): the
// failing findings of its failing dimensions, split into deciding and
// advisory ones, and the errors of its turns and checks.

import type { Results } from '@yokla/core';

export type CaseResult = Results['cases'][number];

export interface Problem {
  readonly sample: number;
  readonly turn: number;
  readonly check: string;
  readonly dimension: string;
  readonly message: string;
}

export interface CaseProblems {
  /** Failing findings in dimensions that failed and decide the case. */
  readonly deciding: readonly Problem[];
  /** Failing findings in advisory dimensions; reported, never deciding. */
  readonly advisory: readonly Problem[];
  /** Turn errors and check errors. */
  readonly errors: readonly string[];
  /** Thresholds checks couldn't measure, as "dimension: reason", once each (ADR-0014). */
  readonly unmeasured: readonly string[];
}

export function caseProblems(c: CaseResult): CaseProblems {
  const failed = c.dimensions.filter((d) => d.verdict === 'fail');
  const deciding = new Set(failed.filter((d) => d.policy !== 'advisory').map((d) => d.dimension));
  const advisory = new Set(failed.filter((d) => d.policy === 'advisory').map((d) => d.dimension));
  const found: {
    deciding: Problem[];
    advisory: Problem[];
    errors: string[];
    unmeasured: string[];
  } = {
    deciding: [],
    advisory: [],
    errors: [],
    unmeasured: [],
  };
  for (const sample of c.samples) {
    for (const [turn, result] of sample.turns.entries()) {
      const where = `sample ${String(sample.index)}, turn ${String(turn)}`;
      if (result.error !== undefined) found.errors.push(`${where}: ${result.error}`);
      for (const check of result.checks) {
        for (const gap of check.unmeasured ?? []) {
          const line = `${gap.dimension}: ${gap.reason}`;
          if (!found.unmeasured.includes(line)) found.unmeasured.push(line);
        }
        for (const finding of check.findings) {
          if (finding.verdict === 'error') found.errors.push(`${where}: ${finding.message}`);
          if (finding.verdict !== 'fail') continue;
          const problem = {
            sample: sample.index,
            turn,
            check: check.check,
            dimension: finding.dimension,
            message: finding.message,
          };
          if (deciding.has(finding.dimension)) found.deciding.push(problem);
          else if (advisory.has(finding.dimension)) found.advisory.push(problem);
        }
      }
    }
  }
  return found;
}

/** "filter-honesty 1/3: <first message>; fabrication 2/3: …" */
export function dimensionSummary(c: CaseResult, problems: readonly Problem[], advisory: boolean) {
  return c.dimensions
    .filter((d) => d.verdict === 'fail' && (d.policy === 'advisory') === advisory)
    .map((d) => {
      const first = problems.find((p) => p.dimension === d.dimension);
      const counts = `${d.dimension} ${String(d.failed)}/${String(d.samples)}`;
      return first === undefined ? counts : `${counts}: ${first.message}`;
    })
    .join('; ');
}

/** One line on why a case did not pass, or undefined for a plain pass. */
export function caseReason(c: CaseResult, problems: CaseProblems): string | undefined {
  switch (c.status) {
    case 'pass':
      return undefined;
    case 'fail':
      return dimensionSummary(c, problems.deciding, false);
    case 'error':
    case 'fixture-missing':
      return problems.errors[0] ?? c.status;
    case 'unmeasured':
      return problems.unmeasured.length > 0
        ? `unmeasured ${problems.unmeasured.join('; ')}`
        : 'no check applied to any turn';
    case 'known-gap':
      return `known gap: ${c.knownGap?.reason ?? 'no reason given'}${c.knownGap?.issue === undefined ? '' : ` (${c.knownGap.issue})`}`;
    case 'gap-closed':
      return 'passes now; remove the known-gap marker and update the baseline';
  }
}
