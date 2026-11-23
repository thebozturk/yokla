// Another tool's rows as yokla's cases and results (ADR-0097), through the
// user's mapping. Cases are proposed, with `source: import` and no
// expectations: the person who approves one writes them (ADR-0004). Results
// follow ADR-0007: each row is one turn of one sample of its case; the row's
// verdict is a finding of `imported` in the dimension `verdict`, worst of n,
// and each assertion one in its own advisory dimension. A row whose verdict
// can't be found is unmeasured, never a pass (P5). Pure: the caller reads the
// file, hashes and times.

import {
  aggregateCase,
  RESULTS_SCHEMA_ID,
  Results,
  summariseCases,
  summariseChecks,
  type AggregationPolicy,
  type JsonValue,
} from '@yokla/core';
import { Document } from 'yaml';
import { indexOf, textOf, valueOf, valuesOf, verdictOf, type ImportMapping } from './mapping.ts';

type CaseResult = Results['cases'][number];
type TurnResult = CaseResult['samples'][number]['turns'][number];
type CheckResult = TurnResult['checks'][number];
type Finding = CheckResult['findings'][number];

/** The check every imported finding belongs to. */
export const IMPORTED_CHECK = 'imported';
/** The dimension of a row's own verdict. */
export const VERDICT_DIMENSION = 'verdict';

const SUITES = ['factual', 'quality', 'robustness', 'resilience', 'perf', 'redteam'] as const;
type Suite = (typeof SUITES)[number];

/** A name as a yokla id: lowercase letters, digits, "-" and "."; undefined when nothing is left. */
export function idOf(name: string): string | undefined {
  const id = name
    .toLowerCase()
    .replaceAll(/[^a-z0-9.]+/gu, '-')
    .replaceAll(/^[-.]+|[-.]+$/gu, '');
  return id === '' ? undefined : id;
}

function suiteOf(row: unknown, mapping: ImportMapping): Suite {
  const named = textOf(valueOf(row, mapping.suite));
  return SUITES.find((suite) => suite === named) ?? 'quality';
}

function tagsOf(row: unknown, mapping: ImportMapping): string[] {
  const value = valueOf(row, mapping.tags);
  const listed = Array.isArray(value) ? value : value === undefined ? [] : [value];
  return listed.flatMap((tag) => {
    const id = idOf(textOf(tag) ?? '');
    return id === undefined ? [] : [id];
  });
}

/** A row, read: its case, its place, and what the mapping finds in it. */
interface Read {
  readonly row: unknown;
  readonly position: number;
  readonly case: string;
  readonly named: string | undefined;
  readonly turn: number;
  readonly sample: number | undefined;
}

/** The rows grouped by case, in the order each case first appears. */
function grouped(
  rows: readonly unknown[],
  mapping: ImportMapping,
  idRequired: boolean,
): { readonly cases: Map<string, Read[]>; readonly problems: string[] } {
  const cases = new Map<string, Read[]>();
  const problems: string[] = [];
  rows.forEach((row, position) => {
    // An empty id is no id.
    const named = textOf(valueOf(row, mapping.case))?.trim() || undefined;
    if (named === undefined && idRequired) {
      problems.push(`row ${String(position + 1)}: the mapping finds no case id`);
      return;
    }
    const id = idOf(named ?? '') ?? `row-${String(position + 1)}`;
    const read: Read = {
      row,
      position,
      case: id,
      named,
      turn: indexOf(valueOf(row, mapping.turn)) ?? 0,
      sample: indexOf(valueOf(row, mapping.sample)),
    };
    cases.set(id, [...(cases.get(id) ?? []), read]);
  });
  return { cases, problems };
}

/** What importCases gives: the cases as a case file holds them, and the rows it couldn't read. */
export interface ImportedCases {
  readonly cases: readonly Record<string, JsonValue>[];
  readonly problems: readonly string[];
}

/**
 * Another tool's rows as yokla's cases (ADR-0097): one per case id, its rows'
 * messages as its turns, proposed, with `source: import` and where each came
 * from. `source` names the file; `language` is the default language.
 */
