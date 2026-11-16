// yokla explore (ADR-0044): runs the written cases once, then small
// conversations built from them and from the domain pack's intents, and keeps
// those that reach a route, tool, argument shape or fault state no run reached
// before, or fail a check. It writes them as proposed cases, and a results
// file of the exploration with its coverage map and a trace of every
// candidate it ran (ADR-0046).
// Exit codes: 0 the search ran; 2 a configuration problem.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  type Case,
  type CaseTurn,
  type Coverage,
  DEFAULT_EXPLORE_TYPES,
  EMPTY_COVERAGE,
  explorationEvidence,
  explore,
  exploredCaseYaml,
  exploreFaults,
  type ExploreCandidate,
  type Explored,
  type ExploreOutcome,
  type ExploreResult,
  type Intents,
  type ObservedTurn,
  type Profile,
  type Results,
  summariseChecks,
} from '@yokla/core';
import { ConfigError, runSuite, type RunOptions } from '@yokla/runtime';
import { LoadError } from '../load.ts';
import { canSpend, spentBy } from '../mcp/tools.ts';
import { DOMAIN_PACKS } from '../packs.ts';
import { prepareRun } from '../prepare.ts';
import { type Output, writeReport } from './run.ts';

export const EXPLORE_HELP = `Usage: yokla explore [options]

Runs the written cases once, then conversations built from them and from the
domain pack's intents, and keeps those that reach a route, tool, argument
shape or fault state no run reached before, or fail a check. Writes them as
proposed cases, and the coverage map in the results.

Options:
  --profile <file>      the profile (default: yokla.profile.yaml)
  --cases <path>        a case file or directory; repeatable (default: cases)
  --max-runs <n>        candidates to run at most (default: 64)
  --types <n>           product types the domain pack's opening turns spread over
                        (default: ${String(DEFAULT_EXPLORE_TYPES)})
  --max-cost <usd>      stop once the model cost of the exploration reaches this;
                        required when it can spend
  --out <file>          where to write the cases (default: explored.yaml next to the profile)
  --results <file>      where to write the results (default: runs/<run id>.json)
  --config <file>       prices and check modules (default: yokla.config.yaml, when present)
  --target-url <url>    use this url instead of the profile's request url
  --proxy-url <url>     the model proxy, instead of 127.0.0.1 on modelProxy.port`;

const OPTIONS = {
  profile: { type: 'string', default: 'yokla.profile.yaml' },
  cases: { type: 'string', multiple: true },
  'max-runs': { type: 'string' },
  types: { type: 'string' },
  'max-cost': { type: 'string' },
  out: { type: 'string' },
  results: { type: 'string' },
  config: { type: 'string' },
  'target-url': { type: 'string' },
  'proxy-url': { type: 'string' },
  help: { type: 'boolean' },
} as const;

type CaseResult = Results['cases'][number];
type TurnResult = CaseResult['samples'][number]['turns'][number];

function usd(value: number): string {
  return `${value.toFixed(6)} USD`;
}

/** Each turn of a case's first sample, as the search reads it. */
function observedTurns(result: CaseResult | undefined): ObservedTurn[] {
  return (result?.samples[0]?.turns ?? []).map((turn) => ({
    user: turn.user,
    route: turn.response?.route,
    evidence: Object.fromEntries(
      Object.entries(turn.response?.evidence ?? {}).map(([name, items]) => [
        name,
        items.filter(
          (item): item is Record<string, NonNullable<(typeof items)[number]>> =>
            typeof item === 'object' && item !== null && !Array.isArray(item),
        ),
      ]),
    ),
    tools: (turn.proxy?.calls ?? []).flatMap((call) =>
      (call.toolCalls ?? []).map((asked) => asked.name),
    ),
  }));
}

/** The checks that failed on a turn, as `check (dimension)`. */
function failedOn(turn: TurnResult | undefined): string[] {
  const failed = (turn?.checks ?? []).flatMap((check) =>
    check.findings
      .filter((finding) => finding.verdict === 'fail')
      .map((finding) => `${check.check} (${finding.dimension})`),
  );
  return [...new Set(failed)];
}

function list(values: readonly string[]): string {
  return values.length === 0 ? '—' : values.join(', ');
}

/** The coverage map: what the written cases reached, and what the search added. */
function coverageLines(seeds: Coverage, result: ExploreResult): string[] {
  const all = result.coverage;
  const row = (label: string, before: readonly string[], after: readonly string[]) => {
    const added = after.filter((value) => !before.includes(value));
    return `  ${label}: ${list(before)}${added.length === 0 ? '' : `; added: ${added.join(', ')}`}`;
  };
  const unasked = all.offered.filter((tool) => !all.tools.includes(tool));
  return [
    'coverage: what the written cases reached; added: what the search reached beyond them',
    row('routes', seeds.routes, all.routes),
    row('tools', seeds.tools, all.tools),
    row('argument shapes', seeds.shapes, all.shapes),
    row('fault states', seeds.faultStates, all.faultStates),
    `  offered, never asked for: ${list(unasked)}`,
  ];
}

