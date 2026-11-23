// The tools yokla mcp offers a coding agent (ADR-0041): list the cases, run
// them, explain a failing case, shrink it, and verify a fix against it and its
// neighbours. The person fixes the profile, cases, configuration and target
// when the server starts; no tool takes a path or a url. One session cap
// covers every run, and tool calls run one at a time.

import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  CaseStatus,
  FindingOrigin,
  FindingSubject,
  pickTarget,
  reviewStatus,
  z,
  type CaseResult,
  type Results,
  type ShrinkTarget,
} from '@yokla/core';
import { ConfigError, definitionSha256 } from '@yokla/runtime';
import { run as runProject, type RunOptions } from '../api.ts';
import { planShrink, runShrink } from '../commands/shrink.ts';
import { writeReport } from '../commands/run.ts';
import { LoadError, readResults, ResultsError } from '../load.ts';
import {
  loadFiles,
  readCassette,
  runnerOptions,
  type Project,
  type ProjectFiles,
  type ReadCassette,
} from '../prepare.ts';
import { ToolError, type McpTool } from './protocol.ts';

/** What the person fixed when the server started. */
export interface SessionSettings extends ProjectFiles {
  readonly targetUrl?: string | undefined;
  readonly proxyUrl?: string | undefined;
  /** Where every run's results file goes. */
  readonly out: string;
  /** The session's cost cap, over every run (ADR-0041). */
  readonly maxCostUsd?: number | undefined;
  /** A cassette every run of the session replays (ADR-0040). */
  readonly replay?: string | undefined;
  readonly replayLoose?: boolean | undefined;
}

/** An answer's text in a tool result is cut here (ADR-0041). */
export const TEXT_LIMIT = 4000;

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/u;

const RunId = z.string().regex(RUN_ID).meta({ description: 'A run id that run_cases returned.' });
const CaseId = z.string().min(1);
const Count = z.int().min(1).max(100);

const Failing = z.object({
  sample: z.int(),
  turn: z.int(),
  check: z.string(),
  dimension: z.string(),
  severity: z.string(),
  message: z.string(),
  subject: FindingSubject.optional(),
  origin: FindingOrigin.optional(),
});
type Failing = z.output<typeof Failing>;

const Cost = z.object({
  /** What this call spent; null when a model call had no cost. */
  spentUsd: z.number().nullable(),
  sessionSpentUsd: z.number(),
  /** What the session cap leaves; absent without a cap. */
  remainingUsd: z.number().optional(),
  /** Set when the target's cost can't be counted: no model proxy. */
  note: z.string().optional(),
});

const CaseSummary = z.object({
  id: z.string(),
  status: CaseStatus,
  /** A case a person hasn't approved yet: it runs, but doesn't gate (ADR-0004). */
  proposed: z.boolean().optional(),
  failing: z.array(Failing),
  error: z.string().optional(),
});

/** Every failing finding of a case, in sample, turn and check order. */
function failingOf(result: CaseResult): Failing[] {
  return result.samples.flatMap((sample) =>
    sample.turns.flatMap((turn, index) =>
      turn.checks.flatMap((check) =>
        check.findings
          .filter((finding) => finding.verdict === 'fail')
          .map((finding) => ({
            sample: sample.index,
            turn: index,
            check: check.check,
            dimension: finding.dimension,
            severity: finding.severity,
            message: finding.message,
            ...(finding.subject === undefined ? {} : { subject: finding.subject }),
            ...(finding.origin === undefined ? {} : { origin: finding.origin }),
          })),
      ),
    ),
  );
}

function summaryOf(result: CaseResult): z.output<typeof CaseSummary> {
  const error = result.samples
    .flatMap((sample) => sample.turns)
    .find((turn) => turn.error !== undefined)?.error;
  return {
    id: result.id,
    status: result.status,
    ...(result.review === 'proposed' ? { proposed: true } : {}),
    failing: failingOf(result),
    ...(error === undefined ? {} : { error }),
  };
}

/** A text cut at the limit, and whether it was. */
function bounded(text: string | undefined): { text?: string; cut?: true } {
  if (text === undefined) return {};
  return text.length > TEXT_LIMIT ? { text: text.slice(0, TEXT_LIMIT), cut: true } : { text };
}

