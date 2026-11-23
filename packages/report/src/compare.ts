// The terminal view of a comparison of runs (ADR-0042): each run with its
// gate verdict, cost and latency, the cases whose status differs, the
// findings each later run gained or lost against the first (ADR-0095), and
// the cheapest run that passes the gate.

import type { Comparison } from '@yokla/core';
import { counted } from './format.ts';

export type FindingRow = NonNullable<Comparison['cases'][number]['findings']>[number];

/** How a row changed in a later run against the first, the base (ADR-0095). */
export type FindingChange = 'new' | 'gone' | 'kept';

/**
 * A row in run `run` against the base: new when it fails only there, gone
 * when it fails only in the base, kept when in both; undefined when it fails
 * in neither, or the run doesn't have it.
 */
export function changeOf(row: FindingRow, run: number): FindingChange | undefined {
  const now = row.failed[run];
  if (now === null || now === undefined) return undefined;
  const before = (row.failed[0] ?? 0) > 0;
  if (now > 0) return before ? 'kept' : 'new';
  return before ? 'gone' : undefined;
}

/** The letter a comparison gives a run: A, B, C… */
export function runLetter(index: number): string {
  return String.fromCodePoint(65 + index);
}

/** Each later run's new and gone findings of the cases whose findings differ. */
function findingLines(comparison: Comparison): string[] {
  const inside = comparison.cases.filter((c) => c.findingsDiffer === true);
  if (inside.length === 0) return ['every case fails the same findings in every run'];
  const out = [`${counted(inside.length, 'case')} with findings that differ, each run against A:`];
  for (const c of inside) {
    const rows = c.findings ?? [];
    for (let run = 1; run < comparison.runs.length; run += 1) {
      const changes = rows.map((row) => ({ row, change: changeOf(row, run) }));
      const count = (change: FindingChange) => changes.filter((one) => one.change === change);
      const moved = [...count('new'), ...count('gone')];
      if (moved.length === 0) continue;
      out.push(
        `  ${c.id}  ${runLetter(run)}: ${String(count('new').length)} new, ${String(count('gone').length)} gone, ${String(count('kept').length)} kept`,
      );
      for (const { row, change } of moved) {
        const message = change === 'new' ? row.messages[run] : row.messages[0];
        out.push(
          `    ${(change ?? '').padEnd(4)}  turn ${String(row.turn)}  ${row.check} (${row.dimension}): ${message ?? ''}`,
        );
      }
    }
  }
  return out;
}

function usd(value: number | null): string {
  return value === null ? 'cost unknown' : `${value.toFixed(6)} USD`;
}

function ms(value: number | null): string {
  return value === null ? '-' : `${String(Math.round(value))} ms`;
}

export function comparisonText(comparison: Comparison): string[] {
  const out: string[] = [];
  const letters = comparison.runs.map((_run, index) => runLetter(index));
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

  out.push(...findingLines(comparison));

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
