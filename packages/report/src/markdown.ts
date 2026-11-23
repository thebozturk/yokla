// The Markdown summary of a run (ADR-0094), for a CI's job summary: what the
// terminal summary says, as Markdown, and, with the gate's outcome, the
// verdict first. It holds no answers, as the terminal summary holds none; the
// results file and the HTML report keep them. Its table shows the first
// MARKDOWN_ROWS cases, so it stays well under a CI's limit for a summary.

import type { GateOutcome, Results } from '@yokla/core';
import { caseRows, countLines, errorLines, noteLines } from './terminal.ts';

/** The most cases the table shows. */
export const MARKDOWN_ROWS = 100;

const HEADINGS: Readonly<Record<GateOutcome['verdict'], string>> = {
  pass: 'the gate passed',
  broken: 'the gate is broken',
  unjudgeable: "the gate can't judge the run",
};

/** Text for a table cell: one line, with its pipes escaped. */
function cell(text: string): string {
  return text
    .replaceAll('\\', '\\\\')
    .replaceAll('|', '\\|')
    .replaceAll(/\s*\n\s*/gu, ' ');
}

/** Text for a list item: one line. */
function item(text: string): string {
  return `- ${text.replaceAll(/\s*\n\s*/gu, ' ')}`;
}

/** A run's summary as Markdown; with the gate's outcome, its verdict first. */
export function markdownReport(results: Results, outcome?: GateOutcome): string {
  const out: string[] = [
    outcome === undefined ? '### yokla' : `### yokla: ${HEADINGS[outcome.verdict]}`,
    '',
    `Run \`${results.run.id}\` against \`${results.run.profile.target}\`.`,
    '',
    ...countLines(results).map(item),
  ];

  if (outcome !== undefined) {
    const lines = [
      ...outcome.breaches.map((breach) => breach.message),
      ...outcome.problems.map((problem) => `can't judge: ${problem}`),
      ...outcome.notices.map((notice) => `notice: ${notice}`),
    ];
    if (lines.length > 0) out.push('', '**The gate**', '', ...lines.map(item));
  }

  const rows = caseRows(results);
  if (rows.length > 0) {
    out.push('', '| Status | Case | Why |', '| --- | --- | --- |');
    for (const [status, id, reason] of rows.slice(0, MARKDOWN_ROWS)) {
      out.push(`| ${cell(status)} | \`${cell(id)}\` | ${cell(reason)} |`);
    }
    const more = rows.length - MARKDOWN_ROWS;
    if (more > 0) {
      out.push('', `And ${String(more)} more, which the HTML report lists.`);
    }
  }

  const errors = errorLines(results);
  if (errors.length > 0) out.push('', '**Errors**', '', ...errors.map(item));

  const notes = noteLines(results);
  if (notes.length > 0) {
    out.push(
      '',
      '<details><summary>More about the run</summary>',
      '',
      '```text',
      ...notes,
      '```',
      '',
      '</details>',
    );
  }
  return `${out.join('\n')}\n`;
}