/** An evidence collection shows at most this many items in a tool result. */
export const EVIDENCE_LIMIT = 20;

/** A turn's mapped evidence, each collection cut at the limit. */
function boundedEvidence(evidence: Record<string, readonly unknown[]>) {
  const cut = Object.entries(evidence).filter(([, items]) => items.length > EVIDENCE_LIMIT);
  return {
    evidence: Object.fromEntries(
      Object.entries(evidence).map(([name, items]) => [name, items.slice(0, EVIDENCE_LIMIT)]),
    ),
    ...(cut.length === 0 ? {} : { evidenceCut: cut.map(([name]) => name) }),
  };
}

/** Whether a case's results still fail the target: its check, in its dimension, anywhere. */
function failsTarget(result: CaseResult, target: ShrinkTarget): boolean {
  return failingOf(result).some(
    (finding) => finding.check === target.check && finding.dimension === target.dimension,
  );
}

/** The model cost a run spent, apart from what its cap left uncounted. */
export function spentBy(results: Results): { usd: number | null; targetUnknown: boolean } {
  const own = results.run.own?.costUsd;
  if (own === null) return { usd: null, targetUnknown: false };
  // A replayed call reached no provider (ADR-0040).
  if (results.run.replay !== undefined) return { usd: own ?? 0, targetUnknown: false };
  const target = results.run.proxy ?? results.run.spans;
  if (target === undefined) return { usd: own ?? 0, targetUnknown: true };
  if ((target.missing['costUsd'] ?? 0) > 0) return { usd: null, targetUnknown: false };
  return { usd: (target.totals['costUsd'] ?? 0) + (own ?? 0), targetUnknown: false };
}

/** Whether a session with these files can spend money on model calls (ADR-0041). */
export function canSpend(prepared: Project, replaying: boolean): boolean {
  const proxy = prepared.profile.modelProxy;
  const target =
    !replaying && proxy !== undefined && (proxy.upstreams.length > 0 || proxy.spans !== undefined);
  return target || prepared.config?.models.customer !== undefined;
}

export class Session {
  readonly #settings: SessionSettings;
  #spent = 0;
  /** Why the cap can no longer hold, once a call had no cost. */
  #broken: string | undefined;
  #targetUnknown = false;
  #queue: Promise<unknown> = Promise.resolve();
  /** The case files shrink_case wrote: they count at the next call (ADR-0041). */
  readonly #written: string[] = [];

  constructor(settings: SessionSettings) {
    this.#settings = settings;
  }

