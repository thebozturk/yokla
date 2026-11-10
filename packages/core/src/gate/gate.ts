// The gate (design §16, ADR-0010): thresholds per suite over a run, and
// regressions against a baseline run. It reads results.v1 alone (ADR-0007).
// A run that couldn't be measured is never judged as broken or passed.

import type { GateConfig } from '../schema/config.ts';
import type { Results } from '../schema/results.ts';

type CaseResult = Results['cases'][number];

export interface GateBreach {
  readonly rule: 'failures' | 'unmeasured' | 'regression';
  readonly suite: string;
  readonly cases: readonly string[];
  readonly message: string;
}

export interface GateOutcome {
  /** pass: exit 0; broken: exit 1; unjudgeable: exit 2. */
  readonly verdict: 'pass' | 'broken' | 'unjudgeable';
  readonly breaches: readonly GateBreach[];
  /** Why the run can't be judged. */
  readonly problems: readonly string[];
  /** Worth knowing; never changes the verdict. */
  readonly notices: readonly string[];
}

/** Statuses that keep a baseline pass protected. */
const STILL_PASSING: ReadonlySet<CaseResult['status']> = new Set(['pass', 'gap-closed']);

function counted(count: number, noun: string): string {
  return `${String(count)} ${noun}${count === 1 ? '' : 's'}`;
}

function ids(cases: readonly CaseResult[]): string {
  return cases.map((c) => c.id).join(', ');
}

export function evaluateGate(
  results: Results,
  config: GateConfig = {},
  baseline?: Results,
): GateOutcome {
  const problems: string[] = [];
  const breaches: GateBreach[] = [];
  const notices: string[] = [];

  if (results.run.partial) problems.push('the run is partial: it stopped before every case ran');
  for (const status of ['error', 'fixture-missing'] as const) {
    const cases = results.cases.filter((c) => c.status === status);
    if (cases.length > 0)
      problems.push(`${counted(cases.length, `${status} case`)}: ${ids(cases)}`);
  }

  const suites = new Map<CaseResult['suite'], CaseResult[]>();
  for (const c of results.cases) suites.set(c.suite, [...(suites.get(c.suite) ?? []), c]);
  for (const [suite, cases] of suites) {
    const own = config.suites?.[suite];
    const maxFailures = own?.maxFailures ?? config.maxFailures ?? 0;
    const allowUnmeasured = own?.allowUnmeasured ?? config.allowUnmeasured ?? false;
    const failing = cases.filter((c) => c.status === 'fail');
    if (failing.length > maxFailures) {
      breaches.push({
        rule: 'failures',
        suite,
        cases: failing.map((c) => c.id),
        message: `${suite}: ${counted(failing.length, 'failing case')}, ${String(maxFailures)} allowed: ${ids(failing)}`,
      });
    }
    const unmeasured = cases.filter((c) => c.status === 'unmeasured');
    if (!allowUnmeasured && unmeasured.length > 0) {
      breaches.push({
        rule: 'unmeasured',
        suite,
        cases: unmeasured.map((c) => c.id),
        message: `${suite}: ${counted(unmeasured.length, 'unmeasured case')}; unmeasured never counts as a pass: ${ids(unmeasured)}`,
      });
    }
  }
  for (const c of results.cases) {
    if (c.status === 'gap-closed')
      notices.push(`${c.id} passes now; remove its known-gap marker and update the baseline`);
  }

  if (baseline !== undefined) {
    if (baseline.run.profile.sha256 !== results.run.profile.sha256)
      notices.push('the baseline was made with another profile');
    const current = new Map(results.cases.map((c) => [c.id, c]));
    for (const before of baseline.cases) {
      if (before.status !== 'pass') continue;
      const now = current.get(before.id);
      if (now === undefined) {
        notices.push(`${before.id} passed in the baseline but is not in this run`);
      } else if (!STILL_PASSING.has(now.status)) {
        breaches.push({
          rule: 'regression',
          suite: now.suite,
          cases: [now.id],
          message: `${now.id} passed in the baseline and is now ${now.status}`,
        });
      }
    }
  }

  const verdict = problems.length > 0 ? 'unjudgeable' : breaches.length > 0 ? 'broken' : 'pass';
  return { verdict, breaches, problems, notices };
}
