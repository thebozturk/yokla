// yokla plan (design §14, ADR-0014): estimates what running cases would cost,
// from a calibration run, and contacts nothing. Without the data for an
// honest figure it says what is missing and gives none.
// Exit codes: 0 an estimate was printed; 2 it couldn't be made.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { plan, type YoklaConfig } from '@yokla/core';
import { definitionSha256 } from '@yokla/runtime';
import { LoadError, loadCases, loadConfig, readResults, ResultsError } from '../load.ts';
import type { Output } from './run.ts';

export const PLAN_HELP = `Usage: yokla plan --cases <path> --calibration <file> [options]

Options:
  --cases <path>        a case file or directory; repeatable
  --calibration <file>  the results of a calibration run, made with a model proxy
  --samples <n>         samples per case when the case doesn't say (default: 1)
  --config <file>       the upper bound factor (default: yokla.config.yaml, when present)`;

const PLAN_OPTIONS = {
  cases: { type: 'string', multiple: true },
  calibration: { type: 'string' },
  samples: { type: 'string' },
  config: { type: 'string' },
  help: { type: 'boolean' },
} as const;

function usd(value: number): string {
  return `${String(Math.round(value * 1e6) / 1e6)} USD`;
}

export function planCommand(
  args: readonly string[],
  io: Output,
  cwd: string = process.cwd(),
): number {
  let values: ReturnType<
    typeof parseArgs<{ args: string[]; options: typeof PLAN_OPTIONS }>
  >['values'];
  try {
    values = parseArgs({
      args: [...args],
      options: PLAN_OPTIONS,
      strict: true,
      allowPositionals: false,
    }).values;
  } catch (error) {
    io.err(error instanceof Error ? error.message : String(error));
    io.err(PLAN_HELP);
    return 2;
  }
  if (values.help === true) {
    io.out(PLAN_HELP);
    return 0;
  }
  if (values.cases === undefined || values.calibration === undefined) {
    io.err(
      '--cases and --calibration are required: plan estimates from a calibration run, never by guessing',
    );
    io.err(PLAN_HELP);
    return 2;
  }
  const samples = Number(values.samples ?? '1');
  if (!Number.isInteger(samples) || samples < 1) {
    io.err('--samples must be a positive integer');
    return 2;
  }

  let estimate;
  try {
    const cases = loadCases(values.cases);
    const calibration = readResults(values.calibration);
    const fallback = join(cwd, 'yokla.config.yaml');
    const configPath = values.config ?? (existsSync(fallback) ? fallback : undefined);
    const config: YoklaConfig | undefined =
      configPath === undefined ? undefined : loadConfig(configPath);
    estimate = plan(
      cases.map((c) => ({
        id: c.id,
        definitionSha256: definitionSha256(c),
        turns: c.turns.length,
        samples: c.samples ?? samples,
      })),
      calibration,
      config?.plan.upperBoundFactor ?? 2,
    );
  } catch (error) {
    if (error instanceof LoadError || error instanceof ResultsError) {
      io.err(error.message);
      return 2;
    }
    throw error;
  }
  if (!estimate.ok) {
    io.err(`plan: no estimate: ${estimate.problem}`);
    return 2;
  }
  io.out(
    `plan: ${String(estimate.cases)} cases, ${String(estimate.turns)} turns with their samples`,
  );
  io.out(
    `  ${String(estimate.ownCalibration)} of ${String(estimate.cases)} cases priced from their own calibration; the rest at the mean, ${usd(estimate.meanTurnUsd)} a turn`,
  );
  io.out(
    `  estimate: ${usd(estimate.estimateUsd)}; upper bound: ${usd(estimate.upperUsd)} (${String(estimate.factor)}x)`,
  );
  io.out("  yokla's own model calls: none");
  return 0;
}
