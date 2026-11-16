// yokla shrink (ADR-0035): cuts a failing case down to the fewest turns that
// still fail the same way, and writes it as a proposed case. With --words it
// also cuts messages to their fewest words, with a warning: a cut message can
// stop asking what its expectations describe (ADR-0036). The
// original runs first, --reproduce times: a flaky failure is reported, never
// shrunk. Each candidate runs --samples times and must fail in all of them.
// Exit codes: 0 a case was written, or the case is already as small as it
// gets; 1 the failure is flaky or didn't reproduce; 2 a configuration problem.

import { existsSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  applyCandidate,
  pickTarget,
  plan,
  reproduction,
  shrink,
  shrunkCaseYaml,
  stillFails,
  type Case,
  type Results,
  type ShrinkCandidate,
  type ShrinkTarget,
  type Trial,
} from '@yokla/core';
import { originText } from '@yokla/report';
import { ConfigError, definitionSha256, runSuite, type RunOptions } from '@yokla/runtime';
import { findCaseSource, LoadError, readResults, ResultsError } from '../load.ts';
import { prepareRun, type PreparedRun } from '../prepare.ts';
import type { Output } from './run.ts';

export const SHRINK_HELP = `Usage: yokla shrink --results <file> --case <id> [options]

Cuts a failing case down to the fewest turns that still fail the same check,
and writes it as a proposed case.

Options:
  --results <file>      the run the case failed in
  --case <id>           the failing case
  --check <id>          the failing check to keep (default: the first deciding failure)
  --samples <n>         runs of each candidate; each must fail (default: 3)
  --reproduce <n>       runs of the original first; all must fail (default: 5)
  --max-runs <n>        candidates to run at most (default: 64)
  --words               also cut messages to their fewest words; a cut message can stop
                        asking what its turn's expectations describe
  --max-cost <usd>      stop once the model cost of the shrink reaches this
  --calibration <file>  a run to estimate the cost from, as yokla plan does
  --out <file>          where to write the case (default: <case id>.min.yaml next to its file)
  --profile <file>      the profile (default: yokla.profile.yaml)
  --cases <path>        a case file or directory; repeatable (default: cases)
  --config <file>       prices and check modules (default: yokla.config.yaml, when present)
  --target-url <url>    use this url instead of the profile's request url
  --proxy-url <url>     the model proxy, instead of 127.0.0.1 on modelProxy.port`;

const OPTIONS = {
  results: { type: 'string' },
  case: { type: 'string' },
  check: { type: 'string' },
  samples: { type: 'string' },
  reproduce: { type: 'string' },
  'max-runs': { type: 'string' },
  words: { type: 'boolean' },
  'max-cost': { type: 'string' },
  calibration: { type: 'string' },
  out: { type: 'string' },
  profile: { type: 'string', default: 'yokla.profile.yaml' },
  cases: { type: 'string', multiple: true },
  config: { type: 'string' },
  'target-url': { type: 'string' },
  'proxy-url': { type: 'string' },
  help: { type: 'boolean' },
} as const;

function count(value: string | undefined, name: string, fallback: number): number {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) {
    throw new LoadError(`--${name} must be a positive integer`);
  }
  return number;
}

function usd(value: number): string {
  return `${value.toFixed(6)} USD`;
}

/** The model cost a run recorded, or null when a call had none. */
function runCost(results: Results): number | null {
  const proxy = results.run.proxy;
  if (proxy === undefined) return 0;
  if ((proxy.missing['costUsd'] ?? 0) > 0) return null;
  return proxy.totals['costUsd'] ?? 0;
}

/** "price-grounded (fabrication) on turn 3, origin: the model" */
function describeTarget(target: ShrinkTarget): string {
  const origin = target.stage === undefined ? '' : `, ${originText({ stage: target.stage })}`;
  return `${target.check} (${target.dimension}) on turn ${String(target.turn + 1)}${origin}`;
}

function characters(turns: readonly { readonly user: string }[]): number {
  return turns.reduce((total, turn) => total + turn.user.length, 0);
}

/** A failing case of a run, checked and ready to shrink (ADR-0035). */
export interface ShrinkPlan {
  readonly results: Results;
  readonly original: Case;
  readonly target: ShrinkTarget;
  readonly source: { readonly file: string; readonly raw: Record<string, unknown> };
  /** Where the shrunk case goes; it doesn't exist yet. */
  readonly out: string;
}

/**
 * Checks that a case of a run can be shrunk: the case files still hold it with
 * the definition the run recorded, it has fixed turns, it failed, and its
 * shrunk file doesn't exist yet.
 */
