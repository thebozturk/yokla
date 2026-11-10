// yokla baseline (design §13, ADR-0011): accepts a run as the baseline. It
// prints what changed since the previous baseline and writes the new one,
// a small file meant to be committed and reviewed. It refuses a run the gate
// can't judge. Exit codes: 0 written (or shown with --dry-run); 2 refused.

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { baselineChanges, baselineOf, evaluateGate, type Baseline } from '@yokla/core';
import { readBaseline, readResults, ResultsError } from '../load.ts';
import { writeReport, type Output } from './run.ts';

export const BASELINE_HELP = `Usage: yokla baseline --results <file> [options]

Options:
  --results <file>      the results file of the run to accept
  --out <file>          the baseline file (default: yokla.baseline.json)
  --dry-run             show the changes without writing`;

const BASELINE_OPTIONS = {
  results: { type: 'string' },
  out: { type: 'string' },
  'dry-run': { type: 'boolean' },
  help: { type: 'boolean' },
} as const;

const DEFAULT_BASELINE = 'yokla.baseline.json';

/** `cwd` resolves the default and relative output paths. */
export function baselineCommand(
  args: readonly string[],
  io: Output,
  cwd: string = process.cwd(),
): number {
  let values: ReturnType<
    typeof parseArgs<{ args: string[]; options: typeof BASELINE_OPTIONS }>
  >['values'];
  try {
    values = parseArgs({
      args: [...args],
      options: BASELINE_OPTIONS,
      strict: true,
      allowPositionals: false,
    }).values;
  } catch (error) {
    io.err(error instanceof Error ? error.message : String(error));
    io.err(BASELINE_HELP);
    return 2;
  }
  if (values.help === true) {
    io.out(BASELINE_HELP);
    return 0;
  }
  if (values.results === undefined) {
    io.err('--results is required');
    io.err(BASELINE_HELP);
    return 2;
  }

  const out = resolve(cwd, values.out ?? DEFAULT_BASELINE);
  let next: Baseline;
  let previous: Baseline | undefined;
  try {
    const results = readResults(values.results);
    const { problems } = evaluateGate(results);
    if (problems.length > 0) {
      io.err("can't accept a run the gate can't judge:");
      for (const problem of problems) io.err(`  ${problem}`);
      return 2;
    }
    next = baselineOf(results);
    previous = existsSync(out) ? readBaseline(out) : undefined;
  } catch (error) {
    if (error instanceof ResultsError) {
      io.err(error.message);
      return 2;
    }
    throw error;
  }

  for (const change of baselineChanges(previous, next)) io.out(change);
  if (values['dry-run'] === true) {
    io.out('dry run: nothing written');
    return 0;
  }
  io.out(`baseline: ${writeReport(out, `${JSON.stringify(next, null, 2)}\n`)}`);
  return 0;
}