type ProxySummary = NonNullable<Results['run']['proxy']>;
type SpansSummary = NonNullable<Results['run']['spans']>;

function sum(x: Record<string, number>, y: Record<string, number>): Record<string, number> {
  const out = { ...x };
  for (const [key, value] of Object.entries(y)) out[key] = (out[key] ?? 0) + value;
  return out;
}

/** Two runs' proxy figures together. */
function addProxy(a: ProxySummary | undefined, b: ProxySummary | undefined) {
  if (a === undefined || b === undefined) return a ?? b;
  return {
    ...a,
    records: a.records + b.records,
    attributed: a.attributed + b.attributed,
    unattributed: a.unattributed + b.unattributed,
    totals: sum(a.totals, b.totals),
    missing: sum(a.missing, b.missing),
  };
}

/** Two runs' span figures together; settled only when both were. */
function addSpans(a: SpansSummary | undefined, b: SpansSummary | undefined) {
  if (a === undefined || b === undefined) return a ?? b;
  return {
    received: a.received + b.received,
    attributed: a.attributed + b.attributed,
    unattributed: a.unattributed + b.unattributed,
    totals: sum(a.totals, b.totals),
    missing: sum(a.missing, b.missing),
    settled: a.settled && b.settled,
  };
}

/**
 * The results of the exploration: the written cases' run, with the kept
 * candidates' cases, the model calls of every run, and the coverage map.
 */
export function explorationResults(
  seeds: Results,
  runs: readonly Results[],
  kept: readonly CaseResult[],
  result: ExploreResult,
): Results {
  const cases = [...seeds.cases, ...kept];
  let proxy = seeds.run.proxy;
  let spans = seeds.run.spans;
  for (const ran of runs) {
    proxy = addProxy(proxy, ran.run.proxy);
    spans = addSpans(spans, ran.run.spans);
  }
  const issues = [...new Set([seeds, ...runs].flatMap((ran) => ran.run.issues ?? []))];
  const last = runs.at(-1) ?? seeds;
  const statuses: Partial<Record<CaseResult['status'], number>> = {};
  for (const c of cases) statuses[c.status] = (statuses[c.status] ?? 0) + 1;
  return {
    ...seeds,
    run: {
      ...seeds.run,
      finishedAt: last.run.finishedAt,
      durationMs: Date.parse(last.run.finishedAt) - Date.parse(seeds.run.startedAt),
      partial: [seeds, ...runs].some((ran) => ran.run.partial),
      ...(proxy === undefined ? {} : { proxy }),
      ...(spans === undefined ? {} : { spans }),
      coverage: { ...result.coverage, added: [...result.added] },
      exploration: { candidates: [...result.trace] },
      ...(issues.length === 0 ? {} : { issues }),
    },
    cases,
    checks: summariseChecks(cases),
    summary: { cases: cases.length, statuses },
  };
}

/** The intents of the profile's domain pack, if it offers any. */
function intentsOf(profile: Profile, profileDir: string): Intents | undefined {
  const pack = DOMAIN_PACKS.find((candidate) => candidate.id === profile.domain);
  return pack?.prepare(profile, {
    readText: (path) => readFileSync(resolve(profileDir, path), 'utf8'),
  }).intents;
}

