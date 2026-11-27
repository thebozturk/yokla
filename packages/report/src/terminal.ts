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

/**
 * The lines that open a run's summary: the status counts and pass rate, then
 * what --stop-early saved and how many cases are proposed.
 */
export function countLines(results: Results): string[] {
  const lines: string[] = [];
  const counts = CASE_STATUSES.flatMap((status) => {
    const count = results.summary.statuses[status];
    return count === undefined ? [] : [`${status} ${String(count)}`];
  });
  const passRate = results.summary.passRate;
  lines.push(
    `${String(results.summary.cases)} cases: ${counts.join(', ')}` +
      (passRate === undefined ? '' : `; ${passRateText(passRate)}`),
  );
  if (results.run.sampling?.stopEarly === true) {
    // How many samples --stop-early saved (ADR-0038).
    const ran = results.cases.reduce((n, c) => n + c.samples.length, 0);
    const planned = results.cases.reduce((n, c) => n + (c.samplesPlanned ?? c.samples.length), 0);
    lines.push(`--stop-early: ${counted(ran, 'sample')} ran of ${String(planned)} planned`);
  }
  const proposed = results.cases.filter((c) => c.review === 'proposed').length;
  if (proposed > 0) {
    lines.push(
      `${String(proposed)} proposed: they ran, and gate once a person sets their status to approved`,
    );
  }
  return lines;
}

/** A case that didn't plainly pass, or its advisory findings: its status, its id, and why. */
export type CaseRow = readonly [status: string, id: string, reason: string];

/** The cases that didn't plainly pass, and advisory findings, heaviest first with weights (ADR-0076). */
export function caseRows(results: Results): CaseRow[] {
  const rows: CaseRow[] = [];
  const weights = hasWeights(results);
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
  }
  return rows;
}

/** Each turn that ended in an error, and each problem of the run itself. */
export function errorLines(results: Results): string[] {
  const lines: string[] = [];
  for (const c of byWeight(results, results.cases)) {
    for (const sample of c.samples) {
      for (const turn of sample.turns) {
        if (turn.error !== undefined) {
          lines.push(`${c.id} [sample ${String(sample.index)}]: ${turn.error}`);
        }
      }
    }
  }
  for (const issue of results.run.issues ?? []) lines.push(`run: ${issue}`);
  return lines;
}

/**
 * The rest of a run's summary: the cases by tag, what the target's logs, the
 * model proxy and the spans observed, yokla's own models, the run's
 * transforms, strategy, attacker and judge, and the frameworks.
 */
export function noteLines(results: Results): string[] {
  const out: string[] = [];

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
    out.push(...unsentAttemptLines(results, attacker.strategy === 'escalation'));
    out.push(...layeredAttemptLines(results));
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
    // A run-wide reason already covers every verdict; else the turns' own gaps (ADR-0099).
    if (judge.unmeasured === undefined) out.push(...unmeasuredVerdictLines(results));
  }
  out.push(...frameworkLines(results));
  return out;
}

/** How many of the tree's attempts were their parent in leetspeak, written by yokla (ADR-0109). */
function layeredAttemptLines(results: Results): string[] {
  const attacked = results.cases.flatMap((c) => c.samples).filter((s) => s.attacker !== undefined);
  const layered = attacked.filter((sample) => sample.attacker?.layer !== undefined).length;
  return layered === 0
    ? []
    : [
        `  ${String(layered)} of ${counted(attacked.length, 'attempt')} their parent in leetspeak, written by yokla`,
      ];
}

/**
 * The attacker's attempts not sent, counted by reason, with the values a
 * reason quotes left out so that one reason counts once; and the escalations
 * that never carried the attack (ADR-0101).
 */
function unsentAttemptLines(results: Results, escalation: boolean): string[] {
  const attacked = results.cases.flatMap((c) => c.samples).filter((s) => s.attacker !== undefined);
  const noun = escalation ? 'conversation' : 'attempt';
  const reasons = new Map<string, number>();
  let neverCarried = 0;
  for (const sample of attacked) {
    const unsent = sample.attacker?.unsent;
    if (unsent !== undefined) {
      const reason = unsent.replaceAll(/"[^"]*"/gu, '"…"');
      reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
    } else if (sample.turns.length > 0 && sample.turns.every((turn) => turn.approach === true)) {
      neverCarried += 1;
    }
  }
  const unsentCount = [...reasons.values()].reduce((sum, count) => sum + count, 0);
  const lines: string[] = [];
  if (unsentCount > 0) {
    lines.push(
      `  ${String(unsentCount)} of ${counted(attacked.length, noun)} ${escalation ? 'ended at a reply not sent' : 'not sent'}:`,
      ...[...reasons].map(([reason, count]) => `    ${reason} (${counted(count, noun)})`),
    );
  }
  if (neverCarried > 0) {
    lines.push(`  ${counted(neverCarried, 'conversation')} never carried the attack`);
  }
  return lines;
}

/** The judged turns' verdicts left unmeasured, counted by reason, if any (ADR-0099). */
function unmeasuredVerdictLines(results: Results): string[] {
  let verdicts = 0;
  const reasons = new Map<string, number>();
  for (const turn of results.cases.flatMap((c) => c.samples).flatMap((s) => s.turns)) {
    for (const check of turn.checks) {
      if (check.check !== 'judge') continue;
      verdicts += check.findings.length;
      for (const gap of check.unmeasured ?? []) {
        verdicts += 1;
        reasons.set(gap.reason, (reasons.get(gap.reason) ?? 0) + 1);
      }
    }
  }
  const unmeasured = [...reasons.values()].reduce((sum, count) => sum + count, 0);
  if (unmeasured === 0) return [];
  return [
    `  ${String(unmeasured)} of ${counted(verdicts, 'verdict')} unmeasured:`,
    ...[...reasons].map(([reason, count]) => `    ${reason} (${counted(count, 'verdict')})`),
  ];
}

export function terminalSummary(results: Results): TerminalSummary {
  const [first = '', ...more] = countLines(results);
  const rows = caseRows(results);
  const statusWidth = Math.max(0, ...rows.map(([status]) => status.length));
  const idWidth = Math.max(0, ...rows.map(([, id]) => id.length));
  return {
    out: [
      first,
      ...more.map((line) => `  ${line}`),
      ...rows.map(
        ([status, id, reason]) =>
          `  ${status.padEnd(statusWidth)}  ${id.padEnd(idWidth)}  ${reason}`,
      ),
      ...noteLines(results),
    ],
    err: errorLines(results).map((line) => `  ${line}`),
  };
}
