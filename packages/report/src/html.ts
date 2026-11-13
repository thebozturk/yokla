// The static HTML report (ADR-0023): one offline file, rendered from
// results.v1 alone (ADR-0007), to read why a case didn't pass.
// - It has no script and loads nothing. Its styles are inline, and its
//   Content-Security-Policy allows nothing else.
// - Every value is escaped, since the target's answers are untrusted text. The
//   `h` template escapes what it interpolates unless it is markup already.
//   It isn't named `html`, so that Prettier leaves its markup as written.
// - The same results give the same bytes: no render time, no locale formatting.
// - A model call's prompt is shown by role and size only (ADR-0015).

import { CASE_STATUSES, type Results } from '@yokla/core';
import { counted, observedTotals, round } from './format.ts';
import { xmlText } from './junit.ts';
import { caseProblems, caseReason, dimensionSummary, type CaseResult } from './problems.ts';

type TurnResult = CaseResult['samples'][number]['turns'][number];
type CheckResult = TurnResult['checks'][number];
type ModelCall = NonNullable<TurnResult['proxy']>['calls'][number];

/** Markup that is safe as it is. */
interface Html {
  readonly markup: string;
}
type Part = string | number | Html | readonly Html[] | undefined;

export const CONTENT_SECURITY_POLICY = "default-src 'none'; style-src 'unsafe-inline'";

