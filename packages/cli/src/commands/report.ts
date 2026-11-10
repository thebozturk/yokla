// yokla report: renders an existing results file. It reads results.v1 alone
// (ADR-0007) and rejects a schema version it doesn't know. Exit codes: 0 the
// report was written; 2 the results file can't be read.

import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { Results, RESULTS_SCHEMA_ID } from '@yokla/core';
import { junitXml, terminalSummary } from '@yokla/report';
import { writeReport, type Output } from './run.ts';

export const REPORT_HELP = `Usage: yokla report --results <file> [options]

Options:
  --results <file>      the results file of a run
  --junit <file>        also write a JUnit XML report`;

const REPORT_OPTIONS = {
  results: { type: 'string' },
  junit: { type: 'string' },
  help: { type: 'boolean' },
} as const;

export class ResultsError extends Error {
  override readonly name = 'ResultsError';
}

/** Reads and validates a results file; any problem is a ResultsError. */
export function readResults(path: string): Results {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new ResultsError(`${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const schema =
    typeof value === 'object' && value !== null && 'schema' in value ? value.schema : undefined;
  if (schema !== RESULTS_SCHEMA_ID) {
    throw new ResultsError(
      `${path}: not a ${RESULTS_SCHEMA_ID} file (schema: ${JSON.stringify(schema) ?? 'missing'})`,
    );
  }
  const parsed = Results.safeParse(value);
  if (!parsed.success) {
    throw new ResultsError(
      [
        `${path}: invalid results`,
        ...parsed.error.issues
          .slice(0, 10)
          .map((issue) => `  ${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`),
      ].join('\n'),
    );
  }
  return parsed.data;
}

export function reportCommand(args: readonly string[], io: Output): number {
  let values: ReturnType<
    typeof parseArgs<{ args: string[]; options: typeof REPORT_OPTIONS }>
  >['values'];
  try {
    values = parseArgs({
      args: [...args],
      options: REPORT_OPTIONS,
      strict: true,
      allowPositionals: false,
    }).values;
  } catch (error) {
    io.err(error instanceof Error ? error.message : String(error));
    io.err(REPORT_HELP);
    return 2;
  }
  if (values.help === true) {
    io.out(REPORT_HELP);
    return 0;
  }
  if (values.results === undefined) {
    io.err('--results is required');
    io.err(REPORT_HELP);
    return 2;
  }
  let results: Results;
  try {
    results = readResults(values.results);
  } catch (error) {
    if (error instanceof ResultsError) {
      io.err(error.message);
      return 2;
    }
    throw error;
  }
  const summary = terminalSummary(results);
  for (const line of summary.out) io.out(line);
  for (const line of summary.err) io.err(line);
  if (values.junit !== undefined) io.out(`junit: ${writeReport(values.junit, junitXml(results))}`);
  return 0;
}
