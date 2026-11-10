// JUnit XML (design §16), for CI systems that show test reports. One
// testsuite per yokla suite, one testcase per case:
// - fail becomes <failure>; error and fixture-missing become <error>;
// - unmeasured and known-gap become <skipped>, so neither reads as a pass;
// - gap-closed, unstable samples and advisory findings go to <system-out>.
// Only finding messages are written, never the target's answers.

import type { Results } from '@yokla/core';
import { caseProblems, caseReason, type CaseResult, type Problem } from './problems.ts';

/** Whether XML 1.0 can carry this code point; lone surrogates can't. */
function allowed(code: number): boolean {
  return (
    code === 0x09 ||
    code === 0x0a ||
    code === 0x0d ||
    (code >= 0x20 && code <= 0xd7ff) ||
    (code >= 0xe000 && code <= 0xfffd) ||
    (code >= 0x10000 && code <= 0x10ffff)
  );
}

export function xmlText(text: string): string {
  let clean = '';
  for (const char of text) clean += allowed(char.codePointAt(0) ?? 0) ? char : '\uFFFD';
  return clean.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

export function xmlAttribute(text: string): string {
  return xmlText(text)
    .replaceAll('"', '&quot;')
    .replaceAll('\n', '&#10;')
    .replaceAll('\r', '&#13;')
    .replaceAll('\t', '&#9;');
}

function seconds(ms: number): string {
  return (ms / 1000).toFixed(3);
}

function caseMs(c: CaseResult): number {
  return c.samples
    .flatMap((sample) => sample.turns)
    .reduce((total, turn) => total + (turn.response?.latencyMs ?? 0), 0);
}

function problemLine(problem: Problem): string {
  return `sample ${String(problem.sample)}, turn ${String(problem.turn)}: ${problem.check} (${problem.dimension}): ${problem.message}`;
}

interface Counts {
  tests: number;
  failures: number;
  errors: number;
  skipped: number;
}

function count(cases: readonly CaseResult[]): Counts {
  const has = (...statuses: CaseResult['status'][]) =>
    cases.filter((c) => statuses.includes(c.status)).length;
  return {
    tests: cases.length,
    failures: has('fail'),
    errors: has('error', 'fixture-missing'),
    skipped: has('unmeasured', 'known-gap'),
  };
}

function countAttributes(counts: Counts): string {
  return `tests="${String(counts.tests)}" failures="${String(counts.failures)}" errors="${String(counts.errors)}" skipped="${String(counts.skipped)}"`;
}

function testcase(c: CaseResult): string[] {
  const problems = caseProblems(c);
  const reason = caseReason(c, problems) ?? '';
  const children: string[] = [];
  if (c.status === 'fail') {
    const body = problems.deciding.map(problemLine).join('\n');
    children.push(
      `<failure type="fail" message="${xmlAttribute(reason)}">${xmlText(body)}</failure>`,
    );
  } else if (c.status === 'error' || c.status === 'fixture-missing') {
    const body = problems.errors.join('\n');
    children.push(
      `<error type="${c.status}" message="${xmlAttribute(reason)}">${xmlText(body)}</error>`,
    );
  } else if (c.status === 'unmeasured' || c.status === 'known-gap') {
    const message = c.status === 'unmeasured' ? `unmeasured: ${reason}` : reason;
    children.push(`<skipped message="${xmlAttribute(message)}"/>`);
  }
  const notes = [
    ...(c.status === 'gap-closed' ? [`gap closed: ${reason}`] : []),
    ...(c.unstable ? ['unstable: the samples disagree'] : []),
    ...problems.advisory.map((problem) => `advisory: ${problemLine(problem)}`),
  ];
  if (notes.length > 0) children.push(`<system-out>${xmlText(notes.join('\n'))}</system-out>`);

  const open = `<testcase name="${xmlAttribute(c.id)}" classname="${xmlAttribute(`yokla.${c.suite}`)}" time="${seconds(caseMs(c))}"`;
  if (children.length === 0) return [`    ${open}/>`];
  return [`    ${open}>`, ...children.map((child) => `      ${child}`), '    </testcase>'];
}

export function junitXml(results: Results): string {
  const suites = new Map<string, CaseResult[]>();
  for (const c of results.cases) {
    const list = suites.get(c.suite) ?? [];
    list.push(c);
    suites.set(c.suite, list);
  }
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites name="yokla" ${countAttributes(count(results.cases))} time="${seconds(results.run.durationMs)}">`,
  ];
  for (const [suite, cases] of suites) {
    const time = cases.reduce((total, c) => total + caseMs(c), 0);
    lines.push(
      `  <testsuite name="${xmlAttribute(suite)}" ${countAttributes(count(cases))} time="${seconds(time)}" timestamp="${xmlAttribute(results.run.startedAt)}">`,
      ...cases.flatMap(testcase),
      '  </testsuite>',
    );
  }
  lines.push('</testsuites>', '');
  return lines.join('\n');
}