export async function exploreCommand(
  args: readonly string[],
  io: Output,
  version: string,
): Promise<number> {
  let values;
  try {
    values = parseArgs({ args: [...args], options: OPTIONS, strict: true }).values;
  } catch (error) {
    io.err(error instanceof Error ? error.message : String(error));
    io.err(EXPLORE_HELP);
    return 2;
  }
  if (values.help === true) {
    io.out(EXPLORE_HELP);
    return 0;
  }

  try {
    const runsValue = values['max-runs'];
    const maxRuns = runsValue === undefined ? 64 : Number(runsValue);
    if (!Number.isInteger(maxRuns) || maxRuns < 1) {
      throw new LoadError('--max-runs must be a positive integer');
    }
    const types = values.types === undefined ? DEFAULT_EXPLORE_TYPES : Number(values.types);
    if (!Number.isInteger(types) || types < 1) {
      throw new LoadError('--types must be a positive integer');
    }
    const maxCost = values['max-cost'] === undefined ? undefined : Number(values['max-cost']);
    if (maxCost !== undefined && !(Number.isFinite(maxCost) && maxCost > 0)) {
      throw new LoadError('--max-cost must be a positive number of USD');
    }
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
    const { profile } = prepared;
    if (profile.target.response.route === undefined) {
      throw new LoadError(
        'yokla explore steers by the route the target answers on: map response.route in the profile (ADR-0044)',
      );
    }
    if (maxCost === undefined && canSpend(prepared, false)) {
      throw new LoadError(
        'this exploration can spend money on model calls: run yokla explore with --max-cost <usd> (ADR-0044)',
      );
    }
    const out = resolve(values.out ?? join(prepared.profileDir, 'explored.yaml'));
    if (existsSync(out)) throw new LoadError(`${out} exists: explore never overwrites a file`);
    const written = prepared.cases.filter((c) => c.customer === undefined);
    if (written.length === 0) {
      throw new LoadError('no case with written turns to start from');
    }
    const proxied = (profile.modelProxy?.upstreams.length ?? 0) > 0;

    io.out(
      `explore: ${String(written.length)} written cases once each, then up to ${String(maxRuns)} candidates: at most ${String(written.length + maxRuns)} runs`,
    );
    const skipped = prepared.cases.length - written.length;
    if (skipped > 0) {
      io.out(`  ${String(skipped)} cases with a simulated customer are left out`);
    }
    if (!proxied) {
      io.out('  no model proxy: only routes count; no tools, argument shapes or faults');
    }

    const base: Omit<RunOptions, 'cases'> = { ...prepared.base, coverage: true };
    let spent = 0;
    let capped: string | undefined;
    /** Runs cases under what is left of the cap; undefined once it is reached. */
    const runCases = async (cases: Case[]): Promise<Results | undefined> => {
      if (maxCost !== undefined && spent >= maxCost) {
        capped ??= `the cost cap of ${usd(maxCost)} was reached`;
        return undefined;
      }
      const ran = await runSuite({
        ...base,
        cases,
        ...(maxCost === undefined ? {} : { maxCostUsd: maxCost - spent }),
      });
      const cost = spentBy(ran).usd;
      if (cost === null && maxCost !== undefined) {
        capped = 'a model call had no cost, so the cost cap can no longer hold';
      }
      spent += cost ?? 0;
      if (ran.run.partial) capped ??= `the cost cap of ${usd(maxCost ?? 0)} was reached`;
      return ran;
    };

    const seedRun = await runCases(written.map((c) => ({ ...c, samples: 1 })));
    if (seedRun === undefined) throw new LoadError('explore stopped before it began');
    const seeds: Explored[] = written.map((c) => ({
      id: c.id,
      suite: c.suite,
      language: c.language,
      turns: c.turns,
      observed: observedTurns(seedRun.cases.find((r) => r.id === c.id)),
    }));
    const seedCoverage = seedRun.run.coverage ?? EMPTY_COVERAGE;

    const runs: Results[] = [];
    const ranCases = new Map<ExploreCandidate, CaseResult>();
    const trial = async (candidate: ExploreCandidate): Promise<ExploreOutcome | 'stopped'> => {
      if (capped !== undefined) return 'stopped';
      if (runs.length >= maxRuns) {
        capped = `--max-runs ${String(maxRuns)} was reached`;
        return 'stopped';
      }
      const testCase: Case = {
        id: 'explore-candidate',
        suite: candidate.suite,
        language: candidate.language,
        turns: candidate.turns.map((turn): CaseTurn => ({ ...turn })),
        tags: [],
      };
      const ran = await runCases([testCase]);
      if (ran === undefined) return 'stopped';
      runs.push(ran);
      const result = ran.cases[0];
      if (result !== undefined) ranCases.set(candidate, result);
      return {
        coverage: ran.run.coverage ?? EMPTY_COVERAGE,
        observed: observedTurns(result),
        failed: failedOn(result?.samples[0]?.turns.at(-1)),
      };
    };
    const result = await explore(
      seeds,
      seedCoverage,
      {
        intents: intentsOf(profile, prepared.profileDir),
        // A timeout fault holds a call as long as yokla waits for the target.
        faults: proxied ? exploreFaults(profile.target.request.timeoutMs) : [],
        languages: profile.languages,
        types,
        reserved: prepared.cases.map((c) => c.id),
      },
      trial,
    );

    io.out(`  ${String(result.runs)} candidates run; model cost ${usd(spent)}`);
    if (result.stopped && capped !== undefined) io.out(`  stopped: ${capped}`);
    for (const line of coverageLines(seedCoverage, result)) io.out(line);
    const keptCases = result.kept.flatMap((kept) => {
      const ran = ranCases.get(kept.candidate);
      return ran === undefined ? [] : [{ ...ran, id: kept.id }];
    });
    const results = explorationResults(seedRun, runs, keptCases, result);
    const resultsPath = writeReport(
      values.results ?? `runs/${results.run.id}.json`,
      `${JSON.stringify(results, null, 2)}\n`,
    );
    if (result.kept.length === 0) {
      io.out('  nothing new reached and no check failed: no case written');
    } else {
      const failing = result.kept.filter((kept) => kept.failed.length > 0).length;
      io.out(
        `  kept ${String(result.kept.length)} candidates${failing === 0 ? '' : `, ${String(failing)} failing a check`}:`,
      );
      for (const kept of result.kept) io.out(`    ${kept.id}: ${explorationEvidence(kept)}`);
      writeFileSync(out, exploredCaseYaml(result));
      io.out(`  cases: ${out} (proposed)`);
    }
    io.out(`  results: ${resultsPath}`);
    return 0;
  } catch (error) {
    if (error instanceof LoadError || error instanceof ConfigError) {
      io.err(error.message);
      return 2;
    }
    throw error;
  }
}
