// The terminal summary of a run (design §16): the status counts, one line per
// case that did not plainly pass, advisory findings, and what the target's
// logs observed. Errors and run issues go to stderr.

import { CASE_STATUSES, type Results } from '@yokla/core';
import { caseProblems, caseReason, dimensionSummary } from './problems.ts';

export interface TerminalSummary {
  readonly out: readonly string[];
  readonly err: readonly string[];
}

function turns(count: number): string {
  return `${String(count)} turn${count === 1 ? '' : 's'}`;
}

function round(value: number): string {
  return String(Math.round(value * 1e6) / 1e6);
}

/** "costUsd 0.0123 (no value on 2 turns), modelCalls 4" */
function observedTotals(
  totals: Readonly<Record<string, number>>,
  missing: Readonly<Record<string, number>>,
): string {
  const names = [...new Set([...Object.keys(totals), ...Object.keys(missing)])];
  return names
    .map((name) => {
      const total = totals[name];
      const gap = missing[name];
      const value = total === undefined ? '' : round(total);
      if (gap === undefined) return `${name} ${value}`;
      if (total === undefined) return `${name} no value on ${turns(gap)}`;
      return `${name} ${value} (no value on ${turns(gap)})`;
    })
    .join(', ');
}

export function terminalSummary(results: Results): TerminalSummary {
  const out: string[] = [];
  const err: string[] = [];

  const counts = CASE_STATUSES.flatMap((status) => {
    const count = results.summary.statuses[status];
    return count === undefined ? [] : [`${status} ${String(count)}`];
  });
  out.push(`${String(results.summary.cases)} cases: ${counts.join(', ')}`);

  const rows: [string, string, string][] = [];
  for (const c of results.cases) {
    const problems = caseProblems(c);
    const reason = caseReason(c, problems);
    if (reason !== undefined) {
      rows.push([c.status, c.id, `${reason}${c.unstable ? ' [unstable]' : ''}`]);
    }
    const advisory = dimensionSummary(c, problems.advisory, true);
    if (advisory !== '') rows.push(['advisory', c.id, advisory]);
    for (const sample of c.samples) {
      for (const turn of sample.turns) {
        if (turn.error !== undefined)
          err.push(`  ${c.id} [sample ${String(sample.index)}]: ${turn.error}`);
      }
    }
  }
  const statusWidth = Math.max(0, ...rows.map(([status]) => status.length));
  const idWidth = Math.max(0, ...rows.map(([, id]) => id.length));
  for (const [status, id, reason] of rows) {
    out.push(`  ${status.padEnd(statusWidth)}  ${id.padEnd(idWidth)}  ${reason}`);
  }

  const observation = results.run.observation;
  if (observation !== undefined) {
    const totals = observedTotals(observation.totals, observation.missing);
    const all = observation.matched + observation.unmatched;
    out.push(
      `target logs: ${String(observation.matched)} of ${String(all)} turns matched` +
        (totals === '' ? '' : `; ${totals}`),
    );
  }
  for (const issue of results.run.issues ?? []) err.push(`  run: ${issue}`);
  return { out, err };
}
