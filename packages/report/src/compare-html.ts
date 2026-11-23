// The comparison page (ADR-0095): runs of the same cases side by side, under
// the HTML report's rules (ADR-0023): no script, nothing loaded, every value
// escaped. The cases that changed come first and open. Each shows its status,
// cost and latency per run, the findings each later run gained or lost
// against the first, and turn by turn the user's message with each run's
// answer next to the others and the findings that failed under it. It holds
// the target's answers, as the results files do.

import type { Comparison, Results } from '@yokla/core';
import { changeOf, runLetter, type FindingRow } from './compare.ts';
import {
  answerBlock,
  badge,
  CONTENT_SECURITY_POLICY,
  h,
  list,
  ms,
  STATUS_TONE,
  STYLE,
  table,
  usd,
  type Html,
} from './html.ts';
import type { CaseResult } from './problems.ts';

type CaseRow = Comparison['cases'][number];
type Sample = CaseResult['samples'][number];

const SIDE_STYLE = `
.side { display: grid; grid-template-columns: repeat(auto-fit, minmax(18rem, 1fr)); gap: .75rem; }
.side > div { min-width: 0; }
.new { color: var(--bad); }
.gone { color: var(--good); }
.kept { color: var(--warn); }
`;

function statusBadge(status: CaseResult['status'] | null): Html {
  return status === null
    ? h`<span class="muted">missing</span>`
    : badge(status, STATUS_TONE[status]);
}

function latency(value: number | null): string {
  return value === null ? '-' : ms(value);
}

/** Whether the runs differ on the case: its status, its findings, or its definition. */
function moved(c: CaseRow): boolean {
  return c.differs || c.changed || c.findingsDiffer === true;
}

/** What each later run gained and lost against the first, in a few words. */
function changesText(c: CaseRow, runs: number): string {
  const rows = c.findings ?? [];
  const parts: string[] = [];
  for (let run = 1; run < runs; run += 1) {
    const changes = rows.map((row) => changeOf(row, run));
    const added = changes.filter((change) => change === 'new').length;
    const lost = changes.filter((change) => change === 'gone').length;
    if (added + lost > 0) {
      parts.push(`${runLetter(run)}: ${String(added)} new, ${String(lost)} gone`);
    }
  }
  return parts.join('; ');
}

function runsSection(comparison: Comparison): Html {
  const rows = comparison.runs.map(
    (run, index) =>
      h`<tr><td><strong>${runLetter(index)}</strong></td><td>${run.label}</td><td><code>${run.id}</code></td><td>${badge(
        run.gate.verdict,
        run.gate.verdict === 'pass' ? 'good' : 'bad',
      )}</td><td>${Object.entries(run.statuses)
        .map(([status, count]) => `${status} ${String(count)}`)
        .join(', ')}</td><td class="num">${usd(run.costUsd)}</td><td class="num">${latency(
        run.latencyP50Ms,
      )}</td><td class="num">${latency(run.latencyP95Ms)}</td></tr>`,
  );
  return h`<section id="runs"><h2>Runs</h2>${table(
    ['', 'Run', 'Id', 'Gate', 'Cases', 'Cost', 'Latency p50', 'p95'],
    rows,
    [5, 6, 7],
  )}${comparison.notices.length === 0 ? undefined : list(comparison.notices, 'muted')}</section>`;
}

function casesSection(comparison: Comparison): Html {
  const rows = comparison.cases.map(
    (c) =>
      h`<tr><td><a href="#case-${c.id}"><code>${c.id}</code></a></td><td>${c.statuses.map(
        (status, index) => h`${index === 0 ? '' : ' '}${statusBadge(status)}`,
      )}</td><td>${c.changed ? 'definition differs: not compared' : changesText(c, comparison.runs.length)}</td><td class="num">${(
        c.costUsd ?? []
      )
        .map((cost) => usd(cost))
        .join(' / ')}</td><td class="num">${(c.latencyMs ?? [])
        .map((value) => latency(value))
        .join(' / ')}</td></tr>`,
  );
  return h`<section id="cases"><h2>Cases</h2>${table(
    [
      'Case',
      comparison.runs.map((_run, index) => runLetter(index)).join(' / '),
      'Findings',
      'Cost',
      'Latency',
    ],
    rows,
    [3, 4],
  )}</section>`;
}

/** A row's cell for one run: how many samples failed it, and how it changed against the first. */
function rowCell(row: FindingRow, run: number): Html {
  const failed = row.failed[run];
  if (failed === null || failed === undefined) return h`<td class="muted">-</td>`;
  const change = run === 0 ? undefined : changeOf(row, run);
  const message = row.messages[run];
  return h`<td>${failed === 0 ? h`<span class="muted">passed</span>` : `failed in ${String(failed)}`}${
    change === undefined ? undefined : h` <span class="${change}">${change}</span>`
  }${message === null || message === undefined ? undefined : h`<br><span class="muted">${message}</span>`}</td>`;
}

