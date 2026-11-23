// yokla run: runs cases against the profile's target and writes results.v1.
// Exit codes (design §16): 0 the run completed; 2 a configuration problem or
// a case that couldn't be measured. Exit code 1 is reserved for the gate.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  ATTACKER_STRATEGIES,
  DEFAULT_ATTEMPTS,
  DEFAULT_BRANCHES,
  DEFAULT_DEPTH,
  DEFAULT_MAX_TURNS,
  MAX_BRANCHES,
  MAX_DEPTH,
  JsonPath,
  parseStrategy,
  type AttackerRun,
  type AttackerStrategy,
  TRANSFORM_KINDS,
  TransformKind,
  type Strategy,
  type ModelSwap,
  type Profile,
  type Results,
  type ToolReversal,
} from '@yokla/core';
import { ConfigError, type RewritePlan } from '@yokla/runtime';
import {
  htmlReport,
  junitReport,
  loadProject,
  run,
  terminalReport,
  type RunOptions,
} from '../api.ts';
import { LoadError } from '../load.ts';
import { readCassette } from '../prepare.ts';

export interface Output {
  out(line: string): void;
  err(line: string): void;
}

export const RUN_HELP = `Usage: yokla run [options]

Options:
  --profile <file>      the profile (default: yokla.profile.yaml)
  --cases <path>        a case file or directory; repeatable (default: cases)
  --tag <tag>           run only the cases with this tag; repeatable, a case runs when it has
                        any of them; the gate then compares only the cases that ran
  --out <file>          where to write results (default: runs/<run id>.json)
  --samples <n>         samples per case when the case doesn't say (default: 1)
  --stop-early          stop a case's samples once its failure is settled; not with target
                        logs or spans
  --record <file>       write the run's model calls to a cassette, answers in full
  --replay <file>       answer the model calls from a cassette, calling no provider
  --replay-loose        with --replay, answer a call the cassette has no match for by position
  --swap-model <swap>   <upstream>:<asked model>=<model>: send the calls that ask for a model to
                        another; =<upstream>/<model> sends them to another upstream of the same
                        kind; repeatable
  --reverse-items <tool>=<jsonpath>
                        reverse the arrays the path selects in every result of a tool before the
                        model sees it, to check that verdicts don't move; repeatable
  --transform <kind>    send each written message as users write it, to check that verdicts
                        don't move: no-diacritics, lowercase, no-punctuation or typos (one,
                        seeded by case, sample and turn); paraphrase or code-switch, written
                        by models.transform before the run (ADR-0059); repeatable
  --strategy <name>     send each message of each redteam case encoded or wrapped (ADR-0084):
                        base64, hex, rot13, morse, hidden, leetspeak, homoglyph, roleplay,
                        hypothetical or developer-mode; two in layers as <a>+<b>
  --attacker <name>     adapt each redteam case of one turn with models.attacker (ADR-0087,
                        ADR-0088): escalation (turn by turn), best-of-n (an attempt per
                        sample), iterative (each attempt from the earlier ones' answers), tree
                        (variants of variants) or translate (the profile's other languages);
                        stops at the first message a check fails
  --attempts <n>        best-of-n's and iterative's attempts (default: 4)
  --max-turns <n>       escalation's most turns (default: 5)
  --branches <n>        tree's variants of each attempt, 1 to 5 (default: 3)
  --depth <n>           tree's levels, 1 to 3 (default: 2)
  --concurrency <n>     cases run in parallel (default: 1)
  --target-url <url>    use this url instead of the profile's request url
  --junit <file>        also write a JUnit XML report
  --html <file>         also write an HTML report; it holds the target's answers
  --config <file>       prices, models and check modules (default: yokla.config.yaml, when present)
  --proxy-url <url>     the model proxy, instead of 127.0.0.1 on modelProxy.port
  --max-cost <usd>      stop starting samples once the model cost, the target's and yokla's own,
                        reaches this
  --fresh-customer      ask the customer model anew, whatever its reply cache holds
  --fresh-attacker      ask the attacker model anew, whatever its reply cache holds
  --fresh-judge         ask the judge model anew, whatever its reply cache holds (ADR-0090)`;

