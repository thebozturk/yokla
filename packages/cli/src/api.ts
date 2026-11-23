// The library API (ADR-0093): the steps of yokla run, gate, compare and report
// as typed functions. The commands parse their flags, find their default
// files, call these, print and choose their exit codes; the MCP server calls
// them too. The functions print nothing, never end the process, and write no
// file but a run's model caches. A problem is a LoadError, a ResultsError or a
// ConfigError; anything else is a bug.

import {
  Cassette,
  compareRuns,
  DEFAULT_ATTEMPTS,
  DEFAULT_BRANCHES,
  DEFAULT_DEPTH,
  DEFAULT_MAX_TURNS,
  evaluateGate,
  MAX_BRANCHES,
  MAX_DEPTH,
  ModelSwap,
  STRATEGIES,
  ToolReversal,
  TransformKind,
  z,
  type Baseline,
  type Comparison,
  type GateOutcome,
  type Results,
  type YoklaConfig,
} from '@yokla/core';
import { comparisonText, junitXml, terminalSummary, type TerminalSummary } from '@yokla/report';
import { runSuite, type RewritePlan } from '@yokla/runtime';
import { LoadError } from './load.ts';
import {
  loadFiles,
  projectOf,
  runnerOptions,
  type Project,
  type ProjectFiles,
  type ProjectObjects,
} from './prepare.ts';

/** Where loadProject finds a run's files; each default as yokla run takes it. */
export type LoadProjectOptions = ProjectFiles;

/**
 * Reads a run's profile, cases and configuration as yokla run does, and loads
 * the check modules the configuration names (ADR-0030). A profile with an
 * entry no person approved is refused (ADR-0047).
 */
export async function loadProject(options: LoadProjectOptions = {}): Promise<Project> {
  return loadFiles({
    profile: options.profile,
    cases: options.cases,
    config: options.config,
    cwd: options.cwd,
  });
}

/** A run's profile, cases and configuration as a person writes them, and their directory. */
export type ProjectFromOptions = ProjectObjects;

/** loadProject's work from objects, validated by the same schemas. */
export async function projectFrom(options: ProjectFromOptions): Promise<Project> {
  return projectOf(options);
}

/**
 * The cases with any of the tags (ADR-0077), in their order; every case
 * without tags given. No case left is a configuration problem: a run of
 * nothing would pass any gate.
 */
export function selectByTags<C extends { readonly tags: readonly string[] }>(
  cases: readonly C[],
  tags: readonly string[],
): C[] {
  if (tags.length === 0) return [...cases];
  const wanted = new Set(tags);
  const selected = cases.filter((c) => c.tags.some((tag) => wanted.has(tag)));
  if (selected.length === 0) {
    throw new LoadError(`no case has the tag ${tags.map((tag) => `"${tag}"`).join(' or ')}`);
  }
  return selected;
}

const Count = z.int().min(1);

/** The attacker model's strategy and its bounds, each by default as yokla run's flags (ADR-0087, ADR-0088). */
const AttackerOption = z.discriminatedUnion('strategy', [
  z.strictObject({ strategy: z.literal('escalation'), limit: Count.default(DEFAULT_MAX_TURNS) }),
  z.strictObject({ strategy: z.literal('best-of-n'), limit: Count.default(DEFAULT_ATTEMPTS) }),
  z.strictObject({ strategy: z.literal('iterative'), limit: Count.default(DEFAULT_ATTEMPTS) }),
  z.strictObject({
    strategy: z.literal('tree'),
    branches: Count.max(MAX_BRANCHES).default(DEFAULT_BRANCHES),
    depth: Count.max(MAX_DEPTH).default(DEFAULT_DEPTH),
  }),
  z.strictObject({ strategy: z.literal('translate') }),
]);

/** run's options: yokla run's flags as typed values, checked as the flags are. */
const RunOptionsSchema = z
  .strictObject({
    /** Only the cases with any of these tags (ADR-0077). */
    tags: z.array(z.string().min(1)).readonly().optional(),
    /** Samples per case when the case doesn't say. */
    samples: Count.optional(),
    /** Stop a case's samples once its failure is settled (ADR-0038). */
    stopEarly: z.boolean().optional(),
    /** Cases run in parallel. */
    concurrency: Count.optional(),
    /** The target's url, instead of the profile's request url. */
    targetUrl: z.string().min(1).optional(),
    /** The model proxy, instead of 127.0.0.1 on modelProxy.port. */
    proxyUrl: z.string().min(1).optional(),
    /** Stop starting samples once the model cost, the target's and yokla's own, reaches this. */
    maxCostUsd: z.number().positive().optional(),
    /** Record the run's model calls; the cassette comes back with the results (ADR-0040). */
    record: z.boolean().optional(),
    /** Answer the model calls from a cassette, as readCassette gives it (ADR-0040). */
    replay: z
      .strictObject({
        cassette: Cassette,
        sha256: z.string().min(1),
        loose: z.boolean().optional(),
      })
      .optional(),
    /** Calls that ask for a model go to another (ADR-0042). */
    swaps: z.array(ModelSwap).readonly().optional(),
    /** Arrays in every result of a tool, reversed before the model sees them (ADR-0043). */
    reversals: z.array(ToolReversal).readonly().optional(),
    /** Each written message as users write it (ADR-0045). */
    transforms: z.array(TransformKind).readonly().optional(),
    /** Each message of a redteam case, encoded or wrapped: one strategy, or two in layers (ADR-0084). */
    strategy: z.array(z.enum(STRATEGIES)).min(1).max(2).readonly().optional(),
    /** Each redteam case of one turn, adapted by models.attacker (ADR-0087, ADR-0088). */
    attacker: AttackerOption.optional(),
    /** Ask these models anew, whatever their reply caches hold. */
    fresh: z
      .strictObject({
        customer: z.boolean().optional(),
        attacker: z.boolean().optional(),
        judge: z.boolean().optional(),
      })
      .optional(),
    /** For {{env.NAME}} and the model keys (default: the process's). */
    env: z.record(z.string(), z.string().optional()).optional(),
    /** What the model's transforms will take, before any is asked (ADR-0059). */
    onTransformPlan: z
      .custom<(plan: RewritePlan) => void>((value) => typeof value === 'function')
      .optional(),
  })
  .superRefine((options, context) => {
    if (options.record === true && options.replay !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['record'],
        message: 'record and replay go one at a time',
      });
    }
    if (options.fresh?.attacker === true && options.attacker === undefined) {
      context.addIssue({ code: 'custom', path: ['fresh', 'attacker'], message: 'needs attacker' });
    }
  });

