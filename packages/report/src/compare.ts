// The terminal view of a comparison of runs (ADR-0042): each run with its
// gate verdict, cost and latency, the cases whose status differs, and the
// cheapest run that passes the gate.

import type { Comparison } from '@yokla/core';

function usd(value: number | null): string {
  return value === null ? 'cost unknown' : `${value.toFixed(6)} USD`;
}

function ms(value: number | null): string {
  return value === null ? '-' : `${String(Math.round(value))} ms`;
}

export function comparisonText(comparison: Comparison): string[] {
  const out: string[] = [];
  const letters = comparison.runs.map((_run, index) => String.fromCodePoint(65 + index));
  out.push(`${String(comparison.runs.length)} runs compared:`);
  comparison.runs.forEach((run, index) => {
    const statuses = Object.entries(run.statuses)
      .map(([status, count]) => `${status} ${String(count)}`)
      .join(', ');
    out.push(`  ${letters[index] ?? '?'}  ${run.label}  (run ${run.id})`);
    out.push(
      `     gate ${run.gate.verdict}; ${statuses}; ${usd(run.costUsd)}, ${run.costPerTurnUsd === null ? 'per turn unknown' : `${run.costPerTurnUsd.toFixed(6)} USD a turn`}; latency p50 ${ms(run.latencyP50Ms)}, p95 ${ms(run.latencyP95Ms)}`,
    );
    for (const line of [...run.gate.problems, ...run.gate.breaches]) out.push(`     - ${line}`);
  });

  const differing = comparison.cases.filter((c) => c.differs || c.changed);
  if (differing.length === 0) {
    out.push('every case has the same status in every run');
  } else {
    out.push(`${String(differing.length)} cases differ (${letters.join(' / ')}):`);
    const width = Math.max(...differing.map((c) => c.id.length));
    for (const c of differing) {
      const statuses = c.statuses.map((status) => status ?? 'missing').join(' / ');
      out.push(
        `  ${c.id.padEnd(width)}  ${statuses}${c.changed ? '  [definition differs: not compared]' : ''}`,
      );
    }
  }

  if (comparison.cheapest === null) {
    out.push(`cheapest passing run: none named: ${comparison.noCheapest ?? ''}`);
  } else {
    const named = comparison.cheapest.runs.map((id) => {
      const index = comparison.runs.findIndex((run) => run.id === id);
      return `${letters[index] ?? '?'} (${comparison.runs[index]?.label ?? id})`;
    });
    out.push(`cheapest passing run: ${named.join(', ')}, ${usd(comparison.cheapest.costUsd)}`);
  }
  for (const notice of comparison.notices) out.push(`note: ${notice}`);
  return out;
}