const SWAP_USAGE =
  '--swap-model must be <upstream>:<asked model>=<model>, or <upstream>:<asked model>=<other upstream>/<model>';

/**
 * A model swap from the command line (ADR-0042). The upstream ends at the
 * first ":", which no upstream id holds, and the asked model at the first "=".
 * `<other>/` before the model names another upstream only when the profile
 * has one by that name, so a gateway's "vendor/model" stays a model name.
 */
export function parseSwap(text: string, profile: Profile): ModelSwap {
  const colon = text.indexOf(':');
  const equals = text.indexOf('=', colon + 1);
  if (colon <= 0 || equals <= colon + 1 || equals === text.length - 1) {
    throw new LoadError(SWAP_USAGE);
  }
  const target = text.slice(equals + 1);
  const slash = target.indexOf('/');
  const upstreams = new Set((profile.modelProxy?.upstreams ?? []).map((upstream) => upstream.id));
  const to =
    slash > 0 && upstreams.has(target.slice(0, slash)) ? target.slice(0, slash) : undefined;
  const model = to === undefined ? target : target.slice(slash + 1);
  if (model === '') throw new LoadError(SWAP_USAGE);
  return {
    upstream: text.slice(0, colon),
    asked: text.slice(colon + 1, equals),
    model,
    ...(to === undefined ? {} : { to }),
  };
}

/**
 * A tool result reversal from the command line (ADR-0043): the tool ends at
 * the first "=", which no tool name holds, and the rest is a JSONPath.
 */
export function parseReversal(text: string): ToolReversal {
  const equals = text.indexOf('=');
  const at = text.slice(equals + 1);
  if (equals <= 0 || !JsonPath.safeParse(at).success) {
    throw new LoadError(
      '--reverse-items must be <tool>=<jsonpath>, such as search_products=$.results',
    );
  }
  return { tool: text.slice(0, equals), at };
}

/** An attack strategy from the command line: one, or two joined by "+" (ADR-0084). */
export function parseStrategyOption(text: string): readonly Strategy[] {
  const parsed = parseStrategy(text);
  if (typeof parsed === 'string') throw new LoadError(parsed);
  return parsed;
}

const ATTACKER_BOUNDS = ['attempts', 'max-turns', 'branches', 'depth'] as const;
type AttackerBound = (typeof ATTACKER_BOUNDS)[number];

/** The bounds each attacker strategy takes (ADR-0087, ADR-0088). */
const BOUNDS_OF: Readonly<Record<AttackerStrategy, readonly AttackerBound[]>> = {
  escalation: ['max-turns'],
  'best-of-n': ['attempts'],
  iterative: ['attempts'],
  tree: ['branches', 'depth'],
  translate: [],
};

/** A positive integer flag of at most `max`. */
function boundedInt(value: string | undefined, name: string, max: number): number | undefined {
  const number = positiveInt(value, name);
  if (number !== undefined && number > max) {
    throw new LoadError(`--${name} must be 1 to ${String(max)}`);
  }
  return number;
}

/**
 * The attacker of yokla run --attacker, with its bounds, from the command line
 * (ADR-0087, ADR-0088); --fresh-attacker goes with it, as the API's fresh.attacker.
 */