export function importCases(
  rows: readonly unknown[],
  mapping: ImportMapping,
  options: { readonly source: string; readonly language: string },
): ImportedCases {
  const { cases, problems } = grouped(rows, mapping, false);
  const written: Record<string, JsonValue>[] = [];
  for (const [id, reads] of cases) {
    const ordered = reads.toSorted((a, b) => a.turn - b.turn || a.position - b.position);
    const turns = ordered.flatMap((read) => {
      const message = textOf(valueOf(read.row, mapping.message));
      if (message === undefined || message === '') {
        problems.push(`row ${String(read.position + 1)}: the mapping finds no message`);
        return [];
      }
      return [{ user: message }];
    });
    // The case's own fields come from its first row in the file.
    const [first] = reads;
    if (turns.length === 0 || first === undefined) continue;
    const tags = tagsOf(first.row, mapping);
    written.push({
      id,
      ...(first.named !== undefined && first.named !== id ? { title: first.named } : {}),
      suite: suiteOf(first.row, mapping),
      language: textOf(valueOf(first.row, mapping.language)) ?? options.language,
      ...(tags.length === 0 ? {} : { tags }),
      turns,
      provenance: {
        source: 'import',
        evidence: `${options.source}, row${reads.length === 1 ? '' : 's'} ${reads.map((read) => String(read.position + 1)).join(', ')}`,
        status: 'proposed',
      },
    });
  }
  return { cases: written, problems };
}

/** The run importResults writes: its id, times and environment, and the file it came from. */
export interface ImportRun {
  readonly id: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly environment: Results['run']['environment'];
  readonly yoklaVersion: string;
  /** The source file's name and SHA-256, which stands for the profile's. */
  readonly source: { readonly name: string; readonly sha256: string };
  /** SHA-256 of a text: a case's definition is its id and messages. */
  readonly sha256: (text: string) => string;
  readonly language: string;
}

/** A row's verdict, and each of its assertions, as the check `imported`. */
function checkOf(
  row: unknown,
  mapping: ImportMapping,
  answer: string | undefined,
  timed: boolean,
  advisory: Set<string>,
): CheckResult {
  const findings: Finding[] = [];
  const unmeasured: { dimension: string; reason: string }[] = [];
  const reason = textOf(valueOf(row, mapping.reason));
  const score = valueOf(row, mapping.score);
  const found =
    mapping.verdict === undefined
      ? { unmeasured: 'the mapping has no verdict' }
      : verdictOf(row, mapping.verdict);
  const evidence: Record<string, JsonValue> = {
    ...(typeof score === 'number' || typeof score === 'string' ? { score } : {}),
    // Without a latency, the answer isn't a timed response: it is kept here.
    ...(answer !== undefined && !timed ? { answer } : {}),
  };
  if ('unmeasured' in found) {
    unmeasured.push({ dimension: VERDICT_DIMENSION, reason: found.unmeasured });
  } else {
    findings.push({
      dimension: VERDICT_DIMENSION,
      verdict: found.verdict,
      severity: 'high',
      message: reason ?? `the row's verdict: ${JSON.stringify(found.value)}`,
      ...(Object.keys(evidence).length === 0 ? {} : { evidence }),
    });
  }
  const assertions = mapping.findings;
  if (assertions !== undefined) {
    for (const [index, item] of valuesOf(row, assertions.at).entries()) {
      const name = textOf(valueOf(item, assertions.check)) ?? `assertion ${String(index + 1)}`;
      const dimension = idOf(name) ?? `assertion-${String(index + 1)}`;
      advisory.add(dimension);
      const verdict =
        assertions.verdict === undefined ? undefined : verdictOf(item, assertions.verdict);
      if (verdict === undefined || 'unmeasured' in verdict) continue;
      findings.push({
        dimension,
        verdict: verdict.verdict,
        severity: 'medium',
        message: textOf(valueOf(item, assertions.reason)) ?? name,
      });
    }
  }
  return {
    check: IMPORTED_CHECK,
    applicable: true,
    findings,
    ...(unmeasured.length === 0 ? {} : { unmeasured }),
  };
}

