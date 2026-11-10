// yokla gate (design §16, ADR-0010): judges a results file against the
// thresholds in yokla.config.yaml and, optionally, a baseline results file.
// Exit codes: 0 the gate passed; 1 the gate is broken; 2 the run can't be
// judged, or a file can't be read.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { evaluateGate, type Baseline, type Results, type YoklaConfig } from '@yokla/core';
import { LoadError, loadConfig, readBaseline, readResults, ResultsError } from '../load.ts';
import type { Output } from './run.ts';

export const GATE_HELP = `Usage: yokla gate --results <file> [options]

Options:
  --results <file>      the results file of a run
  --baseline <file>     a baseline or results file whose passing cases must still pass
                        (default: yokla.baseline.json, when present)
  --config <file>       the thresholds (default: yokla.config.yaml, when present)

Exit codes: 0 the gate passed, 1 the gate is broken, 2 the run can't be judged.`;

const GATE_OPTIONS = {
  results: { type: 'string' },
  baseline: { type: 'string' },
  config: { type: 'string' },
  help: { type: 'boolean' },
} as const;

const DEFAULT_CONFIG = 'yokla.config.yaml';
const DEFAULT_BASELINE = 'yokla.baseline.json';

const VERDICT_LINES = {
  pass: 'gate: passed',
  broken: 'gate: broken',
  unjudgeable: "gate: the run can't be judged",
} as const;

const EXIT_CODES = { pass: 0, broken: 1, unjudgeable: 2 } as const;

/** `cwd` is where yokla.config.yaml and yokla.baseline.json are looked for by default. */
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
  let baseline: Baseline | undefined;
  let baselinePath: string | undefined;
  let config: YoklaConfig | undefined;
  try {
    results = readResults(values.results);
    const defaultBaseline = join(cwd, DEFAULT_BASELINE);
    baselinePath = values.baseline ?? (existsSync(defaultBaseline) ? defaultBaseline : undefined);
    baseline = baselinePath === undefined ? undefined : readBaseline(baselinePath);
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
  if (values.baseline === undefined && baselinePath !== undefined) {
    io.out(`  notice: compared with the baseline in ${baselinePath}`);
  }
  for (const notice of outcome.notices) io.out(`  notice: ${notice}`);
  return EXIT_CODES[outcome.verdict];
}
