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
  CORE_CHECKS,
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
import { loadCheckModules } from '../checks.ts';
import {
  findCaseSource,
  LoadError,
  loadCases,
  loadConfig,
  loadProfile,
  readResults,
  ResultsError,
} from '../load.ts';
import { DOMAIN_PACKS, LANGUAGE_PACKS } from '../packs.ts';
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
    const result = results.cases.find((c) => c.id === values.case);
    if (result === undefined) throw new LoadError(`no case "${values.case}" in ${values.results}`);
    const loaded = loadProfile(values.profile);
    const casePaths = values.cases ?? [resolve(loaded.dir, 'cases')];
    const original = loadCases(casePaths).find((c) => c.id === values.case);
    if (original === undefined)
      throw new LoadError(`no case "${values.case}" in ${casePaths.join(', ')}`);
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
        `case "${original.id}" changed since ${values.results} ran: the failure belongs to its old definition`,
      );
    }
    const target = pickTarget(result, values.check);
    if (typeof target === 'string') throw new LoadError(target);
    const source = findCaseSource(casePaths, original.id);
    const out = resolve(values.out ?? join(dirname(source.file), `${original.id}.min.yaml`));
    if (existsSync(out)) throw new LoadError(`${out} exists: shrink never overwrites a file`);

    const configPath =
      values.config ?? (existsSync('yokla.config.yaml') ? 'yokla.config.yaml' : undefined);
    const config = configPath === undefined ? undefined : loadConfig(configPath);
    const own = await loadCheckModules(
      config?.checks ?? [],
      configPath ?? 'yokla.config.yaml',
      [original],
      DOMAIN_PACKS,
    );

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
        config?.plan.upperBoundFactor ?? 2,
      );
      io.out(
        estimate.ok
          ? `  estimate: ${usd(estimate.estimateUsd)}; upper bound: ${usd(estimate.upperUsd)} (${String(estimate.factor)}x)`
          : `  no estimate: ${estimate.problem}`,
      );
    }

    let spent = 0;
    let runs = 0;
    let capped: string | undefined;
    const base: Omit<RunOptions, 'cases'> = {
      profile: loaded.profile,
      profileSha256: loaded.sha256,
      profileDir: loaded.dir,
      env: process.env,
      yoklaVersion: version,
      checks: [...CORE_CHECKS, ...own.checks],
      policies: own.policies,
      checkModules: own.modules,
      packs: DOMAIN_PACKS,
      languages: LANGUAGE_PACKS,
      ...(values['target-url'] === undefined ? {} : { targetUrl: values['target-url'] }),
      ...(values['proxy-url'] === undefined ? {} : { proxyUrl: values['proxy-url'] }),
      ...(config === undefined ? {} : { prices: config.prices, models: config.models }),
    };
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
    if (reproduced.kind === 'flaky') {
      io.out(`  flaky: ${rate}; a flaky failure is not shrunk`);
      return 1;
    }
    if (reproduced.kind === 'not-reproduced') {
      io.out(`  not reproduced: ${rate}`);
      return 1;
    }
    io.out(`  reproduced: ${rate}`);

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
    io.out(`  ${String(runs)} candidates run; model cost ${usd(spent)}`);
    if (shrunk.stopped) io.out(`  stopped early: ${capped ?? 'the budget ran out'}`);
    const before = `${String(original.turns.length)} turns, ${String(characters(original.turns))} characters`;
    if (
      turns.length === original.turns.length &&
      characters(turns) === characters(original.turns)
    ) {
      io.out(`  already as small as it gets: ${before}; nothing written`);
      return 0;
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
    const { provenance: _provenance, ...kept } = source.raw;
    const written = {
      ...kept,
      id: `${original.id}-min`,
      turns: applyCandidate(rawTurns, shrunk.candidate),
      provenance: { source: 'shrink', evidence: `shrunk from ${from}`, status: 'proposed' },
    };
    // The turns of the written case whose message was cut (ADR-0036).
    const cut = shrunk.candidate.turns.flatMap((index, position) =>
      shrunk.candidate.words.has(index) ? [position] : [],
    );
    writeFileSync(out, shrunkCaseYaml(written, `shrunk from ${from}`, cut));
    io.out(`  ${before} → ${String(turns.length)} turns, ${String(characters(turns))} characters`);
    for (const turn of turns) io.out(`    > ${turn.user}`);
    io.out(`  case: ${out} (proposed)`);
    return 0;
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