export function parseAttacker(
  values: Partial<Readonly<Record<AttackerBound | 'attacker', string | undefined>>> & {
    readonly 'fresh-attacker'?: boolean | undefined;
  },
): AttackerRun | undefined {
  const { attacker } = values;
  if (attacker === undefined) {
    for (const flag of [...ATTACKER_BOUNDS, 'fresh-attacker'] as const) {
      if (values[flag] !== undefined) throw new LoadError(`--${flag} needs --attacker`);
    }
    return undefined;
  }
  const strategy = ATTACKER_STRATEGIES.find((name) => name === attacker);
  if (strategy === undefined) {
    throw new LoadError(`--attacker must be one of ${ATTACKER_STRATEGIES.join(', ')}`);
  }
  for (const flag of ATTACKER_BOUNDS) {
    if (values[flag] !== undefined && !BOUNDS_OF[strategy].includes(flag)) {
      throw new LoadError(`--${flag} doesn't go with --attacker ${strategy}`);
    }
  }
  switch (strategy) {
    case 'escalation': {
      return {
        strategy,
        limit: positiveInt(values['max-turns'], 'max-turns') ?? DEFAULT_MAX_TURNS,
      };
    }
    case 'best-of-n':
    case 'iterative': {
      return {
        strategy,
        limit: positiveInt(values.attempts, 'attempts') ?? DEFAULT_ATTEMPTS,
      };
    }
    case 'tree': {
      return {
        strategy,
        branches: boundedInt(values.branches, 'branches', MAX_BRANCHES) ?? DEFAULT_BRANCHES,
        depth: boundedInt(values.depth, 'depth', MAX_DEPTH) ?? DEFAULT_DEPTH,
      };
    }
    case 'translate': {
      return { strategy };
    }
  }
}

/** A robustness transform from the command line (ADR-0045). */
export function parseTransform(text: string): TransformKind {
  const kind = TransformKind.safeParse(text);
  if (!kind.success) {
    throw new LoadError(`--transform must be one of ${TRANSFORM_KINDS.join(', ')}`);
  }
  return kind.data;
}

function positiveInt(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1)
    throw new LoadError(`--${name} must be a positive integer`);
  return number;
}

export function printSummary(results: Results, outPath: string, io: Output): void {
  const summary = terminalReport(results);
  for (const line of summary.out) io.out(line);
  for (const line of summary.err) io.err(line);
  io.out(`results: ${outPath}`);
}

