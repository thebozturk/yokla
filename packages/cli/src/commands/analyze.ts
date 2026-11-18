// yokla analyze (ADR-0047): proposes a profile from the target's repository,
// its data and up to three probes, at no model cost, and compares the
// proposal with a profile. It writes yokla.profile.proposed.yaml, never
// yokla.profile.yaml, and overwrites nothing without --force.
// Exit codes: 0 written; 2 a wrong option, a probe that failed, or a file
// that exists without --force.

import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  analysisReport,
  analyzeTarget,
  isDataText,
  MAX_ROWS,
  personPointers,
  planAnalysis,
  type AnalyzeOptions,
  type ModelCaller,
  type ModelPlan,
  ProbeError,
  UNREAD_CUT,
  profileDocument,
  proposalYaml,
  undecidedLine,
} from '@yokla/analyzer';
import type { OwnModel } from '@yokla/core';
import { ModelClient, ModelClientError } from '@yokla/runtime';
import { LoadError, loadConfig } from '../load.ts';
import { DOMAIN_PACKS, LANGUAGE_PACKS } from '../packs.ts';
import {
  GREETINGS,
  InitError,
  nameOf,
  parseBody,
  parseHeaders,
  parseLanguages,
  PROBE_TIMEOUT_MS,
  shown,
} from './init.ts';
import { writeReport, type Output } from './run.ts';

export const ANALYZE_HELP = `Usage: yokla analyze --url <url> [options]

Proposes a profile from the target's repository, its data and up to three
probes, for a person to review (ADR-0047). yokla makes no model call; the
target may make its own.

Options:
  --dir <path>          the target's repository (default: .)
  --url <url>           the target's chat endpoint; required
  --body <json>         the request body, with {{message}} (default: {"message": "{{message}}"})
  --header <name: value>
                        a request header; repeatable
  --session-url <url>   a request that opens the target's session
  --language <tr|en>    a language of the profile; repeatable (default: those of the
                        catalog's names, else en)
  --out <file>          where to write the proposal (default: <dir>/yokla.profile.proposed.yaml)
  --profile <file>      a profile to compare the proposal with (default:
                        <dir>/yokla.profile.yaml, when present)
  --json <file>         also write the analysis report
  --max-files <n>       list at most this many files (default: 5000)
  --data <file>         a data file from outside the repository, such as a catalog
                        export; repeatable (ADR-0065)
  --force               overwrite the proposal

With models.analyzer in the configuration, a model also reads the docs,
prompts and code for the rate limits, the cache bypass and the canonical
refusals, each value checked against the line it quotes (ADR-0049):
  --config <file>       yokla's configuration (default: yokla.config.yaml, when present)
  --max-cost <usd>      stop sending chunks once the model step's spend reaches this;
                        required with models.analyzer
  --max-tokens <n>      the most input tokens the model reads (default: 200000)
  --chunk-tokens <n>    the most tokens in one call (default: 8000)
  --estimate            print the files and the estimate, and send nothing
  --fresh-model         ask the model anew, whatever its reply cache holds`;

const OPTIONS = {
  dir: { type: 'string' },
  url: { type: 'string' },
  body: { type: 'string' },
  header: { type: 'string', multiple: true },
  'session-url': { type: 'string' },
  language: { type: 'string', multiple: true },
  out: { type: 'string' },
  profile: { type: 'string' },
  json: { type: 'string' },
  'max-files': { type: 'string' },
  data: { type: 'string', multiple: true },
  force: { type: 'boolean' },
  config: { type: 'string' },
  'max-cost': { type: 'string' },
  'max-tokens': { type: 'string' },
  'chunk-tokens': { type: 'string' },
  estimate: { type: 'boolean' },
  'fresh-model': { type: 'boolean' },
  help: { type: 'boolean' },
} as const;

/** A positive whole number from an option, or its default. */
const orUnknown = (value: number | null): string => (value === null ? 'unknown' : String(value));