function escape(text: string): string {
  return xmlText(text).replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

function markupOf(part: Part): string {
  if (part === undefined) return '';
  if (typeof part === 'string') return escape(part);
  if (typeof part === 'number') return String(part);
  if ('markup' in part) return part.markup;
  return part.map((piece) => piece.markup).join('');
}

/** A template whose strings are markup and whose values are escaped text. */
function h(strings: TemplateStringsArray, ...parts: readonly Part[]): Html {
  let markup = strings[0] ?? '';
  for (const [index, part] of parts.entries()) {
    markup += markupOf(part) + (strings[index + 1] ?? '');
  }
  return { markup };
}

const STYLE = `
:root { color-scheme: light dark; --bg: #ffffff; --fg: #1d2025; --muted: #5d6570;
  --line: #d8dce2; --panel: #f6f7f9; --code: #eef0f3;
  --good: #1a7f37; --bad: #c42b2b; --warn: #8f6200; }
@media (prefers-color-scheme: dark) {
  :root { --bg: #16181b; --fg: #e5e7ea; --muted: #9ba3ad; --line: #30353c;
    --panel: #1c1f23; --code: #23272c; --good: #4fc26f; --bad: #ff6f6f; --warn: #d6a832; }
}
* { box-sizing: border-box; }
body { margin: 0 auto; max-width: 76rem; padding: 1.5rem 1rem 3rem; background: var(--bg);
  color: var(--fg); font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
h1 { font-size: 1.4rem; margin: 0 0 1rem; }
h2 { font-size: 1.1rem; margin: 2rem 0 .5rem; padding-bottom: .25rem; border-bottom: 1px solid var(--line); }
h3 { font-size: 1rem; margin: 1rem 0 .25rem; }
h4 { font-size: .95rem; margin: .75rem 0 .25rem; }
code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
pre { margin: .25rem 0 .5rem; padding: .5rem .75rem; border-radius: 4px; background: var(--code);
  font-size: 12.5px; line-height: 1.45; white-space: pre-wrap; overflow-wrap: anywhere; }
pre.text { font-family: inherit; font-size: 14px; line-height: 1.5; }
.scroll { overflow-x: auto; }
table { width: 100%; margin: .25rem 0 .75rem; border-collapse: collapse; }
th, td { padding: .3rem .5rem; border-bottom: 1px solid var(--line); text-align: left; vertical-align: top; }
th { color: var(--muted); font-weight: 600; white-space: nowrap; }
td { overflow-wrap: break-word; }
td code { white-space: nowrap; }
.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
dl { display: grid; grid-template-columns: max-content 1fr; gap: .2rem 1rem; margin: 0; }
dt { color: var(--muted); }
dd { margin: 0; overflow-wrap: anywhere; }
ul { margin: .25rem 0; padding-left: 1.25rem; }
.counts { display: flex; flex-wrap: wrap; gap: .5rem 1.25rem; padding: 0; list-style: none; }
.status { display: inline-block; padding: 0 .4rem; border: 1px solid currentColor; border-radius: 3px;
  font-size: 12px; font-weight: 600; white-space: nowrap; }
.good { color: var(--good); }
.bad { color: var(--bad); }
.warn { color: var(--warn); }
.muted { color: var(--muted); }
.mark { margin-left: .4rem; color: var(--muted); font-size: 12px; }
.label { color: var(--muted); font-size: 12px; }
details.case { margin: .5rem 0; border: 1px solid var(--line); border-radius: 6px; background: var(--panel); }
details.case > summary { padding: .5rem .75rem; cursor: pointer; }
details.case > div { padding: 0 .75rem .75rem; }
.turn { margin-top: .75rem; padding-top: .5rem; border-top: 1px solid var(--line); }
details details > summary { color: var(--muted); cursor: pointer; }
a { color: inherit; }
@media print { details.case { break-inside: avoid-page; } }
`;

const STATUS_TONE: Readonly<Record<CaseResult['status'], string>> = {
  pass: 'good',
  fail: 'bad',
  error: 'bad',
  'fixture-missing': 'bad',
  unmeasured: 'warn',
  'known-gap': 'muted',
  'gap-closed': 'warn',
};

const VERDICT_TONE: Readonly<Record<string, string>> = {
  pass: 'good',
  fail: 'bad',
  error: 'bad',
  unmeasured: 'warn',
};

function badge(text: string, tone: string): Html {
  return h`<span class="status ${tone}">${text}</span>`;
}

function seconds(durationMs: number): string {
  return `${(durationMs / 1000).toFixed(3)} s`;
}

function ms(value: number): string {
  return `${String(Math.round(value))} ms`;
}

function usd(value: number | null): string {
  return value === null ? 'no cost' : `$${round(value)}`;
}

function json(value: unknown): Html {
  return h`<pre>${JSON.stringify(value, null, 2)}</pre>`;
}

function item(term: string, value: Part): Html {
  return h`<dt>${term}</dt><dd>${value}</dd>`;
}

function list(lines: readonly string[], tone: string): Html {
  return h`<ul class="${tone}">${lines.map((line) => h`<li>${line}</li>`)}</ul>`;
}

function table(head: readonly string[], rows: readonly Html[], numeric: readonly number[] = []) {
  const cells = head.map((name, index) =>
    numeric.includes(index) ? h`<th class="num">${name}</th>` : h`<th>${name}</th>`,
  );
  return h`<div class="scroll"><table><thead><tr>${cells}</tr></thead><tbody>${rows}</tbody></table></div>`;
}

function runSection(results: Results): Html {
  const { run } = results;
  const items = [
    item('Run', h`<code>${run.id}</code>`),
    item('Target', run.profile.target),
    item('Profile', h`<code>${run.profile.sha256}</code>`),
    item('Started', `${run.startedAt} (UTC)`),
    item('Finished', `${run.finishedAt} (UTC)`),
    item('Duration', seconds(run.durationMs)),
    item(
      'Completeness',
      run.partial ? badge('partial: the run stopped early', 'warn') : 'every case ran',
    ),
    item('yokla', results.yokla.version),
    item(
      'Environment',
      `Node.js ${run.environment.node}, ${run.environment.platform} ${run.environment.arch}`,
    ),
    item('Correlation', run.correlation),
  ];
  const { proxy, observation } = run;
  if (proxy !== undefined) {
    const { calls: _calls, ...sums } = proxy.totals;
    const totals = observedTotals(sums, proxy.missing, 'call');
    items.push(
      item(
        'Model proxy',
        `${proxy.correlation}: ${counted(proxy.records, 'call')}, ${String(proxy.attributed)} attributed, ${String(proxy.unattributed)} unattributed${totals === '' ? '' : `; ${totals}`}`,
      ),
    );
    if (proxy.prompts !== undefined) items.push(item('Prompts kept', proxy.prompts));
  }
  if (observation !== undefined) {
    const totals = observedTotals(observation.totals, observation.missing, 'turn');
    const all = observation.matched + observation.unmatched;
    items.push(
      item(
        "Target's logs",
        `${String(observation.matched)} of ${String(all)} turns matched, by ${observation.correlation}${totals === '' ? '' : `; ${totals}`}`,
      ),
    );
  }
  const issues = run.issues ?? [];
  return h`<section id="run"><h2>Run</h2><dl>${items}</dl>${
    issues.length === 0 ? undefined : h`<h3>Run issues</h3>${list(issues, 'bad')}`
  }</section>`;
}

function marks(c: CaseResult): Html[] {
  return [
    ...(c.review === 'proposed' ? [h`<span class="mark">[proposed]</span>`] : []),
    ...(c.unstable ? [h`<span class="mark">[unstable]</span>`] : []),
  ];
}

/** The one-line reason of the terminal summary, and the advisory findings. */
function reasonOf(c: CaseResult): string {
  const problems = caseProblems(c);
  const reason = caseReason(c, problems);
  const advisory = dimensionSummary(c, problems.advisory, true);
  return [reason, advisory === '' ? undefined : `advisory: ${advisory}`]
    .filter((part) => part !== undefined)
    .join('; ');
}

function casesSection(results: Results, ordered: readonly CaseResult[]): Html {
  const counts = CASE_STATUSES.flatMap((status) => {
    const count = results.summary.statuses[status];
    return count === undefined ? [] : [h`<li>${badge(status, STATUS_TONE[status])} ${count}</li>`];
  });
  const proposed = results.cases.filter((c) => c.review === 'proposed').length;
  const rows = ordered.map(
    (c) =>
      h`<tr><td>${badge(c.status, STATUS_TONE[c.status])}</td><td><a href="#case-${c.id}"><code>${c.id}</code></a>${marks(c)}</td><td>${c.suite}</td><td>${c.language}</td><td>${reasonOf(c)}</td></tr>`,
  );
  return h`<section id="cases"><h2>Cases</h2><p>${counted(results.summary.cases, 'case')}</p><ul class="counts">${counts}</ul>${
    proposed === 0
      ? undefined
      : h`<p class="muted">${counted(proposed, 'proposed case')}: they ran, and gate once a person sets their status to approved.</p>`
  }${table(['Status', 'Case', 'Suite', 'Language', 'Reason'], rows)}</section>`;
}

function checksSection(results: Results): Html | undefined {
  if (results.checks.length === 0) return undefined;
  const rows = results.checks.map(
    (check) =>
      h`<tr><td><code>${check.check}</code>${
        check.applied === 0 ? h`<span class="mark">never applied</span>` : undefined
      }</td><td class="num">${check.applied}</td><td class="num">${check.notApplicable}</td><td class="num">${check.passed}</td><td class="num">${check.failed}</td><td class="num">${check.errors}</td><td class="num">${check.unmeasured ?? 0}</td></tr>`,
  );
  return h`<section id="checks"><h2>Checks</h2><p class="muted">Turns per check.</p>${table(
    ['Check', 'Applied', 'Not applicable', 'Passed', 'Failed', 'Errors', 'Unmeasured'],
    rows,
    [1, 2, 3, 4, 5, 6],
  )}</section>`;
}

function dimensionsTable(c: CaseResult): Html | undefined {
  if (c.dimensions.length === 0) return undefined;
  const rows = c.dimensions.map(
    (d) =>
      h`<tr><td>${d.dimension}</td><td>${d.policy}</td><td>${badge(d.verdict, VERDICT_TONE[d.verdict] ?? 'muted')}</td><td class="num">${d.failed} of ${d.samples}</td><td class="num">${
        d.interval === undefined
          ? ''
          : `${d.interval.lower.toFixed(3)} to ${d.interval.upper.toFixed(3)}`
      }</td></tr>`,
  );
  return h`<h3>Dimensions</h3>${table(
    ['Dimension', 'Policy', 'Verdict', 'Failed samples', 'Failure rate, 95 %'],
    rows,
    [3, 4],
  )}`;
}

function checkRows(check: CheckResult): Html[] {
  const name = h`<code>${check.check}</code>`;
  const rows = check.findings.map(
    (finding) =>
      h`<tr><td>${name}</td><td>${badge(finding.verdict, VERDICT_TONE[finding.verdict] ?? 'muted')}</td><td>${finding.dimension}</td><td>${finding.severity}</td><td>${finding.message}${
        finding.evidence === undefined
          ? undefined
          : h`<details><summary>evidence</summary>${json(finding.evidence)}</details>`
      }</td></tr>`,
  );
  for (const gap of check.unmeasured ?? []) {
    rows.push(
      h`<tr><td>${name}</td><td>${badge('unmeasured', 'warn')}</td><td>${gap.dimension}</td><td></td><td>${gap.reason}</td></tr>`,
    );
  }
  if (rows.length === 0) {
    rows.push(
      h`<tr><td>${name}</td><td class="muted">no finding</td><td></td><td></td><td></td></tr>`,
    );
  }
  return rows;
}

function tokens(value: number | null): string {
  return value === null ? '–' : String(value);
}

function promptOf(call: ModelCall): string {
  if (call.prompt === undefined) return '–';
  if (call.prompt === null) return 'unreadable';
  return call.prompt.map((message) => `${message.role} ${String(message.chars)}`).join(', ');
}

function callsBlock(proxy: NonNullable<TurnResult['proxy']>): Html {
  const rows = proxy.calls.map(
    (call) =>
      h`<tr><td><code>${call.id}</code></td><td>${call.upstream}</td><td>${call.model ?? '–'}</td><td class="num">${call.status === null ? '–' : String(call.status)}</td><td class="num">${ms(call.durationMs)}</td><td class="num">${tokens(call.usage.input)}</td><td class="num">${tokens(call.usage.cachedInput)}</td><td class="num">${tokens(call.usage.cacheWrite)}</td><td class="num">${tokens(call.usage.output)}</td><td class="num">${tokens(call.usage.reasoning)}</td><td class="num">${usd(call.costUsd)}</td><td>${
        call.fault === undefined
          ? ''
          : `${call.fault.kind}${call.fault.applied ? '' : ' (not applied)'}`
      }</td><td>${promptOf(call)}</td></tr>`,
  );
  return h`<details><summary>Model calls: ${counted(proxy.calls.length, 'call')}, ${usd(proxy.costUsd)}, ${proxy.correlation} correlation</summary>${table(
    [
      'Call',
      'Upstream',
      'Model',
      'Status',
      'Duration',
      'Input',
      'Cached',
      'Cache write',
      'Output',
      'Reasoning',
      'Cost',
      'Fault',
      'Prompt, characters per message',
    ],
    rows,
    [3, 4, 5, 6, 7, 8, 9, 10],
  )}</details>`;
}

function answerBlock(turn: TurnResult): Html {
  const { response } = turn;
  if (response === undefined) return h`<p class="bad">No answer.</p>`;
  const facts = [
    `status ${String(response.status)}`,
    ms(response.latencyMs),
    ...(response.firstTextMs === undefined ? [] : [`first text ${ms(response.firstTextMs)}`]),
    ...(response.route === undefined ? [] : [`route ${response.route}`]),
    ...(response.id === undefined ? [] : [`id ${response.id}`]),
  ];
  const text =
    response.text === undefined || response.text === ''
      ? h`<p class="muted">The answer has no text.</p>`
      : h`<pre class="text">${response.text}</pre>`;
  const collections = Object.entries(response.evidence);
  const evidence =
    collections.length === 0
      ? undefined
      : h`<details><summary>Evidence: ${collections
          .map(([name, items]) => `${name} ${String(items.length)}`)
          .join(', ')}</summary>${json(response.evidence)}</details>`;
  return h`<div class="label">Answer · ${facts.join(' · ')}</div>${text}${
    turn.clarifying === true
      ? h`<p class="muted">The target asked a clarifying question.</p>`
      : undefined
  }${evidence}`;
}

function turnBlock(turn: TurnResult, sample: number, index: number): Html {
  const applied = turn.checks.filter((check) => check.applicable);
  const skipped = turn.checks.filter((check) => !check.applicable).map((check) => check.check);
  return h`<div class="turn"><h4>Sample ${sample}, turn ${index}</h4><div class="label">User${
    turn.requestId === undefined ? '' : ` · request id ${turn.requestId}`
  }</div><pre class="text">${turn.user}</pre>${answerBlock(turn)}${
    turn.error === undefined ? undefined : h`<p class="bad">Error: ${turn.error}</p>`
  }${
    turn.issues === undefined || turn.issues.length === 0
      ? undefined
      : h`<div class="label">Mapping issues</div>${list(turn.issues, 'warn')}`
  }${
    applied.length === 0
      ? h`<p class="muted">No check applied.</p>`
      : table(['Check', 'Verdict', 'Dimension', 'Severity', 'Message'], applied.flatMap(checkRows))
  }${
    skipped.length === 0 ? undefined : h`<p class="muted">Not applicable: ${skipped.join(', ')}</p>`
  }${turn.proxy === undefined ? undefined : callsBlock(turn.proxy)}${
    turn.observed === undefined
      ? undefined
      : h`<details><summary>Observed in the target's logs, by ${turn.observed.correlation}</summary>${json(turn.observed.fields)}</details>`
  }</div>`;
}

function caseBlock(c: CaseResult): Html {
  const reason = reasonOf(c);
  const samples = c.samples.map(
    (sample) =>
      h`<h3>Sample ${sample.index} · ${sample.cache}</h3>${sample.turns.map((turn, index) =>
        turnBlock(turn, sample.index, index),
      )}`,
  );
  return h`<details class="case" id="case-${c.id}"${c.status === 'pass' ? undefined : h` open`}><summary>${badge(c.status, STATUS_TONE[c.status])} <code>${c.id}</code>${marks(c)} <span class="muted">${c.suite} · ${c.language}</span>${
    reason === '' ? undefined : h` · ${reason}`
  }</summary><div>${
    c.knownGap === undefined
      ? undefined
      : h`<p>Known gap: ${c.knownGap.reason}${c.knownGap.issue === undefined ? '' : ` (${c.knownGap.issue})`}</p>`
  }${dimensionsTable(c)}${samples}</div></details>`;
}

/** The report as one HTML document. */
export function htmlReport(results: Results): string {
  // Cases that didn't pass come first, in the order the results list them.
  const ordered = [
    ...results.cases.filter((c) => c.status !== 'pass'),
    ...results.cases.filter((c) => c.status === 'pass'),
  ];
  const page = h`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${{ markup: CONTENT_SECURITY_POLICY }}">
<meta name="referrer" content="no-referrer">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>yokla run ${results.run.id}</title>
<style>${{ markup: STYLE }}</style>
</head>
<body>
<h1>yokla run</h1>
<p class="muted">This report holds the target's answers and evidence. Keep it as private as the results file.</p>
${runSection(results)}
${casesSection(results, ordered)}
${checksSection(results)}
<section id="details"><h2>Case details</h2>
${ordered.map((c) => h`${caseBlock(c)}\n`)}</section>
</body>
</html>
`;
  return page.markup;
}
