// yokla gate (design §16, ADR-0010): judges a results file against the
// thresholds in yokla.config.yaml and, optionally, a baseline results file.
// Exit codes: 0 the gate passed; 1 the gate is broken; 2 the run can't be
// judged, or a file can't be read.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { evaluateGate, type Results, type YoklaConfig } from '@yokla/core';
import { LoadError, loadConfig, readResults, ResultsError } from '../load.ts';
import type { Output } from './run.ts';

export const GATE_HELP = `Usage: yokla gate --results <file> [options]

Options:
  --results <file>      the results file of a run
  --baseline <file>     a results file whose passing cases must still pass
  --config <file>       the thresholds (default: yokla.config.yaml, when present)

Exit codes: 0 the gate passed, 1 the gate is broken, 2 the run can't be judged.`;

const GATE_OPTIONS = {
  results: { type: 'string' },
  baseline: { type: 'string' },
  config: { type: 'string' },
  help: { type: 'boolean' },
} as const;

const DEFAULT_CONFIG = 'yokla.config.yaml';

const VERDICT_LINES = {
  pass: 'gate: passed',
  broken: 'gate: broken',
  unjudgeable: "gate: the run can't be judged",
} as const;

const EXIT_CODES = { pass: 0, broken: 1, unjudgeable: 2 } as const;

/** `cwd` is where yokla.config.yaml is looked for by default. */
export function gateCommand(
  args: readonly string[],
  io: Output,
  cwd: string = process.cwd(),
): number {
  let values: ReturnType<
    typeof parseArgs<{ args: string[]; options: typeof GATE_OPTIONS }>
  >['values'];
  try {
    values = parseArgs({
      args: [...args],
      options: GATE_OPTIONS,
      strict: true,
      allowPositionals: false,
    }).values;
  } catch (error) {
    io.err(error instanceof Error ? error.message : String(error));
    io.err(GATE_HELP);
    return 2;
  }
  if (values.help === true) {
    io.out(GATE_HELP);
    return 0;
  }
  if (values.results === undefined) {
    io.err('--results is required');
    io.err(GATE_HELP);
    return 2;
  }

  let results: Results;
  let baseline: Results | undefined;
  let config: YoklaConfig | undefined;
  try {
    results = readResults(values.results);
    baseline = values.baseline === undefined ? undefined : readResults(values.baseline);
    const fallback = join(cwd, DEFAULT_CONFIG);
    const configPath = values.config ?? (existsSync(fallback) ? fallback : undefined);
    config = configPath === undefined ? undefined : loadConfig(configPath);
  } catch (error) {
    if (error instanceof ResultsError || error instanceof LoadError) {
      io.err(error.message);
      return 2;
    }
    throw error;
  }

  const outcome = evaluateGate(results, config?.gate, baseline);
  io.out(VERDICT_LINES[outcome.verdict]);
  for (const problem of outcome.problems) io.err(`  ${problem}`);
  for (const breach of outcome.breaches) io.out(`  ${breach.message}`);
  if (config === undefined) {
    io.out(`  notice: no ${DEFAULT_CONFIG}; the defaults apply: no failing or unmeasured case`);
  }
  for (const notice of outcome.notices) io.out(`  notice: ${notice}`);
  return EXIT_CODES[outcome.verdict];
}
