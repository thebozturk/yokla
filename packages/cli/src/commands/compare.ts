// yokla compare (ADR-0042): sets runs of the same cases side by side, one run
// per model the proxy swapped in. Each run is judged by the gate, with the
// configuration's thresholds and the baseline as yokla gate would; the
// comparison names the cheapest run that passes. It reads results files and
// contacts nothing.
// Exit codes: 0 compared, whatever the verdicts; 1 with --expect-same, a case's
// status differs between the runs (ADR-0043); 2 a file can't be read, or fewer
// than two runs are given.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { compareRuns, evaluateGate } from '@yokla/core';
import { comparisonText } from '@yokla/report';
import { LoadError, loadConfig, readBaseline, readResults, ResultsError } from '../load.ts';
import { writeReport, type Output } from './run.ts';

export const COMPARE_HELP = `Usage: yokla compare --results <file> --results <file> [options]

Sets runs of the same cases side by side, such as one run per model that
yokla run --swap-model tried, and names the cheapest run that passes the gate.

Options:
  --results <file>      a run's results file; two or more
  --config <file>       the gate's thresholds (default: yokla.config.yaml, when present)
  --baseline <file>     a baseline each run is gated against (default: yokla.baseline.json,
                        when present)
  --json <file>         also write the comparison as JSON
  --expect-same         exit with 1 when a case's status differs between the runs, as a
                        metamorphic run's must not

Exit codes: 0 compared; 1 with --expect-same, a status differs; 2 a file can't be read.`;

const OPTIONS = {
  results: { type: 'string', multiple: true },
  config: { type: 'string' },
  baseline: { type: 'string' },
  json: { type: 'string' },
  'expect-same': { type: 'boolean' },
  help: { type: 'boolean' },
} as const;

/** `cwd` is where yokla.config.yaml and yokla.baseline.json are looked for by default. */
export function compareCommand(
  args: readonly string[],
  io: Output,
  cwd: string = process.cwd(),
): number {
  let values;
  try {
    values = parseArgs({ args: [...args], options: OPTIONS, strict: true }).values;
  } catch (error) {
    io.err(error instanceof Error ? error.message : String(error));
    io.err(COMPARE_HELP);
    return 2;
  }
  if (values.help === true) {
    io.out(COMPARE_HELP);
    return 0;
  }
  const paths = values.results ?? [];
  if (paths.length < 2) {
    io.err('--results is needed at least twice: a comparison takes two runs or more');
    io.err(COMPARE_HELP);
    return 2;
  }
  try {
    const runs = paths.map((path) => readResults(path));
    const fallbackBaseline = join(cwd, 'yokla.baseline.json');
    const baselinePath =
      values.baseline ?? (existsSync(fallbackBaseline) ? fallbackBaseline : undefined);
    const baseline = baselinePath === undefined ? undefined : readBaseline(baselinePath);
    const fallbackConfig = join(cwd, 'yokla.config.yaml');
    const configPath = values.config ?? (existsSync(fallbackConfig) ? fallbackConfig : undefined);
    const config = configPath === undefined ? undefined : loadConfig(configPath);
    const comparison = compareRuns(
      runs.map((results) => ({ results, gate: evaluateGate(results, config?.gate, baseline) })),
    );
    for (const line of comparisonText(comparison)) io.out(line);
    if (config === undefined) {
      io.out('note: no yokla.config.yaml; the gate defaults apply: no failing or unmeasured case');
    }
    if (values.baseline === undefined && baselinePath !== undefined) {
      io.out(`note: each run is gated against the baseline in ${baselinePath}`);
    }
    if (values.json !== undefined) {
      io.out(`json: ${writeReport(values.json, `${JSON.stringify(comparison, null, 2)}\n`)}`);
    }
    // A change that mustn't move a verdict (ADR-0043): any case that moved breaks it.
    if (values['expect-same'] === true) {
      const moved = comparison.cases.filter((c) => c.differs && !c.changed);
      io.out(
        moved.length === 0
          ? '--expect-same: every case has the same status in every run'
          : `--expect-same: the status of ${moved.length === 1 ? 'a case' : `${String(moved.length)} cases`} differs: ${moved.map((c) => c.id).join(', ')}`,
      );
      return moved.length === 0 ? 0 : 1;
    }
    return 0;
  } catch (error) {
    if (error instanceof ResultsError || error instanceof LoadError) {
      io.err(error.message);
      return 2;
    }
    throw error;
  }
}