/** Writes a file, creating its directory. */
export function writeReport(path: string, content: string): string {
  const full = resolve(path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
  return full;
}

const RUN_OPTIONS = {
  profile: { type: 'string', default: 'yokla.profile.yaml' },
  cases: { type: 'string', multiple: true },
  tag: { type: 'string', multiple: true },
  out: { type: 'string' },
  samples: { type: 'string' },
  'stop-early': { type: 'boolean' },
  record: { type: 'string' },
  replay: { type: 'string' },
  'replay-loose': { type: 'boolean' },
  'swap-model': { type: 'string', multiple: true },
  'reverse-items': { type: 'string', multiple: true },
  transform: { type: 'string', multiple: true },
  strategy: { type: 'string' },
  attacker: { type: 'string' },
  attempts: { type: 'string' },
  'max-turns': { type: 'string' },
  branches: { type: 'string' },
  depth: { type: 'string' },
  concurrency: { type: 'string' },
  'target-url': { type: 'string' },
  junit: { type: 'string' },
  html: { type: 'string' },
  config: { type: 'string' },
  'proxy-url': { type: 'string' },
  'max-cost': { type: 'string' },
  'fresh-customer': { type: 'boolean' },
  'fresh-judge': { type: 'boolean' },
  'fresh-attacker': { type: 'boolean' },
  help: { type: 'boolean' },
} as const;

/** yokla run's flags, as parseArgs reads them. */
export type RunFlags = ReturnType<typeof parseRunArgs>;

export function parseRunArgs(args: readonly string[]) {
  return parseArgs({ args: [...args], options: RUN_OPTIONS, strict: true, allowPositionals: false })
    .values;
}

/**
 * yokla run's flags as the library API's run options (ADR-0093), each checked
 * as its flag; the cassette to replay is read from its file. What the model's
 * transforms will take is printed to `io`.
 */
export function runOptionsOf(values: RunFlags, profile: Profile, io: Output): RunOptions {
  const samples = positiveInt(values.samples, 'samples');
  const concurrency = positiveInt(values.concurrency, 'concurrency');
  const maxCost = values['max-cost'] === undefined ? undefined : Number(values['max-cost']);
  if (maxCost !== undefined && !(Number.isFinite(maxCost) && maxCost > 0)) {
    throw new LoadError('--max-cost must be a positive number of USD');
  }
  if (values.record !== undefined && values.replay !== undefined) {
    throw new LoadError('--record and --replay go one at a time');
  }
  if (values['replay-loose'] === true && values.replay === undefined) {
    throw new LoadError('--replay-loose needs --replay');
  }
  // A cassette answers the model calls instead of the provider (ADR-0040).
  const replayed = values.replay === undefined ? undefined : readCassette(values.replay);
  return {
    // Only the cases with one of the tags asked for (ADR-0077).
    tags: values.tag,
    samples,
    stopEarly: values['stop-early'],
    concurrency,
    targetUrl: values['target-url'],
    proxyUrl: values['proxy-url'],
    maxCostUsd: maxCost,
    record: values.record !== undefined,
    replay:
      replayed === undefined
        ? undefined
        : { ...replayed, ...(values['replay-loose'] === true ? { loose: true } : {}) },
    // Calls that ask for a model go to another (ADR-0042).
    swaps: (values['swap-model'] ?? []).map((text) => parseSwap(text, profile)),
    // Arrays in every result of a tool, reversed before the model sees them (ADR-0043).
    reversals: (values['reverse-items'] ?? []).map(parseReversal),
    // Each written message as users write it (ADR-0045).
    transforms: (values.transform ?? []).map(parseTransform),
    // Each message of a redteam case, encoded or wrapped (ADR-0084).
    strategy: values.strategy === undefined ? undefined : parseStrategyOption(values.strategy),
    // Each redteam case of one turn, adapted by the attacker model (ADR-0087).
    attacker: parseAttacker(values),
    fresh: {
      customer: values['fresh-customer'],
      attacker: values['fresh-attacker'],
      judge: values['fresh-judge'],
    },
    // What the model's transforms will take, before any is asked (ADR-0059).
    onTransformPlan: (plan: RewritePlan) => {
      io.out(
        `transform: ${String(plan.messages)} message(s) to rewrite with ${plan.model} at ${plan.url}; their text goes there`,
      );
      io.out(
        `  ${String(plan.calls)} call(s) at most, ${String(plan.cached)} from the cache; at most ${plan.upperUsd === null ? 'an unknown cost' : `$${plan.upperUsd.toFixed(4)}`}`,
      );
    },
  };
}

export async function runCommand(args: readonly string[], io: Output): Promise<number> {
  let values: RunFlags;
  try {
    values = parseRunArgs(args);
  } catch (error) {
    io.err(error instanceof Error ? error.message : String(error));
    io.err(RUN_HELP);
    return 2;
  }
  if (values.help === true) {
    io.out(RUN_HELP);
    return 0;
  }

  try {
    const project = await loadProject({
      profile: values.profile,
      cases: values.cases,
      config: values.config,
    });
    const { results, cassette } = await run(project, runOptionsOf(values, project.profile, io));
    if (cassette !== undefined) {
      io.out(
        `cassette: ${writeReport(values.record ?? '', `${JSON.stringify(cassette)}\n`)} (${String(cassette.calls.length)} model calls; it holds their answers in full)`,
      );
    }
    const outPath = writeReport(
      values.out ?? `runs/${results.run.id}.json`,
      `${JSON.stringify(results, null, 2)}\n`,
    );
    printSummary(results, outPath, io);
    if (values.junit !== undefined)
      io.out(`junit: ${writeReport(values.junit, junitReport(results))}`);
    if (values.html !== undefined) io.out(`html: ${writeReport(values.html, htmlReport(results))}`);
    // A case that ended in error, or that the data no longer holds, didn't run (ADR-0053).
    return results.cases.some((c) => c.status === 'error' || c.status === 'fixture-missing')
      ? 2
      : 0;
  } catch (error) {
    if (error instanceof LoadError || error instanceof ConfigError) {
      io.err(error.message);
      return 2;
    }
    throw error;
  }
}