  /** Runs one tool call after those before it: the proxy records one run at a time. */
  exclusive<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(work, work);
    this.#queue = next.catch(() => undefined);
    return next;
  }

  /** Loads the files again, as a CLI command would at each call. */
  async prepare(): Promise<Project> {
    try {
      return await loadFiles({ ...this.#settings, alsoCases: this.#written });
    } catch (error) {
      throw asToolError(error);
    }
  }

  /** The cap a paid call may still spend; refuses once none is left. */
  allowance(): number | undefined {
    const cap = this.#settings.maxCostUsd;
    if (this.#broken !== undefined) {
      throw new ToolError(`the session's cost cap can no longer hold: ${this.#broken}`);
    }
    if (cap === undefined) return undefined;
    const left = cap - this.#spent;
    if (left <= 0) {
      throw new ToolError(
        `the session's cost cap of ${String(cap)} USD is spent; start yokla mcp again with a higher --max-cost`,
      );
    }
    return left;
  }

  /** Counts a run's spend against the session, and says what is left. */
  account(spentUsd: number | null, targetUnknown: boolean): z.output<typeof Cost> {
    if (spentUsd === null) {
      this.#broken = 'a model call had no cost';
    } else {
      this.#spent += spentUsd;
    }
    if (targetUnknown) this.#targetUnknown = true;
    const cap = this.#settings.maxCostUsd;
    return {
      spentUsd,
      sessionSpentUsd: this.#spent,
      ...(cap === undefined ? {} : { remainingUsd: Math.max(0, cap - this.#spent) }),
      ...(this.#targetUnknown
        ? { note: "without a model proxy, the target's cost is unknown and isn't counted" }
        : {}),
    };
  }

  /** The cassette every run replays, if the session was started with one. */
  replay(): (ReadCassette & { loose?: boolean }) | undefined {
    const path = this.#settings.replay;
    if (path === undefined) return undefined;
    return {
      ...readCassette(path),
      ...(this.#settings.replayLoose === true ? { loose: true } : {}),
    };
  }

  /** Where the session's runs send their turns. */
  reach(): { targetUrl?: string | undefined; proxyUrl?: string | undefined } {
    return { targetUrl: this.#settings.targetUrl, proxyUrl: this.#settings.proxyUrl };
  }

  /** A run's options in this session, as the library API takes them (ADR-0093). */
  runOptions(
    options: { samples?: number | undefined; stopEarly?: boolean | undefined },
    allowance: number | undefined,
  ): RunOptions {
    return {
      ...this.reach(),
      replay: this.replay(),
      samples: options.samples,
      stopEarly: options.stopEarly,
      maxCostUsd: allowance,
    };
  }

  /** Notes a case file the session wrote, to load with the cases from then on. */
  wrote(file: string): void {
    if (!this.#written.includes(file)) this.#written.push(file);
  }

  replaying(): boolean {
    return this.#settings.replay !== undefined;
  }

  /** Writes a run's results where the session keeps them; returns their path. */
  write(results: Results): string {
    return writeReport(
      join(this.#settings.out, `${results.run.id}.json`),
      `${JSON.stringify(results, null, 2)}\n`,
    );
  }

  /** The results of a run the session's out directory holds. */
  read(run: string): { results: Results; path: string } {
    const path = resolve(this.#settings.out, `${run}.json`);
    if (!existsSync(path)) throw new ToolError(`no run "${run}": run_cases returns run ids`);
    try {
      return { results: readResults(path), path };
    } catch (error) {
      throw asToolError(error);
    }
  }
}

function asToolError(error: unknown): unknown {
  return error instanceof LoadError || error instanceof ResultsError || error instanceof ConfigError
    ? new ToolError(error.message)
    : error;
}

/** The cases a run takes, by id, in the order the files hold them. */
function selected(prepared: Project, ids: readonly string[] | undefined) {
  if (ids === undefined) return [...prepared.cases];
  const known = new Set(prepared.cases.map((c) => c.id));
  const missing = ids.filter((id) => !known.has(id));
  if (missing.length > 0) {
    throw new ToolError(
      `no case ${missing.map((id) => `"${id}"`).join(', ')}: list_cases lists them`,
    );
  }
  const wanted = new Set(ids);
  return prepared.cases.filter((c) => wanted.has(c.id));
}

const ListInput = z.strictObject({});
const ListOutput = z.object({
  cases: z.array(
    z.object({
      id: z.string(),
      suite: z.string(),
      title: z.string().optional(),
      language: z.string(),
      turns: z.int().optional(),
      customer: z.boolean().optional(),
      review: z.enum(['proposed', 'approved', 'rejected']),
    }),
  ),
});

const RunInput = z.strictObject({
  cases: z
    .array(CaseId)
    .min(1)
    .optional()
    .meta({ description: 'Case ids; every case by default.' }),
  samples: Count.optional().meta({ description: "Samples per case, when the case doesn't say." }),
  stopEarly: z.boolean().optional().meta({
    description: "Stop a case's samples once its failure is settled (ADR-0038).",
  }),
});
const RunOutput = z.object({
  run: z.string(),
  results: z.string(),
  partial: z.boolean(),
  /** Every case's status, proposed cases included. */
  statuses: z.record(z.string(), z.int()),
  /** The statuses of the proposed cases alone: they don't gate until a person approves them. */
  proposed: z.record(z.string(), z.int()).optional(),
  notPassed: z.array(CaseSummary),
  issues: z.array(z.string()),
  cost: Cost,
});

const ExplainInput = z.strictObject({
  run: RunId,
  case: CaseId,
  sample: z.int().min(0).optional().meta({
    description: 'The sample to show; by default the first with a failing finding or an error.',
  }),
});
const Call = z.object({
  model: z.string().nullable(),
  status: z.int().nullable(),
  inputTokens: z.int().nullable(),
  outputTokens: z.int().nullable(),
  costUsd: z.number().nullable(),
  fault: z.object({ kind: z.string(), applied: z.boolean() }).optional(),
  replayed: z.boolean().optional(),
  /** The messages as the profile's prompts.store keeps them (ADR-0015). */
  prompt: z
    .array(
      z.object({
        role: z.string(),
        chars: z.int(),
        text: z.string().optional(),
        cut: z.boolean().optional(),
      }),
    )
    .nullable()
    .optional(),
  /** The model's answer as prompts.store keeps it (ADR-0033). */
  output: z
    .object({ chars: z.int(), text: z.string().optional(), cut: z.boolean().optional() })
    .nullable()
    .optional(),
});
const ExplainOutput = z.object({
  run: z.string(),
  case: z.string(),
  status: CaseStatus,
  failingDimensions: z.array(z.string()),
  sample: z.int(),
  samples: z.int(),
  turns: z.array(
    z.object({
      turn: z.int(),
      user: z.string(),
      answer: z
        .object({
          status: z.int(),
          route: z.string().optional(),
          text: z.string().optional(),
          cut: z.boolean().optional(),
          /** What the profile mapped from the answer, such as products and their prices. */
          evidence: z.record(z.string(), z.array(z.json())).optional(),
          /** The collections cut at their first items. */
          evidenceCut: z.array(z.string()).optional(),
        })
        .optional(),
      error: z.string().optional(),
      failing: z.array(Failing),
      calls: z.array(Call),
    }),
  ),
});

const ShrinkInput = z.strictObject({
  run: RunId,
  case: CaseId,
  check: z.string().optional().meta({
    description: 'The failing check to keep; by default the first deciding failure.',
  }),
  samples: Count.optional().meta({ description: 'Runs of each candidate; default 3.' }),
  reproduce: Count.optional().meta({ description: 'Runs of the original first; default 5.' }),
  maxRuns: z
    .int()
    .min(1)
    .max(512)
    .optional()
    .meta({ description: 'Candidates at most; default 64.' }),
  words: z.boolean().optional().meta({
    description:
      "Also cut messages to their fewest words; a cut message can stop asking what its turn's expectations describe (ADR-0036).",
  }),
});
const ShrinkOutput = z.object({
  outcome: z.enum(['written', 'minimal', 'flaky', 'not-reproduced']),
  target: z.object({
    check: z.string(),
    dimension: z.string(),
    turn: z.int(),
    stage: z.string().optional(),
  }),
  case: z.string().optional(),
  file: z.string().optional(),
  turns: z.array(z.string()).optional(),
  before: z.object({ turns: z.int(), characters: z.int() }).optional(),
  after: z.object({ turns: z.int(), characters: z.int() }).optional(),
  /** How many of the original's reproduction runs failed, with the rate's 95 % interval. */
  failureRate: z
    .object({ failed: z.int(), samples: z.int(), lower: z.number(), upper: z.number() })
    .optional(),
  /** How many smaller candidates ran, each `samples` times. */
  candidates: z.int().optional(),
  stopped: z.string().optional(),
  cost: Cost,
});

const VerifyInput = z.strictObject({
  run: RunId,
  case: CaseId,
  check: z.string().optional().meta({
    description: 'The failing check the fix is for; by default the first deciding failure.',
  }),
  samples: Count.optional().meta({ description: "Samples per case, when the case doesn't say." }),
});
const VerifyOutput = z.object({
  fixed: z.boolean(),
  /** The session's cap stopped the run before every case ran: nothing is claimed fixed. */
  partial: z.boolean(),
  run: z.string(),
  results: z.string(),
  target: z.object({ check: z.string(), dimension: z.string() }),
  /** The case and its shrunk case, and whether each still fails the target. */
  checked: z.array(z.object({ id: z.string(), status: CaseStatus, failsTarget: z.boolean() })),
  /** Every case this check ran, with its status in the run given (absent: it didn't run there). */
  ran: z.array(z.object({ id: z.string(), before: CaseStatus.optional(), now: CaseStatus })),
  /** Cases that passed in the run given and don't now. */
  regressions: z.array(CaseSummary),
  /**
   * Cases whose definition (turns, expectations, samples or checks) changed
   * since the run given: their statuses aren't compared.
   */
  changed: z.array(z.string()),
  /**
   * Cases of other suites that didn't pass in the run given. verify_fix doesn't
   * run them, so `fixed` says nothing about them: run_cases checks them.
   */
  otherNotPassing: z.array(z.object({ id: z.string(), suite: z.string(), status: CaseStatus })),
  issues: z.array(z.string()),
  cost: Cost,
});

/** The five tools, over one session (ADR-0041). */
export function sessionTools(session: Session): McpTool[] {
  /** Runs cases as yokla run does, against the session's cap; writes the results. */
  const runCases = async (
    prepared: Project,
    cases: Project['cases'],
    options: { samples?: number | undefined; stopEarly?: boolean | undefined },
  ) => {
    const allowance = session.allowance();
    let results: Results;
    try {
      ({ results } = await runProject(
        { ...prepared, cases },
        session.runOptions(options, allowance),
      ));
    } catch (error) {
      throw asToolError(error);
    }
    const path = session.write(results);
    const spent = spentBy(results);
    return { results, path, cost: session.account(spent.usd, spent.targetUnknown) };
  };

  return [
    {
      name: 'list_cases',
      description:
        "Lists the session's cases: id, suite, title, language, number of turns, and review status. A proposed case runs but doesn't gate until a person approves it.",
      input: ListInput,
      output: ListOutput,
      call: () =>
        session.exclusive(async () => {
          const prepared = await session.prepare();
          return {
            cases: prepared.cases.map((c) => ({
              id: c.id,
              suite: c.suite,
              ...(c.title === undefined ? {} : { title: c.title }),
              language: c.language,
              ...(c.customer === undefined ? { turns: c.turns.length } : { customer: true }),
              review: reviewStatus(c),
            })),
          };
        }),
    },
    {
      name: 'run_cases',
      description:
        "Runs cases against the session's target, as yokla run does, and returns the run id, the statuses, and each case that didn't pass with its failing findings: check, dimension, message, the value it is about and where that value arose (in what the model was sent, in the model's answer, or in the app). Model calls count against the session's cost cap.",
      input: RunInput,
      output: RunOutput,
      call: (input) =>
        session.exclusive(async () => {
          const { cases, samples, stopEarly } = RunInput.parse(input);
          const prepared = await session.prepare();
          const ran = await runCases(prepared, selected(prepared, cases), { samples, stopEarly });
          const statuses = Object.fromEntries(
            Object.entries(ran.results.summary.statuses).flatMap(([status, n]) =>
              n === undefined ? [] : [[status, n]],
            ),
          );
          const proposed: Record<string, number> = {};
          for (const c of ran.results.cases) {
            if (c.review === 'proposed') proposed[c.status] = (proposed[c.status] ?? 0) + 1;
          }
          return {
            run: ran.results.run.id,
            results: ran.path,
            partial: ran.results.run.partial,
            statuses,
            ...(Object.keys(proposed).length === 0 ? {} : { proposed }),
            notPassed: ran.results.cases
              .filter((c) => c.status !== 'pass')
              .map((c) => summaryOf(c)),
            issues: ran.results.run.issues ?? [],
            cost: ran.cost,
          };
        }),
    },
    {
      name: 'explain_finding',
      description:
        "Shows one case of a run, turn by turn: the user's message; the answer's text, route, status and the evidence the profile maps from it, such as the products and prices a check compares with; the failing findings with where their value arose; and the turn's model calls by model, tokens, cost and fault. Prompts and the model's answers appear only as far as the profile's prompts.store keeps them. Costs nothing.",
      input: ExplainInput,
      output: ExplainOutput,
      call: (input) =>
        session.exclusive(async () => {
          const { run, case: id, sample } = ExplainInput.parse(input);
          const { results } = session.read(run);
          const result = results.cases.find((c) => c.id === id);
          if (result === undefined) throw new ToolError(`no case "${id}" in run ${run}`);
          const failing = failingOf(result);
          const index =
            sample ??
            failing[0]?.sample ??
            result.samples.find((s) => s.turns.some((turn) => turn.error !== undefined))?.index ??
            0;
          const shown = result.samples.find((s) => s.index === index);
          if (shown === undefined) {
            throw new ToolError(
              `case "${id}" ran ${String(result.samples.length)} sample(s) in run ${run}, from 0`,
            );
          }
          return {
            run,
            case: id,
            status: result.status,
            failingDimensions: result.dimensions
              .filter((d) => d.verdict === 'fail')
              .map((d) => d.dimension),
            sample: index,
            samples: result.samples.length,
            turns: shown.turns.map((turn, position) => {
              const answer = turn.response;
              const text = bounded(answer?.text);
              return {
                turn: position,
                user: turn.user,
                ...(answer === undefined
                  ? {}
                  : {
                      answer: {
                        status: answer.status,
                        ...(answer.route === undefined ? {} : { route: answer.route }),
                        ...text,
                        ...(Object.keys(answer.evidence).length === 0
                          ? {}
                          : boundedEvidence(answer.evidence)),
                      },
                    }),
                ...(turn.error === undefined ? {} : { error: turn.error }),
                failing: failing.filter((f) => f.sample === index && f.turn === position),
                calls: (turn.proxy?.calls ?? []).map((call) => ({
                  model: call.model,
                  status: call.status,
                  inputTokens: call.usage.input,
                  outputTokens: call.usage.output,
                  costUsd: call.costUsd,
                  ...(call.fault === undefined ? {} : { fault: call.fault }),
                  ...(call.replay === undefined ? {} : { replayed: true }),
                  ...(call.prompt === undefined
                    ? {}
                    : {
                        prompt:
                          call.prompt === null
                            ? null
                            : call.prompt.map((m) => ({
                                role: m.role,
                                chars: m.chars,
                                ...bounded(m.text),
                              })),
                      }),
                  ...(call.output === undefined
                    ? {}
                    : {
                        output:
                          call.output === null
                            ? null
                            : { chars: call.output.chars, ...bounded(call.output.text) },
                      }),
                })),
              };
            }),
          };
        }),
    },
    {
      name: 'shrink_case',
      description:
        "Cuts a failing case of a run down to the fewest turns that still fail the same check, as yokla shrink does, and writes it as a proposed case <id>-min, in a new file <id>.min.yaml next to the original case's file. The original runs `reproduce` times first: `failureRate` says how many failed, and a failure that comes and goes is reported as flaky, not shrunk. `candidates` says how many smaller versions ran, each `samples` times. Model calls count against the session's cost cap.",
      input: ShrinkInput,
      output: ShrinkOutput,
      call: (input) =>
        session.exclusive(async () => {
          const args = ShrinkInput.parse(input);
          if (session.replaying()) {
            throw new ToolError(
              "a shrink can't run on a cassette: its candidates' turns and samples aren't the recorded ones (ADR-0040)",
            );
          }
          const { results } = session.read(args.run);
          const prepared = await session.prepare();
          const allowance = session.allowance();
          const planned = (() => {
            try {
              return planShrink(results, `run ${args.run}`, args.case, prepared, args.check);
            } catch (error) {
              throw asToolError(error);
            }
          })();
          const outcome = await runShrink(
            planned,
            runnerOptions(prepared, session.reach()),
            {
              samples: args.samples ?? 3,
              reproduce: args.reproduce ?? 5,
              maxRuns: args.maxRuns ?? 64,
              words: args.words === true,
              maxCost: allowance,
            },
            () => undefined,
          ).catch((error: unknown) => {
            throw asToolError(error);
          });
          const cost = session.account(outcome.spentUsd, prepared.profile.modelProxy === undefined);
          const target = {
            check: planned.target.check,
            dimension: planned.target.dimension,
            turn: planned.target.turn,
            ...(planned.target.stage === undefined ? {} : { stage: planned.target.stage }),
          };
          if (outcome.reproduced && outcome.file !== undefined) session.wrote(outcome.file);
          if (!outcome.reproduced) {
            return {
              outcome: outcome.kind,
              target,
              failureRate: {
                failed: outcome.failed,
                samples: outcome.samples,
                lower: outcome.interval.lower,
                upper: outcome.interval.upper,
              },
              cost,
            };
          }
          return {
            outcome: outcome.kind,
            target,
            failureRate: {
              failed: outcome.failed,
              samples: outcome.samples,
              lower: outcome.interval.lower,
              upper: outcome.interval.upper,
            },
            candidates: outcome.runs,
            ...(outcome.id === undefined ? {} : { case: outcome.id }),
            ...(outcome.file === undefined ? {} : { file: outcome.file }),
            turns: [...outcome.turns],
            before: outcome.before,
            after: outcome.after,
            ...(outcome.stopped === undefined ? {} : { stopped: outcome.stopped }),
            cost,
          };
        }),
    },
    {
      name: 'verify_fix',
      description:
        "Checks a fix: runs a failing case of a run again, with its shrunk case <id>-min when the cases hold one, and the other cases of its suite. `fixed` is true when neither the case nor its shrunk case still fails the target check, and the run wasn't cut short; it says nothing about other suites, whose cases that didn't pass are listed in `otherNotPassing` for run_cases to check. `ran` lists every case it ran, with its status then and now; `regressions` lists each that passed in the run given and doesn't now; `changed` lists cases whose definition changed since that run, which aren't compared. Model calls count against the session's cost cap.",
      input: VerifyInput,
      output: VerifyOutput,
      call: (input) =>
        session.exclusive(async () => {
          const args = VerifyInput.parse(input);
          const { results: before } = session.read(args.run);
          const original = before.cases.find((c) => c.id === args.case);
          if (original === undefined) {
            throw new ToolError(`no case "${args.case}" in run ${args.run}`);
          }
          const target = pickTarget(original, args.check);
          if (typeof target === 'string') throw new ToolError(target);
          const prepared = await session.prepare();
          const shrunkId = `${args.case}-min`;
          const ids = new Set([
            args.case,
            ...prepared.cases.filter((c) => c.id === shrunkId).map((c) => c.id),
            ...before.cases.filter((c) => c.suite === original.suite).map((c) => c.id),
          ]);
          const cases = prepared.cases.filter((c) => ids.has(c.id));
          if (!cases.some((c) => c.id === args.case)) {
            throw new ToolError(`no case "${args.case}" in the session's case files`);
          }
          const ran = await runCases(prepared, cases, { samples: args.samples });
          const now = new Map(ran.results.cases.map((c) => [c.id, c]));
          const checked = [args.case, shrunkId].flatMap((id) => {
            const result = now.get(id);
            return result === undefined
              ? []
              : [{ id, status: result.status, failsTarget: failsTarget(result, target) }];
          });
          const definitions = new Map(prepared.cases.map((c) => [c.id, definitionSha256(c)]));
          const changed: string[] = [];
          const regressions = before.cases.flatMap((was) => {
            const result = now.get(was.id);
            if (result === undefined || was.status !== 'pass') return [];
            if (
              was.definitionSha256 !== undefined &&
              was.definitionSha256 !== definitions.get(was.id)
            ) {
              changed.push(was.id);
              return [];
            }
            return result.status === 'pass' ? [] : [summaryOf(result)];
          });
          return {
            fixed:
              !ran.results.run.partial &&
              checked.some((c) => c.id === args.case) &&
              checked.every((c) => !c.failsTarget && c.status !== 'error'),
            partial: ran.results.run.partial,
            run: ran.results.run.id,
            results: ran.path,
            target: { check: target.check, dimension: target.dimension },
            checked,
            ran: ran.results.cases.map((c) => {
              const was = before.cases.find((b) => b.id === c.id)?.status;
              return { id: c.id, ...(was === undefined ? {} : { before: was }), now: c.status };
            }),
            regressions,
            changed,
            otherNotPassing: before.cases
              .filter((c) => c.suite !== original.suite && c.status !== 'pass')
              .map((c) => ({ id: c.id, suite: c.suite, status: c.status })),
            issues: ran.results.run.issues ?? [],
            cost: ran.cost,
          };
        }),
    },
  ];
}
