// The terminal summary of a run (design §16): the status counts, one line per
// case that did not plainly pass, advisory findings, and what the target's
// logs observed. Errors and run issues go to stderr.

import { CASE_STATUSES, type Results } from '@yokla/core';
import { counted, observedTotals } from './format.ts';
import { caseProblems, caseReason, dimensionSummary } from './problems.ts';

export interface TerminalSummary {
  readonly out: readonly string[];
  readonly err: readonly string[];
}

export function terminalSummary(results: Results): TerminalSummary {
  const out: string[] = [];
  const err: string[] = [];

  const counts = CASE_STATUSES.flatMap((status) => {
    const count = results.summary.statuses[status];
    return count === undefined ? [] : [`${status} ${String(count)}`];
  });
  out.push(`${String(results.summary.cases)} cases: ${counts.join(', ')}`);
  const proposed = results.cases.filter((c) => c.review === 'proposed').length;
  if (proposed > 0) {
    out.push(
      `  ${String(proposed)} proposed: they ran, and gate once a person sets their status to approved`,
    );
  }

  const rows: [string, string, string][] = [];
  for (const c of results.cases) {
    const problems = caseProblems(c);
    const reason = caseReason(c, problems);
    if (reason !== undefined) {
      const marks = `${c.unstable ? ' [unstable]' : ''}${c.review === 'proposed' ? ' [proposed]' : ''}`;
      rows.push([c.status, c.id, `${reason}${marks}`]);
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
    const totals = observedTotals(observation.totals, observation.missing, 'turn');
    const all = observation.matched + observation.unmatched;
    out.push(
      `target logs: ${String(observation.matched)} of ${String(all)} turns matched` +
        (totals === '' ? '' : `; ${totals}`),
    );
  }
  const proxy = results.run.proxy;
  if (proxy !== undefined) {
    const { calls: _calls, ...sums } = proxy.totals;
    const totals = observedTotals(sums, proxy.missing, 'call');
    out.push(
      `model proxy (${proxy.correlation}): ${counted(proxy.records, 'call')}, ${String(proxy.unattributed)} unattributed` +
        (totals === '' ? '' : `; ${totals}`),
    );
  }
  for (const issue of results.run.issues ?? []) err.push(`  run: ${issue}`);
  return { out, err };
}