export function planShrink(
  results: Results,
  resultsName: string,
  caseId: string,
  prepared: PreparedRun,
  check?: string,
  out?: string,
): ShrinkPlan {
  const result = results.cases.find((c) => c.id === caseId);
  if (result === undefined) throw new LoadError(`no case "${caseId}" in ${resultsName}`);
  const original = prepared.cases.find((c) => c.id === caseId);
  if (original === undefined)
    throw new LoadError(`no case "${caseId}" in ${prepared.casePaths.join(', ')}`);
  if (original.customer !== undefined) {
    throw new LoadError(
      `case "${original.id}" has a simulated customer, whose turns a model writes: it can't be shrunk yet`,
    );
  }
  if (
    result.definitionSha256 !== undefined &&
    result.definitionSha256 !== definitionSha256(original)
  ) {
    throw new LoadError(
      `case "${original.id}" changed since ${resultsName} ran: the failure belongs to its old definition`,
    );
  }
  const target = pickTarget(result, check);
  if (typeof target === 'string') throw new LoadError(target);
  const source = findCaseSource(prepared.casePaths, original.id);
  const file = resolve(out ?? join(dirname(source.file), `${original.id}.min.yaml`));
  if (existsSync(file)) throw new LoadError(`${file} exists: shrink never overwrites a file`);
  return { results, original, target, source, out: file };
}

/** How a shrink ended. */
export type ShrinkOutcome =
  | {
      readonly reproduced: false;
      readonly kind: 'flaky' | 'not-reproduced';
      readonly failed: number;
      readonly samples: number;
      readonly interval: { readonly lower: number; readonly upper: number };
      readonly spentUsd: number;
    }
  | {
      readonly reproduced: true;
      readonly kind: 'minimal' | 'written';
      /** How the original's reproduction went: every sample failed. */
      readonly failed: number;
      readonly samples: number;
      readonly interval: { readonly lower: number; readonly upper: number };
      /** The kept turns' messages. */
      readonly turns: readonly string[];
      readonly before: { readonly turns: number; readonly characters: number };
      readonly after: { readonly turns: number; readonly characters: number };
      /** The candidates run after the reproduction. */
      readonly runs: number;
      readonly spentUsd: number;
      /** Why the search stopped before it was done, if it did. */
      readonly stopped?: string;
      /** The written case, for `written`. */
      readonly id?: string;
      readonly file?: string;
    };

/**
 * Reproduces the failure, then searches for the smallest failing case and
 * writes it (ADR-0035, ADR-0036). `say` gets the lines yokla shrink prints.
 */
export async function runShrink(
  planned: ShrinkPlan,
  base: Omit<RunOptions, 'cases'>,
  options: {
    readonly samples: number;
    readonly reproduce: number;
    readonly maxRuns: number;
    readonly words: boolean;
    readonly maxCost?: number | undefined;
  },
  say: (line: string) => void,
): Promise<ShrinkOutcome> {
  const { original, target, source, results } = planned;
  const { samples, reproduce, maxRuns, words, maxCost } = options;
  let spent = 0;
  let runs = 0;
  let capped: string | undefined;
  /** Runs a version of the case; undefined once the cost cap is reached. */
  const runCase = async (testCase: Case) => {
    if (maxCost !== undefined && spent >= maxCost) return undefined;
    const ran = await runSuite({
      ...base,
      cases: [testCase],
      ...(maxCost === undefined ? {} : { maxCostUsd: maxCost - spent }),
    });
    const cost = runCost(ran);
    if (cost === null && maxCost !== undefined) {
      capped = 'a recorded model call has no cost, so the cost cap can no longer hold';
      return undefined;
    }
    spent += cost ?? 0;
    if (ran.run.partial) {
      capped = `the cost cap of ${usd(maxCost ?? 0)} was reached`;
      return undefined;
    }
    return ran.cases[0];
  };

  const first = await runCase({ ...original, samples: reproduce });
  if (first === undefined) throw new LoadError(`shrink stopped before it began: ${capped ?? ''}`);
  const reproduced = reproduction(first, target);
  const rate = `${String(reproduced.failed)} of ${String(reproduced.samples)} runs failed (95 % interval ${String(reproduced.interval.lower)}–${String(reproduced.interval.upper)})`;
  if (reproduced.kind !== 'reproducible') {
    say(
      reproduced.kind === 'flaky'
        ? `  flaky: ${rate}; a flaky failure is not shrunk`
        : `  not reproduced: ${rate}`,
    );
    return {
      reproduced: false,
      kind: reproduced.kind,
      failed: reproduced.failed,
      samples: reproduced.samples,
      interval: reproduced.interval,
      spentUsd: spent,
    };
  }
  say(`  reproduced: ${rate}`);

  const trial = async (candidate: ShrinkCandidate): Promise<Trial> => {
    if (runs >= maxRuns) {
      capped ??= `--max-runs ${String(maxRuns)} was reached`;
      return 'stopped';
    }
    runs += 1;
    const ran = await runCase({
      ...original,
      turns: applyCandidate(original.turns, candidate),
      samples,
    });
    if (ran === undefined) return 'stopped';
    return stillFails(ran, target, candidate.turns.indexOf(target.turn)) ? 'fails' : 'passes';
  };
  const shrunk = await shrink(original.turns, target.turn, trial, { words });
  const turns = applyCandidate(original.turns, shrunk.candidate);
  say(`  ${String(runs)} candidates run; model cost ${usd(spent)}`);
  const stopped = shrunk.stopped ? (capped ?? 'the budget ran out') : undefined;
  if (stopped !== undefined) say(`  stopped early: ${stopped}`);
  const before = { turns: original.turns.length, characters: characters(original.turns) };
  const after = { turns: turns.length, characters: characters(turns) };
  const kept = {
    reproduced: true as const,
    failed: reproduced.failed,
    samples: reproduced.samples,
    interval: reproduced.interval,
    turns: turns.map((turn) => turn.user),
    before,
    after,
    runs,
    spentUsd: spent,
    ...(stopped === undefined ? {} : { stopped }),
  };
  const beforeText = `${String(before.turns)} turns, ${String(before.characters)} characters`;
  if (after.turns === before.turns && after.characters === before.characters) {
    say(`  already as small as it gets: ${beforeText}; nothing written`);
    return { kind: 'minimal', ...kept };
  }
  const rawTurns = Array.isArray(source.raw['turns'])
    ? source.raw['turns'].filter(
        (turn): turn is { user: string } =>
          typeof turn === 'object' &&
          turn !== null &&
          typeof Reflect.get(turn, 'user') === 'string',
      )
    : [];
  if (rawTurns.length !== original.turns.length) {
    throw new LoadError(
      `case "${original.id}": its turns in ${source.file} can't be read as written`,
    );
  }
  const from = `${original.id} in run ${results.run.id}, failing ${target.check}`;
  const { provenance: _provenance, ...rest } = source.raw;
  const id = `${original.id}-min`;
  const written = {
    ...rest,
    id,
    turns: applyCandidate(rawTurns, shrunk.candidate),
    provenance: { source: 'shrink', evidence: `shrunk from ${from}`, status: 'proposed' },
  };
  // The turns of the written case whose message was cut (ADR-0036).
  const cut = shrunk.candidate.turns.flatMap((index, position) =>
    shrunk.candidate.words.has(index) ? [position] : [],
  );
  writeFileSync(planned.out, shrunkCaseYaml(written, `shrunk from ${from}`, cut));
  say(`  ${beforeText} → ${String(after.turns)} turns, ${String(after.characters)} characters`);
  for (const turn of turns) say(`    > ${turn.user}`);
  say(`  case: ${planned.out} (proposed)`);
  return { kind: 'written', ...kept, id, file: planned.out };
}

