import type { FindingOrigin, KindRisk, Results } from '@yokla/core';

// Number formatting the reports share. It never depends on the locale, so the
// same results give the same report everywhere (ADR-0023).

export function counted(count: number, noun: string): string {
  return `${String(count)} ${noun}${count === 1 ? '' : 's'}`;
}

/** At most six decimals: enough for a cost in USD. */
export function round(value: number): string {
  return String(Math.round(value * 1e6) / 1e6);
}

/** "costUsd 0.0123 (no value on 2 turns), modelCalls 4" */
export function observedTotals(
  totals: Readonly<Record<string, number>>,
  missing: Readonly<Record<string, number>>,
  noun: string,
): string {
  const names = [...new Set([...Object.keys(totals), ...Object.keys(missing)])];
  return names
    .map((name) => {
      const total = totals[name];
      const gap = missing[name];
      const value = total === undefined ? '' : round(total);
      if (gap === undefined) return `${name} ${value}`;
      if (total === undefined) return `${name} no value on ${counted(gap, noun)}`;
      return `${name} ${value} (no value on ${counted(gap, noun)})`;
    })
    .join(', ');
}

/** " (a, b)", or nothing for no parts. */
function detail(parts: readonly string[]): string {
  return parts.length === 0 ? '' : ` (${parts.join(', ')})`;
}

/**
 * Where a finding's value came from, in words (ADR-0033): "origin: what the
 * model was sent (call 2, tool search_products)". Calls count from 1 here.
 */
export function originText(origin: FindingOrigin): string {
  const call = origin.call === undefined ? [] : [`call ${String(origin.call + 1)}`];
  const number = origin.match === 'number' ? ['as a bare number'] : [];
  switch (origin.stage) {
    case 'input': {
      const where =
        origin.tool === undefined
          ? origin.role === undefined
            ? []
            : [`${origin.role} message`]
          : [`tool ${origin.tool}`];
      return `origin: what the model was sent${detail([...call, ...where, ...number])}`;
    }
    case 'model':
      return `origin: the model${detail([...call, ...number])}`;
    case 'app':
      return `origin: the app${detail(origin.reason === undefined ? [] : [origin.reason])}`;
    case 'unknown':
      return `origin: unknown${detail([...(origin.reason === undefined ? [] : [origin.reason]), ...call])}`;
  }
}

/** A finding's message, with its origin when it has one (ADR-0033). */
export function withOrigin(finding: {
  readonly message: string;
  readonly origin?: FindingOrigin | undefined;
}): string {
  return finding.origin === undefined
    ? finding.message
    : `${finding.message}; ${originText(finding.origin)}`;
}

type PassRate = NonNullable<Results['summary']['passRate']>;
type CaseResult = Results['cases'][number];

/** A rate or an interval bound, with three decimals. */
export function rate(value: number): string {
  return value.toFixed(3);
}

/** "pass rate 0.667 (2 of 3, 95 % 0.208 to 0.939), weighted 0.912" (ADR-0076). */
export function passRateText(passRate: PassRate): string {
  const { interval, weighted } = passRate;
  return (
    `pass rate ${rate(passRate.rate)} (${String(passRate.passed)} of ${String(passRate.measured)}, 95 % ${rate(interval.lower)} to ${rate(interval.upper)})` +
    (weighted === undefined ? '' : `, weighted ${rate(weighted.rate)}`)
  );
}

/** Whether a case of the run has a weight other than 1 (ADR-0076). */
export function hasWeights(results: Results): boolean {
  return results.cases.some((c) => c.weight !== undefined && c.weight !== 1);
}

/**
 * When the run has weights, the failing cases first, heaviest first, and the
 * others after them as they came (ADR-0076); else the cases as they came. The
 * sort keeps the order of failing cases of the same weight.
 */
export function byWeight(results: Results, cases: readonly CaseResult[]): CaseResult[] {
  if (!hasWeights(results)) return [...cases];
  const failing = cases.filter((c) => c.status === 'fail');
  return [
    ...failing.toSorted((a, b) => (b.weight ?? 1) - (a.weight ?? 1)),
    ...cases.filter((c) => c.status !== 'fail'),
  ];
}

/** The summary's tag groups, the most failing cases first, then by name (ADR-0077). */
export function tagsByFailures(results: Results): NonNullable<Results['summary']['tags']> {
  return (results.summary.tags ?? []).toSorted(
    (a, b) => (b.statuses.fail ?? 0) - (a.statuses.fail ?? 0) || a.tag.localeCompare(b.tag),
  );
}

/** What the reports say of the frameworks' mapping (ADR-0089). */
export const MAPPING_NOTE = 'mapped by yokla, not a compliance assessment';

/** A category's code: its id without its framework's (ADR-0089). */
export function categoryCode(framework: string, category: string): string {
  return category.slice(framework.length + 1);
}

/** "7.5 of 10, 95 % 4.1 to 9" (ADR-0089); undefined for a kind without a score. */
export function scoreText(risk: KindRisk): string | undefined {
  const { score, scoreInterval } = risk;
  if (score === undefined || scoreInterval === undefined) return undefined;
  return `${String(score)} of 10, 95 % ${String(scoreInterval.lower)} to ${String(scoreInterval.upper)}`;
}
