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
