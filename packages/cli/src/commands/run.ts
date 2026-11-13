// yokla run: runs cases against the profile's target and writes results.v1.
// Exit codes (design §16): 0 the run completed; 2 a configuration problem or
// a case that couldn't be measured. Exit code 1 is reserved for the gate.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { CORE_CHECKS, type Results } from '@yokla/core';
import { htmlReport, junitXml, terminalSummary } from '@yokla/report';
import { ConfigError, runSuite } from '@yokla/runtime';
import { LoadError, loadCases, loadConfig, loadProfile } from '../load.ts';
import { DOMAIN_PACKS, LANGUAGE_PACKS } from '../packs.ts';

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
  --concurrency <n>     cases run in parallel (default: 1)
  --target-url <url>    use this url instead of the profile's request url
  --junit <file>        also write a JUnit XML report
  --html <file>         also write an HTML report; it holds the target's answers
  --config <file>       prices and thresholds (default: yokla.config.yaml, when present)
  --proxy-url <url>     the model proxy, instead of 127.0.0.1 on modelProxy.port
  --max-cost <usd>      stop starting samples once the model cost reaches this; needs a proxy`;

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
  concurrency: { type: 'string' },
  'target-url': { type: 'string' },
  junit: { type: 'string' },
  html: { type: 'string' },
  config: { type: 'string' },
  'proxy-url': { type: 'string' },
  'max-cost': { type: 'string' },
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
    const loaded = loadProfile(values.profile);
    const cases = loadCases(values.cases ?? [resolve(loaded.dir, 'cases')]);
    const samples = positiveInt(values.samples, 'samples');
    const concurrency = positiveInt(values.concurrency, 'concurrency');
    const maxCost = values['max-cost'] === undefined ? undefined : Number(values['max-cost']);
    if (maxCost !== undefined && !(Number.isFinite(maxCost) && maxCost > 0)) {
      throw new LoadError('--max-cost must be a positive number of USD');
    }
    const configPath =
      values.config ?? (existsSync('yokla.config.yaml') ? 'yokla.config.yaml' : undefined);
    const config = configPath === undefined ? undefined : loadConfig(configPath);
    const results = await runSuite({
      profile: loaded.profile,
      profileSha256: loaded.sha256,
      profileDir: loaded.dir,
      cases,
      env: process.env,
      yoklaVersion: version,
      checks: CORE_CHECKS,
      packs: DOMAIN_PACKS,
      languages: LANGUAGE_PACKS,
      ...(samples === undefined ? {} : { samples }),
      ...(concurrency === undefined ? {} : { concurrency }),
      ...(values['target-url'] === undefined ? {} : { targetUrl: values['target-url'] }),
      ...(values['proxy-url'] === undefined ? {} : { proxyUrl: values['proxy-url'] }),
      ...(maxCost === undefined ? {} : { maxCostUsd: maxCost }),
      ...(config === undefined ? {} : { prices: config.prices }),
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
