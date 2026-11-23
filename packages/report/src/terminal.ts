// The terminal summary of a run (design §16): the status counts, one line per
// case that did not plainly pass, advisory findings, and what the target's
// logs observed. Errors and run issues go to stderr.

import { CASE_STATUSES, failingCategories, type Results } from '@yokla/core';
import {
  byWeight,
  categoryCode,
  counted,
  MAPPING_NOTE,
  scoreText,
  observedTotals,
  passRateText,
  tagsByFailures,
  hasWeights,
} from './format.ts';
import { caseProblems, caseReason, dimensionSummary } from './problems.ts';

export interface TerminalSummary {
  readonly out: readonly string[];
  readonly err: readonly string[];
}

/** The attacker's bounds, as the summary words them (ADR-0087, ADR-0088). */
function attackerBound(attacker: NonNullable<Results['run']['attacker']>): string {
  switch (attacker.strategy) {
    case 'escalation': {
      return `at most ${counted(attacker.limit, 'turn')}`;
    }
    case 'tree': {
      const { branches, depth } = attacker;
      const shape =
        branches === undefined || depth === undefined
          ? ''
          : `${String(branches)} ${branches === 1 ? 'branch' : 'branches'} to depth ${String(depth)}, `;
      return `${shape}at most ${counted(attacker.limit, 'attempt')}`;
    }
    case 'translate': {
      return `into ${counted(attacker.limit, 'other language')}`;
    }
    case 'best-of-n':
    case 'iterative': {
      return counted(attacker.limit, 'attempt');
    }
  }
}

/**
 * What the failing findings map to, per framework, and each attack kind
 * that scored above 0 (ADR-0089); nothing when no finding failed.
 */
function frameworkLines(results: Results): string[] {
  const failing = new Map(failingCategories(results).map((row) => [row.category, row.cases]));
  if (failing.size === 0) return [];
  const lines = [`frameworks, ${MAPPING_NOTE}:`];
  for (const framework of results.taxonomy?.frameworks ?? []) {
    const named = framework.categories.flatMap((category) => {
      const cases = failing.get(category.id);
      return cases === undefined
        ? []
        : [
            `${categoryCode(framework.id, category.id)} ${category.name} (${counted(cases.length, 'case')})`,
          ];
    });
    if (named.length > 0) {
      lines.push(`  ${framework.name} ${framework.version}: ${named.join(', ')}`);
    }
  }
  const scored = (results.summary.risk ?? []).filter((risk) => (risk.score ?? 0) > 0);
  if (scored.length > 0) lines.push('risk by attack kind, from 0 to 10:');
  for (const risk of scored) {
    lines.push(
      `  ${risk.kind} (${risk.severity}): ${scoreText(risk) ?? ''}; ${String(risk.succeeded)} of ${counted(risk.trials, 'trial')} succeeded`,
    );
  }
  return lines;
}