export async function shrinkCommand(
  args: readonly string[],
  io: Output,
  version: string,
): Promise<number> {
  let values;
  try {
    values = parseArgs({ args: [...args], options: OPTIONS, strict: true }).values;
  } catch (error) {
    io.err(error instanceof Error ? error.message : String(error));
    io.err(SHRINK_HELP);
    return 2;
  }
  if (values.help === true) {
    io.out(SHRINK_HELP);
    return 0;
  }
  if (values.results === undefined || values.case === undefined) {
    io.err('--results and --case are required');
    io.err(SHRINK_HELP);
    return 2;
  }

  try {
    const samples = count(values.samples, 'samples', 3);
    const reproduce = count(values.reproduce, 'reproduce', 5);
    const maxRuns = count(values['max-runs'], 'max-runs', 64);
    const maxCost = values['max-cost'] === undefined ? undefined : Number(values['max-cost']);
    if (maxCost !== undefined && !(Number.isFinite(maxCost) && maxCost > 0)) {
      throw new LoadError('--max-cost must be a positive number of USD');
    }

    const results = readResults(values.results);
    const prepared = await prepareRun(
      {
        profile: values.profile,
        cases: values.cases,
        config: values.config,
        targetUrl: values['target-url'],
        proxyUrl: values['proxy-url'],
      },
      version,
    );
    const planned = planShrink(
      results,
      values.results,
      values.case,
      prepared,
      values.check,
      values.out,
    );
    const { original, target } = planned;

    io.out(`shrink: ${original.id}, keeping ${describeTarget(target)}`);
    const most = reproduce + maxRuns * samples;
    io.out(
      `  at most ${String(most)} runs of the case: ${String(reproduce)} to reproduce, then up to ${String(maxRuns)} candidates × ${String(samples)}`,
    );
    const words = values.words === true;
    if (words) {
      io.out(
        "  --words: a message cut to fewer words can stop asking what its turn's expectations describe; read those turns first (ADR-0036)",
      );
    }
    if (values.calibration !== undefined) {
      const estimate = plan(
        [
          {
            id: original.id,
            definitionSha256: definitionSha256(original),
            turns: original.turns.length,
            samples: most,
          },
        ],
        readResults(values.calibration),
        prepared.config?.plan.upperBoundFactor ?? 2,
      );
      io.out(
        estimate.ok
          ? `  estimate: ${usd(estimate.estimateUsd)}; upper bound: ${usd(estimate.upperUsd)} (${String(estimate.factor)}x)`
          : `  no estimate: ${estimate.problem}`,
      );
    }
    const outcome = await runShrink(
      planned,
      prepared.base,
      { samples, reproduce, maxRuns, words, maxCost },
      (line) => {
        io.out(line);
      },
    );
    return outcome.reproduced ? 0 : 1;
  } catch (error) {
    if (
      error instanceof LoadError ||
      error instanceof ResultsError ||
      error instanceof ConfigError
    ) {
      io.err(error.message);
      return 2;
    }
    throw error;
  }
}