function findingsTable(c: CaseRow, runs: number): Html | undefined {
  const rows = c.findings ?? [];
  if (rows.length === 0) return undefined;
  const letters = Array.from({ length: runs }, (_unused, index) => runLetter(index));
  return table(
    ['Turn', 'Check', 'Dimension', ...letters],
    rows.map(
      (row) =>
        h`<tr><td class="num">${row.turn}</td><td><code>${row.check}</code></td><td>${row.dimension}</td>${letters.map(
          (_letter, run) => rowCell(row, run),
        )}</tr>`,
    ),
    [0],
  );
}

/** The sample a run shows: its first that failed a finding, or else its first. */
function shownSample(c: CaseResult): Sample | undefined {
  const failing = c.samples.find((sample) =>
    sample.turns.some((turn) =>
      turn.checks.some((check) => check.findings.some((finding) => finding.verdict === 'fail')),
    ),
  );
  return failing ?? c.samples[0];
}

/** The findings that failed on a turn, as lines. */
function failedLines(turn: Sample['turns'][number]): string[] {
  return turn.checks.flatMap((check) =>
    check.findings
      .filter((finding) => finding.verdict === 'fail')
      .map((finding) => `${check.check} (${finding.dimension}): ${finding.message}`),
  );
}

function turnsBlock(found: readonly (CaseResult | undefined)[]): Html[] {
  const samples = found.map((c) => (c === undefined ? undefined : shownSample(c)));
  const turns = Math.max(0, ...samples.map((sample) => sample?.turns.length ?? 0));
  return Array.from({ length: turns }, (_unused, index) => {
    const users = [...new Set(samples.flatMap((sample) => sample?.turns[index]?.user ?? []))];
    const columns = samples.map((sample, run) => {
      const turn = sample?.turns[index];
      const head = h`<h4>${runLetter(run)}${sample === undefined ? '' : `, sample ${String(sample.index)}`}</h4>`;
      if (turn === undefined)
        return h`<div>${head}<p class="muted">No such turn in this run.</p></div>`;
      const failed = failedLines(turn);
      return h`<div>${head}${
        users.length > 1
          ? h`<div class="label">User</div><pre class="text">${turn.user}</pre>`
          : undefined
      }${answerBlock(turn)}${turn.error === undefined ? undefined : h`<p class="bad">Error: ${turn.error}</p>`}${
        failed.length === 0 ? h`<p class="muted">No finding failed.</p>` : list(failed, 'bad')
      }</div>`;
    });
    return h`<div class="turn"><h3>Turn ${index}</h3>${
      users.length === 1
        ? h`<div class="label">User</div><pre class="text">${users[0]}</pre>`
        : undefined
    }<div class="side">${columns}</div></div>`;
  });
}

function caseBlock(c: CaseRow, runs: readonly Results[]): Html {
  const found = runs.map((results) => results.cases.find((one) => one.id === c.id));
  const changes = c.changed ? '' : changesText(c, runs.length);
  return h`<details class="case" id="case-${c.id}"${moved(c) ? h` open` : undefined}><summary><code>${c.id}</code> ${c.statuses.map(
    (status, index) => h`${runLetter(index)} ${statusBadge(status)} `,
  )}<span class="muted">${c.suite}</span>${changes === '' ? undefined : h` · ${changes}`}</summary><div>${
    c.changed
      ? h`<p class="warn">The case's definition differs between the runs, so its findings aren't compared (ADR-0011).</p>`
      : undefined
  }${findingsTable(c, runs.length)}${turnsBlock(found)}</div></details>`;
}

/** The comparison as one HTML document, from the comparison and its runs' results, in the same order. */
export function comparisonHtml(comparison: Comparison, runs: readonly Results[]): string {
  const page = h`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${{ markup: CONTENT_SECURITY_POLICY }}">
<meta name="referrer" content="no-referrer">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>yokla comparison of ${comparison.runs.length} runs</title>
<style>${{ markup: STYLE + SIDE_STYLE }}</style>
</head>
<body>
<h1>yokla comparison</h1>
<p class="muted">This page holds the target's answers. Keep it as private as the results files. Each later run is read against run A.</p>
${runsSection(comparison)}
${casesSection(comparison)}
<section id="details"><h2>Case details</h2>
${comparison.cases.map((c) => h`${caseBlock(c, runs)}\n`)}</section>
</body>
</html>
`;
  return page.markup;
}
