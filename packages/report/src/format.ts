import type { FindingOrigin } from '@yokla/core';

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