/** run's options: yokla run's flags as typed values. */
export type RunOptions = z.input<typeof RunOptionsSchema>;

/** run's options as checked, with each attacker bound's default. */
export type ParsedRunOptions = z.output<typeof RunOptionsSchema>;

/** The runner's options, as run gives them to it. */
type SuiteOptions = Parameters<typeof runSuite>[0];

/** run's options checked, with each attacker bound's default; a problem is a LoadError. */
export function parseRunOptions(options: unknown): ParsedRunOptions {
  const parsed = RunOptionsSchema.safeParse(options);
  if (parsed.success) return parsed.data;
  throw new LoadError(
    [
      'run options: invalid',
      ...parsed.error.issues.map(
        (issue) => `  ${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`,
      ),
    ].join('\n'),
  );
}

/** What a run gives: its results, and the cassette when it recorded one. */
export interface RunOutcome {
  readonly results: Results;
  readonly cassette?: Cassette;
}

/**
 * The runner's options for a project and run's checked options; a recording
 * run hands its cassette to `onCassette`.
 */
export function suiteOptions(
  project: Project,
  o: ParsedRunOptions,
  onCassette: (cassette: Cassette) => void,
): SuiteOptions {
  return {
    ...runnerOptions(project, { targetUrl: o.targetUrl, proxyUrl: o.proxyUrl, env: o.env }),
    cases: selectByTags(project.cases, o.tags ?? []),
    ...(o.samples === undefined ? {} : { samples: o.samples }),
    ...(o.stopEarly === true ? { stopEarly: true } : {}),
    ...(o.record === true ? { cassette: { record: true as const }, onCassette } : {}),
    ...(o.replay === undefined
      ? {}
      : {
          cassette: {
            replay: o.replay.cassette,
            sha256: o.replay.sha256,
            ...(o.replay.loose === true ? { loose: true } : {}),
          },
        }),
    ...(o.concurrency === undefined ? {} : { concurrency: o.concurrency }),
    ...(o.swaps === undefined || o.swaps.length === 0 ? {} : { swaps: o.swaps }),
    ...(o.reversals === undefined || o.reversals.length === 0 ? {} : { reversals: o.reversals }),
    ...(o.transforms === undefined || o.transforms.length === 0
      ? {}
      : { transforms: o.transforms }),
    ...(o.strategy === undefined ? {} : { strategy: o.strategy }),
    ...(o.attacker === undefined
      ? {}
      : { attacker: { ...o.attacker, ...(o.fresh?.attacker === true ? { fresh: true } : {}) } }),
    ...(o.onTransformPlan === undefined ? {} : { onTransformPlan: o.onTransformPlan }),
    ...(o.maxCostUsd === undefined ? {} : { maxCostUsd: o.maxCostUsd }),
    ...(o.fresh?.customer === true ? { freshCustomer: true } : {}),
    ...(o.fresh?.judge === true ? { freshJudge: true } : {}),
  };
}

/** Runs a project's cases against its target, as yokla run does. */
export async function run(project: Project, options: RunOptions = {}): Promise<RunOutcome> {
  let recorded: Cassette | undefined;
  const results = await runSuite(
    suiteOptions(project, parseRunOptions(options), (cassette) => {
      recorded = cassette;
    }),
  );
  return recorded === undefined ? { results } : { results, cassette: recorded };
}

/** The gate's thresholds and the baseline it compares with (ADR-0010, ADR-0011). */
export interface GateOptions {
  /** The configuration whose gate section sets the thresholds; the defaults without it. */
  readonly config?: YoklaConfig | undefined;
  /** A baseline whose passing cases must still pass. */
  readonly baseline?: Baseline | undefined;
}

/** Judges a run as yokla gate does. */
export function gate(results: Results, options: GateOptions = {}): GateOutcome {
  return evaluateGate(results, options.config?.gate, options.baseline);
}

/** Sets runs of the same cases side by side, each gated, as yokla compare does (ADR-0042). */
export function compare(runs: readonly Results[], options: GateOptions = {}): Comparison {
  if (runs.length < 2) throw new LoadError('a comparison takes two runs or more');
  return compareRuns(runs.map((results) => ({ results, gate: gate(results, options) })));
}

/** The terminal summary of a run: lines for standard output and for standard error. */
export function terminalReport(results: Results): TerminalSummary {
  return terminalSummary(results);
}

/** A run as JUnit XML. */
export function junitReport(results: Results): string {
  return junitXml(results);
}

/** A comparison's lines, as yokla compare prints them. */
export function comparisonReport(comparison: Comparison): string[] {
  return comparisonText(comparison);
}

export { htmlReport, markdownReport } from '@yokla/report';
