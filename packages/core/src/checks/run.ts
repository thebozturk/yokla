// Runs the checks for one turn. A check that throws produces an `error`
// finding: the run goes on, and the case reports the error.

import type { Results } from '../schema/results.ts';
import type { Check, CheckContext } from './types.ts';

type CheckResult = Results['cases'][number]['samples'][number]['turns'][number]['checks'][number];

/** Runs `checks` (or only those the case names) on one turn. */
export function runChecks(checks: readonly Check[], context: CheckContext): CheckResult[] {
  const only = context.case.checks === undefined ? undefined : new Set(context.case.checks);
  return checks
    .filter((check) => only === undefined || only.has(check.id))
    .map((check): CheckResult => {
      try {
        const outcome = check.run(context);
        if (!outcome.applicable) return { check: check.id, applicable: false, findings: [] };
        return {
          check: check.id,
          applicable: true,
          findings: outcome.findings.map((finding) => ({
            dimension: finding.dimension,
            verdict: finding.verdict,
            severity: finding.severity,
            message: finding.message,
            ...(finding.evidence === undefined ? {} : { evidence: finding.evidence }),
          })),
          ...(outcome.unmeasured === undefined || outcome.unmeasured.length === 0
            ? {}
            : {
                unmeasured: outcome.unmeasured.map((u) => ({
                  dimension: u.dimension,
                  reason: u.reason,
                })),
              }),
        };
      } catch (error) {
        return {
          check: check.id,
          applicable: true,
          findings: [
            {
              dimension: 'check-error',
              verdict: 'error',
              severity: 'high',
              message: `check "${check.id}" failed: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        };
      }
    });
}