/** The caller --estimate plans with: it needs no key, and sends nothing (ADR-0049). */
const NO_CALLS: ModelCaller = {
  complete: () => Promise.reject(new Error('--estimate sends nothing')),
};

function count(value: string | undefined, name: string, fallback: number): number {
  const number = Number(value ?? String(fallback));
  if (!Number.isInteger(number) || number < 1) {
    throw new InitError(`--${name} must be a positive integer`);
  }
  return number;
}

const usd = (amount: number) => `$${amount.toFixed(4)}`;

const percent = (ratio: number | null) =>
  ratio === null ? 'none' : `${(ratio * 100).toFixed(1)}%`;

export async function analyzeCommand(
  args: readonly string[],
  io: Output,
  version: string,
  cwd: string = process.cwd(),
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<number> {
  let values;
  try {
    values = parseArgs({ args: [...args], options: OPTIONS, strict: true }).values;
  } catch (error) {
    io.err(error instanceof Error ? error.message : String(error));
    io.err(ANALYZE_HELP);
    return 2;
  }
  if (values.help === true) {
    io.out(ANALYZE_HELP);
    return 0;
  }
  try {
    if (values.url === undefined) throw new InitError('--url is required: the target to probe');
    let url: URL;
    try {
      url = new URL(values.url);
    } catch {
      throw new InitError(`--url "${values.url}" is not an absolute URL`);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new InitError('analyze probes HTTP targets only');
    }
    const maxFiles = count(values['max-files'], 'max-files', 5000);
    const maxTokens = count(values['max-tokens'], 'max-tokens', 200_000);
    const chunkTokens = count(values['chunk-tokens'], 'chunk-tokens', 8000);
    const headers = parseHeaders(values.header ?? []);
    const body = parseBody(values.body ?? '{"message": "{{message}}"}');
    const given = values.language === undefined ? [] : parseLanguages(values.language);
    if (!JSON.stringify([values.url, headers, body]).includes('{{message}}')) {
      throw new InitError(
        'the request never sends {{message}}: put it in --body, --url or a --header',
      );
    }
    const dir = resolve(cwd, values.dir ?? '.');
    if (!existsSync(dir)) throw new InitError(`--dir ${values.dir ?? '.'} doesn't exist`);
    // Data from outside the repository, checked before anything is sent (ADR-0065).
    const data = (values.data ?? []).map((option) => {
      const path = resolve(cwd, option);
      if (!existsSync(path) || !statSync(path).isFile()) {
        throw new InitError(`--data ${option} doesn't exist`);
      }
      if (!isDataText(path, readFileSync(path, 'utf8'))) {
        throw new InitError(
          `--data ${option} is not a data file: JSON Lines, CSV, or a JSON array of objects`,
        );
      }
      return path;
    });
    const out = resolve(cwd, values.out ?? join(dir, 'yokla.profile.proposed.yaml'));
    const estimateOnly = values.estimate === true;
    if (!estimateOnly && existsSync(out) && values.force !== true) {
      throw new InitError(`${shown(cwd, out)} already exists; --force overwrites`);
    }
    // yokla's own model for the analysis (ADR-0049), from the configuration.
    const fallbackConfig = join(cwd, 'yokla.config.yaml');
    const configPath =
      values.config === undefined
        ? existsSync(fallbackConfig)
          ? fallbackConfig
          : undefined
        : resolve(cwd, values.config);
    const modelConfig =
      configPath === undefined ? undefined : loadConfig(configPath).models.analyzer;
    let maxCostUsd = 0;
    if (modelConfig !== undefined && !estimateOnly) {
      maxCostUsd = Number(values['max-cost']);
      if (values['max-cost'] === undefined || !(Number.isFinite(maxCostUsd) && maxCostUsd > 0)) {
        throw new InitError(
          'models.analyzer can spend: --max-cost <usd> caps it, and is required (--estimate prints what it would cost)',
        );
      }
      if (modelConfig.price === undefined) {
        throw new InitError(
          'models.analyzer has no price, so --max-cost could not be enforced: give it one, 0 for a local model',
        );
      }
    }
    const fallbackProfile = join(dir, 'yokla.profile.yaml');
    const profilePath =
      values.profile === undefined
        ? existsSync(fallbackProfile)
          ? fallbackProfile
          : undefined
        : resolve(cwd, values.profile);

    const person = { name: nameOf(url), url: values.url, headers, body, languages: given };
    const options: AnalyzeOptions = {
      dir,
      outDir: dirname(out),
      person,
      greetings: GREETINGS,
      probe: {
        env,
        timeoutMs: PROBE_TIMEOUT_MS,
        ...(values['session-url'] === undefined ? {} : { sessionUrl: values['session-url'] }),
      },
      maxFiles,
      data,
      domainPacks: DOMAIN_PACKS,
      languages: LANGUAGE_PACKS,
      onInventory: (listed) => {
        const counts = new Map<string, number>();
        for (const file of listed.files) counts.set(file.kind, (counts.get(file.kind) ?? 0) + 1);
        io.out(
          `inventory of ${shown(cwd, dir)}: ${String(listed.files.length)} files (${[...counts].map(([kind, total]) => `${kind} ${String(total)}`).join(', ')}), ${String(listed.skipped)} left out${listed.capped ? `; stopped at --max-files ${String(maxFiles)}` : ''}`,
        );
        if (data.length > 0) {
          io.out(`data given: ${data.map((path) => shown(cwd, path)).join(', ')}`);
        }
      },
      // A cut file may hold a product the probes show, which then can't be matched (ADR-0066).
      onDataCut: (paths) => {
        for (const path of paths) {
          io.out(
            `data read to its first ${String(MAX_ROWS)} rows: ${path}; a product the probes show past them can't be matched`,
          );
        }
      },
      onProbes: (messages: readonly string[]) => {
        io.out(
          `probing ${url.href}: ${String(messages.length)} message(s); the target may make its own model calls`,
        );
        for (const message of messages) io.out(`  ${message}`);
      },
      onModelPlan: (plan: ModelPlan) => {
        if (modelConfig !== undefined) printPlan(io, plan, modelConfig);
      },
      ...(modelConfig === undefined
        ? {}
        : {
            model: {
              config: modelConfig,
              caller: estimateOnly ? NO_CALLS : new ModelClient(modelConfig, env, 'analyzer'),
              maxCostUsd,
              chunkTokens,
              maxTokens,
              fresh: values['fresh-model'] === true,
              cacheDir: join(dirname(out), 'yokla-data', 'analyzer'),
            },
          }),
    };
    if (estimateOnly) {
      // Nothing is sent: no probe, no model call (ADR-0049).
      const planned = planAnalysis(options);
      if (planned.model === undefined || modelConfig === undefined) {
        io.out('no models.analyzer in the configuration: the analysis would use no model');
      } else {
        printPlan(io, planned.model, modelConfig);
      }
      io.out('--estimate: nothing was sent');
      return 0;
    }
    const analyzed = await analyzeTarget(options);
    const text = proposalYaml(analyzed.document, version);
    writeFileSync(out, text);
    io.out(`proposed ${String(analyzed.entries.length)} entries: ${shown(cwd, out)}`);
    for (const entry of analyzed.entries) {
      io.out(`  ${entry.pointer}  (${entry.provenance.source})`);
    }
    // A field the probes' match fit two or more ways: none proposed, the person picks (ADR-0068).
    for (const field of analyzed.undecided) io.out(undecidedLine(field));
    // Each contract file read, and what became of it (ADR-0057).
    for (const contract of analyzed.contracts) {
      const what = [contract.read, contract.at === undefined ? undefined : `at ${contract.at}`]
        .filter((part) => part !== undefined)
        .join(' ');
      io.out(`contract: ${contract.file}${what === '' ? '' : ` ${what}`}: ${contract.outcome}`);
      for (const detail of contract.details) io.out(`  ${detail}`);
    }
    const { model } = analyzed;
    if (model !== undefined) {
      const { summary } = model;
      io.out(
        `model: ${String(summary.calls)} call(s), ${String(summary.cached)} from the cache; ${orUnknown(summary.inputTokens)} input and ${orUnknown(summary.outputTokens)} output tokens; cost ${summary.costUsd === null ? 'unknown' : usd(summary.costUsd)}${summary.partial ? '; stopped at --max-cost' : ''}`,
      );
      for (const entry of model.unverified) {
        io.out(
          `  unverified: ${entry.field} at ${entry.file}:${String(entry.line)}: ${entry.reason}`,
        );
      }
      for (const chunk of summary.unread) {
        const raise =
          chunk.reason === UNREAD_CUT && modelConfig !== undefined
            ? `; raise models.analyzer.maxTokens, now ${String(modelConfig.maxTokens)}`
            : '';
        io.out(`  unread: ${chunk.files.join(', ')}: ${chunk.reason}${raise}`);
      }
      for (const conflict of model.conflicts) {
        io.out(`  conflict: ${conflict.pointer}: ${conflict.evidence.join('; ')}`);
      }
    } else if (modelConfig === undefined) {
      io.out('no models.analyzer in the configuration: the model step did not run');
    }

    const reference =
      profilePath === undefined
        ? undefined
        : {
            path: shown(cwd, profilePath),
            document: profileDocument(readFileSync(profilePath, 'utf8')),
          };
    const report = analysisReport({
      version,
      inventory: analyzed.inventory,
      probes: analyzed.probes,
      entries: analyzed.entries,
      proposal: analyzed.document,
      exclude: personPointers(person),
      contracts: analyzed.contracts,
      cut: analyzed.cut,
      undecided: analyzed.undecided,
      ...(reference === undefined ? {} : { reference }),
      ...(model === undefined ? {} : { model }),
    });
    const { comparison } = report;
    if (comparison !== undefined) {
      io.out(`compared with ${comparison.profile}:`);
      io.out(
        `  same ${String(comparison.same.length)}, different ${String(comparison.different.length)}, new ${String(comparison.new.length)}, missed ${String(comparison.missed.length)}`,
      );
      io.out(`  precision ${percent(comparison.precision)}, recall ${percent(comparison.recall)}`);
      const { withoutSchema } = comparison;
      if (withoutSchema !== undefined) {
        io.out(
          `  without target.response.schema: precision ${percent(withoutSchema.precision)}, recall ${percent(withoutSchema.recall)}`,
        );
      }
      for (const entry of comparison.different) io.out(`  different: ${entry.pointer}`);
      for (const entry of comparison.new) io.out(`  new: ${entry.pointer}`);
      for (const entry of comparison.missed) io.out(`  missed: ${entry.pointer}`);
    }
    if (values.json !== undefined) {
      io.out(`json: ${writeReport(values.json, `${JSON.stringify(report, null, 2)}\n`)}`);
    }
    io.out('approve each entry in its provenance, then keep the file as yokla.profile.yaml');
    return 0;
  } catch (error) {
    if (
      error instanceof InitError ||
      error instanceof ProbeError ||
      error instanceof LoadError ||
      error instanceof ModelClientError
    ) {
      io.err(error.message);
      return 2;
    }
    throw error;
  }
}

/** The model step's plan, before any call: what goes where, and what it costs at most. */
function printPlan(io: Output, plan: ModelPlan, model: OwnModel): void {
  const { estimate } = plan;
  io.out(
    `model step: ${String(plan.sent.length)} file(s) to ${model.model} at ${model.url}; their text goes there`,
  );
  if (plan.left.length > 0) io.out(`  left out by --max-tokens: ${plan.left.join(', ')}`);
  io.out(
    `  ${String(estimate.chunks)} chunk(s), about ${String(estimate.inputTokens)} input tokens, at most ${String(estimate.maxOutputTokens)} output tokens`,
  );
  io.out(
    estimate.costUsd === null || estimate.upperUsd === null
      ? '  no price: no cost figure'
      : `  estimated cost ${usd(estimate.costUsd)}, at most ${usd(estimate.upperUsd)}`,
  );
}
