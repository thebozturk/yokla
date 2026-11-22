// The gate (design §16, ADR-0010): thresholds per suite over a run, and
// regressions against a baseline run. It reads results.v1 alone (ADR-0007).
// A run that couldn't be measured is never judged as broken or passed.

import type { Baseline } from '../schema/baseline.ts';
import type { GateConfig } from '../schema/config.ts';
import type { Results } from '../schema/results.ts';
import { kindRisks } from '../taxonomy/risk.ts';

type CaseResult = Results['cases'][number];

export interface GateBreach {
  readonly rule: 'failures' | 'unmeasured' | 'regression' | 'latency' | 'cost' | 'risk';
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

/** The nearest-rank percentile of values sorted ascending: no interpolation. */
export function percentile(sorted: readonly number[], q: number): number {
  const rank = Math.max(1, Math.ceil(q * sorted.length));
  return sorted[rank - 1] ?? Number.NaN;
}

function round(value: number, digits: number): string {
  return String(Math.round(value * 10 ** digits) / 10 ** digits);
}

type Thresholds = Omit<GateConfig, 'suites'>;

/** Latency and cost thresholds over a suite's answered turns, every sample included (ADR-0014). */
function budgetBreaches(
  suite: string,
  cases: readonly CaseResult[],
  own: Thresholds,
  replayed = false,
): GateBreach[] {
  const turns = cases.flatMap((c) =>
    c.samples.flatMap((sample) => sample.turns.filter((turn) => turn.response !== undefined)),
  );
  const breaches: GateBreach[] = [];
  const caseIds = cases.map((c) => c.id);
  const unmeasured = (name: string, why: string) => {
    if (own.allowUnmeasured !== true) {
      breaches.push({
        rule: 'unmeasured',
        suite,
        cases: caseIds,
        message: `${suite}: ${name} is set but can't be measured: ${why}`,
      });
    }
  };
  const latencies = turns.map((turn) => turn.response?.latencyMs ?? 0).toSorted((a, b) => a - b);
  for (const [name, q] of [
    ['latencyP50Ms', 0.5],
    ['latencyP95Ms', 0.95],
  ] as const) {
    const limit = own[name];
    if (limit === undefined) continue;
    if (latencies.length === 0) {
      unmeasured(name, 'no answered turn');
      continue;
    }
    // A replayed answer comes at once: the run measured no model latency (ADR-0040).
    if (replayed) {
      unmeasured(name, 'the run replayed a cassette, so its model answers took no time');
      continue;
    }
    const value = percentile(latencies, q);
    if (value > limit) {
      breaches.push({
        rule: 'latency',
        suite,
        cases: caseIds,
        message: `${suite}: latency p${String(q * 100)} ${round(value, 1)} ms, ${String(limit)} allowed`,
      });
    }
  }
  if (own.costPerTurnUsd === undefined && own.costUsd === undefined) return breaches;
  const costs = turns.map((turn) => turn.proxy?.costUsd ?? null);
  const missing = costs.filter((cost) => cost === null).length;
  const why =
    turns.length === 0 ? 'no answered turn' : `${counted(missing, 'answered turn')} without a cost`;
  const measured = turns.length > 0 && missing === 0;
  const total = costs.reduce<number>((sum, cost) => sum + (cost ?? 0), 0);
  for (const [name, value] of [
    ['costPerTurnUsd', total / Math.max(1, turns.length)],
    ['costUsd', total],
  ] as const) {
    const limit = own[name];
    if (limit === undefined) continue;
    if (!measured) {
      unmeasured(name, why);
      continue;
    }
    if (value > limit) {
      breaches.push({
        rule: 'cost',
        suite,
        cases: caseIds,
        message: `${suite}: ${name === 'costUsd' ? 'cost' : 'cost per turn'} ${round(value, 6)} USD, ${String(limit)} allowed`,
      });
    }
  }
  return breaches;
}

function ids(cases: readonly CaseResult[]): string {
  return cases.map((c) => c.id).join(', ');
}

/**
 * gate.maxRisk over the approved cases (ADR-0089): an attack kind scoring
 * above it breaks the gate, and one without a score is unmeasured, as are
 * results that map no kind.
 */
function riskBreaches(
  results: Results,
  judged: readonly CaseResult[],
  config: GateConfig,
  max: number,
): GateBreach[] {
  const allowUnmeasured =
    config.suites?.redteam?.allowUnmeasured ?? config.allowUnmeasured ?? false;
  const unmeasured = (cases: readonly CaseResult[], why: string): GateBreach[] =>
    allowUnmeasured
      ? []
      : [
          {
            rule: 'unmeasured',
            suite: 'redteam',
            cases: cases.map((c) => c.id),
            message: `redteam: gate.maxRisk is set, but ${why}; unmeasured never counts as a pass`,
          },
        ];
  const kinds = results.taxonomy?.kinds;
  const risks = kinds === undefined ? [] : kindRisks(judged, kinds);
  if (risks.length === 0) return unmeasured([], 'no approved case has an attack kind');
  return risks.flatMap((risk) => {
    const cases = judged.filter((c) => c.kinds?.includes(risk.kind) === true);
    if (risk.score === undefined) {
      return unmeasured(cases, `no trial of ${risk.kind} was judged`);
    }
    if (risk.score <= max) return [];
    const failing = cases.filter((c) => c.status === 'fail');
    return [
      {
        rule: 'risk',
        suite: 'redteam',
        cases: failing.map((c) => c.id),
        message: `redteam: ${risk.kind} scores ${String(risk.score)} (${String(risk.succeeded)} of ${counted(risk.trials, 'trial')}), above gate.maxRisk ${String(max)}: ${ids(failing)}`,
      },
    ];
  });
}

export function evaluateGate(
  results: Results,
  config: GateConfig = {},
  baseline?: Baseline,
): GateOutcome {
  const problems: string[] = [];
  const breaches: GateBreach[] = [];
  const notices: string[] = [];

  if (results.run.partial) problems.push('the run is partial: it stopped before every case ran');
  // Only approved cases gate (ADR-0004): a proposed case ran, and waits for a person.
  const judged = results.cases.filter((c) => c.review !== 'proposed');
  const proposed = results.cases.filter((c) => c.review === 'proposed');
  if (proposed.length > 0) {
    notices.push(
      `${counted(proposed.length, 'proposed case')} not gating until a person approves: ${ids(proposed)}`,
    );
  }
  for (const status of ['error', 'fixture-missing'] as const) {
    const cases = judged.filter((c) => c.status === status);
    if (cases.length > 0)
      problems.push(`${counted(cases.length, `${status} case`)}: ${ids(cases)}`);
  }

  const suites = new Map<CaseResult['suite'], CaseResult[]>();
  for (const c of judged) suites.set(c.suite, [...(suites.get(c.suite) ?? []), c]);
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
    // Suite-level keys first, then the gate-wide ones (ADR-0010, ADR-0014).
    const { suites: _suites, ...wide } = config;
    breaches.push(
      ...budgetBreaches(
        suite,
        cases,
        { ...wide, ...own, allowUnmeasured },
        results.run.replay !== undefined,
      ),
    );
  }
  if (config.maxRisk !== undefined) {
    breaches.push(...riskBreaches(results, judged, config, config.maxRisk));
  }
  for (const c of judged) {
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
      } else if (now.review === 'proposed') {
        notices.push(`${now.id} passed in the baseline but is proposed now, so it isn't compared`);
      } else if (
        before.definitionSha256 !== undefined &&
        now.definitionSha256 !== undefined &&
        before.definitionSha256 !== now.definitionSha256
      ) {
        notices.push(`${now.id} changed since the baseline, so it isn't compared with it`);
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
