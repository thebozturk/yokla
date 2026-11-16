// yokla run: runs cases against the profile's target and writes results.v1.
// Exit codes (design §16): 0 the run completed; 2 a configuration problem or
// a case that couldn't be measured. Exit code 1 is reserved for the gate.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  JsonPath,
  type Cassette,
  type ModelSwap,
  type Profile,
  type Results,
  type ToolReversal,
} from '@yokla/core';
import { htmlReport, junitXml, terminalSummary } from '@yokla/report';
import { ConfigError, runSuite } from '@yokla/runtime';
import { LoadError } from '../load.ts';
import { prepareRun, readCassette } from '../prepare.ts';

export interface Output {
  out(line: string): void;
  err(line: string): void;
}

export const RUN_HELP = `Usage: yokla run [options]

Options:
  --profile <file>      the profile (default: yokla.profile.yaml)
  --cases <path>        a case file or directory; repeatable (default: cases)
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
  --concurrency <n>     cases run in parallel (default: 1)
  --target-url <url>    use this url instead of the profile's request url
  --junit <file>        also write a JUnit XML report
  --html <file>         also write an HTML report; it holds the target's answers
  --config <file>       prices, models and check modules (default: yokla.config.yaml, when present)
  --proxy-url <url>     the model proxy, instead of 127.0.0.1 on modelProxy.port
  --max-cost <usd>      stop starting samples once the model cost, the target's and yokla's own,
                        reaches this
  --fresh-customer      ask the customer model anew, whatever its reply cache holds`;

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

function positiveInt(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1)
    throw new LoadError(`--${name} must be a positive integer`);
  return number;
}

export function printSummary(results: Results, outPath: string, io: Output): void {
  const summary = terminalSummary(results);
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
  out: { type: 'string' },
  samples: { type: 'string' },
  'stop-early': { type: 'boolean' },
  record: { type: 'string' },
  replay: { type: 'string' },
  'replay-loose': { type: 'boolean' },
  'swap-model': { type: 'string', multiple: true },
  'reverse-items': { type: 'string', multiple: true },
  concurrency: { type: 'string' },
  'target-url': { type: 'string' },
  junit: { type: 'string' },
  html: { type: 'string' },
  config: { type: 'string' },
  'proxy-url': { type: 'string' },
  'max-cost': { type: 'string' },
  'fresh-customer': { type: 'boolean' },
  help: { type: 'boolean' },
} as const;

function parseRunArgs(args: readonly string[]) {
  return parseArgs({ args: [...args], options: RUN_OPTIONS, strict: true, allowPositionals: false })
    .values;
}

export async function runCommand(
  args: readonly string[],
  io: Output,
  version: string,
): Promise<number> {
  let values: ReturnType<typeof parseRunArgs>;
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
    // Calls that ask for a model go to another (ADR-0042).
    const swaps = (values['swap-model'] ?? []).map((text) => parseSwap(text, prepared.profile));
    // Arrays in every result of a tool, reversed before the model sees them (ADR-0043).
    const reversals = (values['reverse-items'] ?? []).map(parseReversal);
    const results = await runSuite({
      ...prepared.base,
      cases: [...prepared.cases],
      ...(samples === undefined ? {} : { samples }),
      ...(values['stop-early'] === true ? { stopEarly: true } : {}),
      ...(values.record === undefined
        ? {}
        : {
            cassette: { record: true as const },
            onCassette: (cassette: Cassette) => {
              io.out(
                `cassette: ${writeReport(values.record ?? '', `${JSON.stringify(cassette)}\n`)} (${String(cassette.calls.length)} model calls; it holds their answers in full)`,
              );
            },
          }),
      ...(replayed === undefined
        ? {}
        : {
            cassette: {
              replay: replayed.cassette,
              sha256: replayed.sha256,
              ...(values['replay-loose'] === true ? { loose: true } : {}),
            },
          }),
      ...(concurrency === undefined ? {} : { concurrency }),
      ...(swaps.length === 0 ? {} : { swaps }),
      ...(reversals.length === 0 ? {} : { reversals }),
      ...(maxCost === undefined ? {} : { maxCostUsd: maxCost }),
      ...(values['fresh-customer'] === true ? { freshCustomer: true } : {}),
    });
    const outPath = writeReport(
      values.out ?? `runs/${results.run.id}.json`,
      `${JSON.stringify(results, null, 2)}\n`,
    );
    printSummary(results, outPath, io);
    if (values.junit !== undefined)
      io.out(`junit: ${writeReport(values.junit, junitXml(results))}`);
    if (values.html !== undefined) io.out(`html: ${writeReport(values.html, htmlReport(results))}`);
    return results.cases.some((c) => c.status === 'error') ? 2 : 0;
  } catch (error) {
    if (error instanceof LoadError || error instanceof ConfigError) {
      io.err(error.message);
      return 2;
    }
    throw error;
  }
}