/**
 * Another tool's rows as a yokla run (ADR-0097): `results.v1`, which reports,
 * gates, compares and becomes a baseline like any run.
 */
export function importResults(
  rows: readonly unknown[],
  mapping: ImportMapping,
  run: ImportRun,
): { readonly results: Results; readonly problems: readonly string[] } {
  const { cases: byCase, problems } = grouped(rows, mapping, true);
  const cases: CaseResult[] = [];
  for (const [id, reads] of byCase) {
    const advisory = new Set<string>();
    const samples = new Map<number, Read[]>();
    // Without a mapped sample, a case's rows of the same turn are its samples, in order.
    const seen = new Map<number, number>();
    for (const read of reads) {
      const index = read.sample ?? seen.get(read.turn) ?? 0;
      seen.set(read.turn, index + 1);
      samples.set(index, [...(samples.get(index) ?? []), read]);
    }
    const results = [...samples.entries()]
      .toSorted(([a], [b]) => a - b)
      .map(([index, turns]) => ({
        index,
        cache: 'cold' as const,
        turns: turns
          .toSorted((a, b) => a.turn - b.turn || a.position - b.position)
          .map((read): TurnResult => {
            const message = textOf(valueOf(read.row, mapping.message)) ?? '';
            const answer = textOf(valueOf(read.row, mapping.answer));
            const latency = valueOf(read.row, mapping.latencyMs);
            const latencyMs =
              typeof latency === 'number' || (typeof latency === 'string' && latency.trim() !== '')
                ? Number(latency)
                : Number.NaN;
            const timed = Number.isFinite(latencyMs) && latencyMs >= 0;
            return {
              user: message,
              ...(timed
                ? {
                    response: {
                      status: 200,
                      latencyMs,
                      evidence: {},
                      ...(answer === undefined ? {} : { text: answer }),
                    },
                  }
                : {}),
              checks: [checkOf(read.row, mapping, answer, timed, advisory)],
            };
          }),
      }));
    const policies: Record<string, AggregationPolicy> = { [VERDICT_DIMENSION]: 'worst-of-n' };
    for (const dimension of advisory) {
      if (dimension !== VERDICT_DIMENSION) policies[dimension] = 'advisory';
    }
    const aggregate = aggregateCase(results, policies, false);
    const [first] = reads;
    const tags = first === undefined ? [] : tagsOf(first.row, mapping);
    const messages = results.flatMap((sample) => sample.turns.map((turn) => turn.user));
    cases.push({
      id,
      suite: first === undefined ? 'quality' : suiteOf(first.row, mapping),
      language:
        (first === undefined ? undefined : textOf(valueOf(first.row, mapping.language))) ??
        run.language,
      definitionSha256: run.sha256(JSON.stringify([id, messages])),
      status: aggregate.status,
      unstable: aggregate.unstable,
      ...(tags.length === 0 ? {} : { tags }),
      dimensions: aggregate.dimensions,
      samples: results,
    });
  }
  const results = Results.parse({
    schema: RESULTS_SCHEMA_ID,
    yokla: { version: run.yoklaVersion },
    run: {
      id: run.id,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      durationMs: Math.max(0, Date.parse(run.finishedAt) - Date.parse(run.startedAt)),
      profile: { target: 'imported', sha256: run.source.sha256 },
      environment: run.environment,
      correlation: 'none',
      partial: false,
    },
    cases,
    checks: summariseChecks(cases),
    summary: summariseCases(cases),
  });
  return { results, problems };
}

/** Imported cases as a case file, with a comment that says what they are (ADR-0097). */
export function importedCaseYaml(
  cases: readonly Record<string, JsonValue>[],
  source: string,
): string {
  // No anchors: a shared node would approve every case at once.
  const doc = new Document({ version: 1, cases }, { aliasDuplicateObjects: false });
  doc.commentBefore = [
    ` Imported by yokla import (ADR-0097) from ${source}: another tool's messages, with`,
    ' no expectations. They run, but gate only once a person writes what each should',
    ' expect and sets its status to approved (ADR-0004). See docs/guide/interop.md.',
  ].join('\n');
  return doc.toString({ lineWidth: 100 });
}