export function terminalSummary(results: Results): TerminalSummary {
  const out: string[] = [];
  const err: string[] = [];

  const counts = CASE_STATUSES.flatMap((status) => {
    const count = results.summary.statuses[status];
    return count === undefined ? [] : [`${status} ${String(count)}`];
  });
  const passRate = results.summary.passRate;
  out.push(
    `${String(results.summary.cases)} cases: ${counts.join(', ')}` +
      (passRate === undefined ? '' : `; ${passRateText(passRate)}`),
  );
  if (results.run.sampling?.stopEarly === true) {
    // How many samples --stop-early saved (ADR-0038).
    const ran = results.cases.reduce((n, c) => n + c.samples.length, 0);
    const planned = results.cases.reduce((n, c) => n + (c.samplesPlanned ?? c.samples.length), 0);
    out.push(`  --stop-early: ${counted(ran, 'sample')} ran of ${String(planned)} planned`);
  }
  const proposed = results.cases.filter((c) => c.review === 'proposed').length;
  if (proposed > 0) {
    out.push(
      `  ${String(proposed)} proposed: they ran, and gate once a person sets their status to approved`,
    );
  }

  const rows: [string, string, string][] = [];
  const weights = hasWeights(results);
  // Heaviest first when the cases carry weights: a heavy failure is worth fixing first (ADR-0076).
  for (const c of byWeight(results, results.cases)) {
    const problems = caseProblems(c);
    const reason = caseReason(c, problems);
    if (reason !== undefined) {
      const stopped =
        c.samplesPlanned === undefined
          ? ''
          : ` [stopped after ${String(c.samples.length)} of ${String(c.samplesPlanned)} samples]`;
      const marks =
        `${c.unstable ? ' [unstable]' : ''}${stopped}${c.review === 'proposed' ? ' [proposed]' : ''}` +
        (weights ? ` [weight ${String(c.weight ?? 1)}]` : '') +
        (c.tags === undefined ? '' : ` [tags: ${c.tags.join(', ')}]`);
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

  // Per tag, the most failing first (ADR-0077).
  const tags = tagsByFailures(results);
  if (tags.length > 0) {
    out.push('by tag:');
    const tagWidth = Math.max(...tags.map((group) => group.tag.length));
    for (const group of tags) {
      const statuses = CASE_STATUSES.flatMap((status) => {
        const count = group.statuses[status];
        return count === undefined ? [] : [`${status} ${String(count)}`];
      });
      out.push(
        `  ${group.tag.padEnd(tagWidth)}  ${counted(group.cases, 'case')}: ${statuses.join(', ')}` +
          (group.passRate === undefined ? '' : `; ${passRateText(group.passRate)}`),
      );
    }
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
  const spans = results.run.spans;
  if (spans !== undefined) {
    const { calls: _calls, ...sums } = spans.totals;
    const totals = observedTotals(sums, spans.missing, 'call');
    out.push(
      `spans (traceparent): ${counted(spans.received, 'call')}, ${String(spans.unattributed)} unattributed${spans.settled ? '' : ', still coming when the wait ran out'}` +
        (totals === '' ? '' : `; ${totals}`),
    );
  }
  const own = results.run.own;
  if (own !== undefined) {
    out.push(
      `yokla's own model: ${counted(own.calls, 'call')}, ${String(own.cached)} from the cache; costUsd ${own.costUsd === null ? 'unknown' : String(Math.round(own.costUsd * 1e6) / 1e6)}`,
    );
  }
  const transforms = results.run.transforms;
  if (transforms !== undefined && transforms.length > 0) {
    out.push(
      `transforms: ${transforms
        .map((transform) => `${transform.kind} (${counted(transform.messages, 'message')})`)
        .join(', ')}`,
    );
  }
  const { strategy } = results.run;
  if (strategy !== undefined) {
    out.push(`strategy: ${strategy.name} (${counted(strategy.messages, 'message')})`);
  }
  // The attacker's strategy, its bounds, and the cases it adapted (ADR-0087, ADR-0088).
  const { attacker } = results.run;
  if (attacker !== undefined) {
    out.push(
      `attacker: ${attacker.strategy}, ${attackerBound(attacker)}, ${counted(attacker.cases, 'case')}`,
    );
  }
  // The judge: its model, its dimensions, and its calibration (ADR-0090).
  const { judge } = results.run;
  if (judge !== undefined) {
    const dimensions = judge.dimensions
      .map(
        (dimension) => `${dimension} (${judge.gated.includes(dimension) ? 'gating' : 'advisory'})`,
      )
      .join(', ');
    const calibrated = `${String(judge.calibration.items - judge.calibration.misjudged.length)} of ${counted(judge.calibration.items, 'calibration item')} judged right`;
    out.push(
      `judge: ${judge.model ?? 'none'}, ${dimensions}; ${judge.unmeasured === undefined ? calibrated : `unmeasured: ${judge.unmeasured}`}`,
    );
  }
  out.push(...frameworkLines(results));
  for (const issue of results.run.issues ?? []) err.push(`  run: ${issue}`);
  return { out, err };
}
