// Runs cases against a target, checks every answered turn and produces
// results.v1 (design §11, ADR-0007). Everything target-specific comes from the
// profile (P9); everything domain-specific comes from the packs the caller
// passes in (P7). A case where no check applied is `unmeasured`, never `pass`.

import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  aggregateCase,
  buildRequest,
  callCost,
  caseDefinition,
  checkTemplates,
  extractResponse,
  FAULT_JUDGES,
  queryJsonPath,
  readStream,
  RESULTS_SCHEMA_ID,
  reviewStatus,
  runChecks,
  summariseChecks,
  toJson,
  type AggregationPolicy,
  type Case,
  type Check,
  type DomainPack,
  type LanguagePack,
  type TurnView,
  type JsonValue,
  type Profile,
  type FaultPlan,
  type PromptRole,
  type PromptStorage,
  type ProxyCallView,
  type ProxyRecord,
  type Results,
  type YoklaConfig,
} from '@yokla/core';
import { HttpClient, HttpError } from '../http/client.ts';
import { systemClock, type Clock } from '../http/rate-limit.ts';
import { testNetAddress } from '../http/test-net.ts';
import { cacheBypass } from '../process/cache-bypass.ts';
import { CommandError } from '../process/command.ts';
import { correlate, observedFields, parseLogLines, readLogText } from '../observe/logs.ts';
import { ProxyControl, ProxyControlError } from '../proxy/control.ts';
import {
  attributeCalls,
  storeTurnProxy,
  type Correlation,
  type TurnProxy,
  type TurnTag,
} from './proxy.ts';

type CaseResult = Results['cases'][number];
type SampleResult = CaseResult['samples'][number];
type TurnResult = SampleResult['turns'][number];

export interface RunOptions {
  readonly profile: Profile;
  /** SHA-256 of the profile file, recorded in the results. */
  readonly profileSha256: string;
  /** Directory of the profile file; profile commands run here. */
  readonly profileDir: string;
  readonly cases: readonly Case[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly yoklaVersion: string;
  /** Samples per case when the case doesn't say. Default 1. */
  readonly samples?: number;
  /** Cases run in parallel. Default 1. */
  readonly concurrency?: number;
  /** Replaces the profile's request url, e.g. for a target on a random port. */
  readonly targetUrl?: string;
  /** Id generator for sessions and request ids. Default: random UUIDs. */
  readonly ids?: () => string;
  readonly clock?: Clock;
  /** Domain packs; the one whose id is the profile's domain runs its checks. */
  readonly packs?: readonly DomainPack[];
  readonly languages?: readonly LanguagePack[];
  /** Checks that run for every case, whatever the domain. */
  readonly checks?: readonly Check[];
  /** Prices of the model calls the proxy records (yokla.config.yaml). */
  readonly prices?: YoklaConfig['prices'];
  /** A hard cap on the model cost of the run, in USD; needs a model proxy (ADR-0014). */
  readonly maxCostUsd?: number;
  /** The model proxy's address. Default: 127.0.0.1 on the profile's modelProxy.port. */
  readonly proxyUrl?: string;
  /** Wait before reading the target's logs, so the last lines are written. Default 1000 ms. */
  readonly logSettleMs?: number;
  /** Reads a file for a pack. Default: relative to profileDir. */
  readonly readText?: (path: string) => string;
  readonly onTurn?: (event: {
    caseId: string;
    sample: number;
    turn: number;
    error?: string;
  }) => void;
}

/** The SHA-256 of what decides a case's verdict (ADR-0011). */
export function definitionSha256(testCase: Case): string {
  return createHash('sha256').update(caseDefinition(testCase)).digest('hex');
}

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

const NO_EXPECTATIONS: Readonly<Record<string, unknown>> = {};

interface Prepared {
  readonly checks: readonly Check[];
  readonly policies: Readonly<Record<string, AggregationPolicy>>;
  readonly languages: ReadonlyMap<string, LanguagePack>;
}

function prepare(options: RunOptions): Prepared {
  const { profile } = options;
  const packs = options.packs ?? [];
  const pack = packs.find((candidate) => candidate.id === profile.domain);
  if (packs.length > 0 && pack === undefined) {
    throw new ConfigError(`no domain pack "${profile.domain}" is loaded`);
  }
  const readText =
    options.readText ?? ((path: string) => readFileSync(resolve(options.profileDir, path), 'utf8'));
  let packChecks: readonly Check[] = [];
  if (pack !== undefined) {
    try {
      packChecks = pack.prepare(profile, { readText }).checks;
    } catch (error) {
      throw new ConfigError(
        `pack "${pack.id}": ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  const checks = [...(options.checks ?? []), ...packChecks];
  const ids = checks.map((check) => check.id);
  const duplicate = ids.find((id, index) => ids.indexOf(id) !== index);
  if (duplicate !== undefined) throw new ConfigError(`check "${duplicate}" is defined twice`);
  return {
    checks,
    policies: pack?.dimensions ?? {},
    languages: new Map((options.languages ?? []).map((lang) => [lang.language, lang])),
  };
}

function errorMessage(error: unknown): string {
  if (error instanceof HttpError || error instanceof CommandError)
    return `${error.kind}: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}

/** Checks everything that can be checked before contacting the target. */
export function preflight(options: RunOptions): void {
  const target = options.profile.target;
  const check = checkTemplates(
    target,
    options.cases.flatMap((c) => c.turns.map((turn) => turn.request)),
  );
  const missingEnv = check.env.filter((name) => options.env[name] === undefined);
  const problems = [
    ...check.issues,
    ...missingEnv.map((name) => `environment variable ${name} is not set`),
  ];
  const logs = target.observe?.logs;
  if (logs?.correlate.by === 'request-id' && target.request.requestId === undefined) {
    problems.push('observe.logs correlates by request id, but request.requestId is not configured');
  }
  if (logs?.correlate.by === 'target-id' && target.response.id === undefined) {
    problems.push('observe.logs correlates by target id, but response.id is not mapped');
  }
  if (logs?.correlate.by === 'order' && (options.concurrency ?? 1) > 1) {
    problems.push('observe.logs correlates by order, which needs a concurrency of 1');
  }
  if (options.profile.modelProxy?.correlation === 'serial' && (options.concurrency ?? 1) > 1) {
    problems.push('modelProxy correlates serially, which needs a concurrency of 1');
  }
  if (options.maxCostUsd !== undefined && options.profile.modelProxy === undefined) {
    problems.push('a cost cap needs a modelProxy in the profile: without one, spend is unknown');
  }
  if (options.profile.modelProxy === undefined) {
    for (const c of options.cases) {
      if (c.turns.some((turn) => turn.faults !== undefined)) {
        problems.push(`case "${c.id}" injects faults, which needs a modelProxy in the profile`);
      }
    }
  }
  const languages = new Set<string>(options.profile.languages);
  const seen = new Set<string>();
  for (const c of options.cases) {
    if (seen.has(c.id)) problems.push(`case id "${c.id}" is used more than once`);
    seen.add(c.id);
    if (!languages.has(c.language)) {
      problems.push(`case "${c.id}" is in "${c.language}", which the profile doesn't list`);
    }
    const mapped = new Set(Object.keys(target.response.evidence ?? {}));
    for (const turn of c.turns) {
      const evidence = turn.expect?.['evidence'];
      if (typeof evidence !== 'object' || evidence === null) continue;
      for (const name of Object.keys(evidence)) {
        if (!mapped.has(name)) {
          problems.push(`case "${c.id}" expects evidence "${name}", which the profile doesn't map`);
        }
      }
    }
  }
  if (problems.length > 0) throw new ConfigError(problems.join('\n'));
}

/** One turn as exchanged with the target, before any check ran. */
interface Exchange {
  readonly turn: TurnResult;
  /** What the checks see; set when the answer could be read. */
  readonly view: TurnView | undefined;
  /** What ties the model proxy's calls to this turn. */
  readonly tag?: TurnTag;
}

/** Tells the model proxy about a turn: in flight, and its faults (ADR-0012, ADR-0013). */
type Arm = (
  turn: string,
  arming: {
    readonly inFlight: boolean;
    readonly faults?: readonly FaultPlan[];
    readonly seed?: string;
  },
) => Promise<void>;

/** Waits until the target's model calls stop (ADR-0016); says why when they didn't. */
type Settle = () => Promise<string | undefined>;

interface ExchangedSample {
  readonly index: number;
  readonly exchanges: Exchange[];
}

interface ExchangedCase {
  readonly testCase: Case;
  readonly samples: ExchangedSample[];
}

async function runSample(
  options: RunOptions,
  client: HttpClient,
  testCase: Case,
  caseIndex: number,
  sampleIndex: number,
  arm: Arm | undefined,
  openUrl: string | undefined,
  settle: Settle | undefined,
): Promise<ExchangedSample> {
  const target = options.profile.target;
  const ids = options.ids ?? randomUUID;
  const bypass = cacheBypass(target.cacheBypass, options.profileDir);
  const request =
    options.targetUrl === undefined
      ? target.request
      : { ...target.request, url: options.targetUrl };
  const identity = target.limits?.clientIdentity;
  const identityHeaders =
    identity === undefined
      ? {}
      : {
          [identity.header]: testNetAddress(
            identity.per === 'case' ? caseIndex : caseIndex * 1_000 + sampleIndex,
          ),
        };

  const exchanges: Exchange[] = [];
  const session = target.session.mode === 'client' ? ids() : undefined;
  const carry: Record<string, JsonValue> = {};

  try {
    await bypass.prepare();
  } catch (error) {
    const firstTurn = testCase.turns[0];
    exchanges.push({
      turn: {
        user: firstTurn?.user ?? '',
        error: `cache bypass failed: ${errorMessage(error)}`,
        checks: [],
      },
      view: undefined,
    });
    return { index: sampleIndex, exchanges };
  }

  // The target's own session, opened before the first turn (ADR-0016).
  const open = target.session.open;
  if (open !== undefined && openUrl !== undefined) {
    try {
      // Serial correlation: a mark no turn has, so calls the opening causes stay unattributed.
      if (options.profile.modelProxy?.correlation === 'serial') {
        await arm?.(`session-open-${ids()}`, { inFlight: true });
      }
      const built = buildRequest(
        { ...open.request, url: openUrl },
        undefined,
        { message: '', session, requestId: undefined, carry: {}, env: options.env },
        { ...bypass.headers, ...identityHeaders },
      );
      const result = await client.send(built);
      if (result.status < 200 || result.status > 299) {
        throw new Error(`HTTP ${String(result.status)}`);
      }
      if (result.json === undefined) throw new Error('the answer is not JSON');
      for (const entry of open.carry) {
        const [value] = queryJsonPath(result.json, entry.from);
        if (value === undefined || value === null) {
          throw new Error(`no value at ${entry.from} for {{carry.${entry.name}}}`);
        }
        carry[entry.name] = toJson(value);
      }
      // Calls the opening caused finish before the first turn is marked.
      if (options.profile.modelProxy?.correlation === 'serial') await settle?.();
    } catch (error) {
      exchanges.push({
        turn: {
          user: testCase.turns[0]?.user ?? '',
          error: `session setup failed: ${errorMessage(error)}`,
          checks: [],
        },
        view: undefined,
      });
      return { index: sampleIndex, exchanges };
    }
  }

  for (const [turnIndex, turn] of testCase.turns.entries()) {
    const requestId = request.requestId === undefined ? undefined : ids();
    // With a model proxy, the turn's id: marked on the proxy before the request
    // (serial), or sent for the app to pass on to its model calls (header).
    const correlation = options.profile.modelProxy?.correlation;
    const tag = correlation === undefined ? undefined : { id: requestId ?? ids() };
    const trace = correlation === 'header' ? tag?.id : undefined;
    const base = { user: turn.user, ...(requestId === undefined ? {} : { requestId }), checks: [] };
    let outcome: Exchange;
    const faults = turn.faults;
    const started = performance.now();
    try {
      if (tag !== undefined && (correlation === 'serial' || faults !== undefined)) {
        await arm?.(tag.id, {
          inFlight: correlation === 'serial',
          // The jitter seed: what identifies this turn in every run (ADR-0017).
          ...(faults === undefined
            ? {}
            : { faults, seed: `${testCase.id}|${String(sampleIndex)}|${String(turnIndex)}` }),
        });
      }
      const built = buildRequest(
        request,
        turn,
        { message: turn.user, session, requestId, carry, env: options.env },
        {
          ...bypass.headers,
          ...identityHeaders,
          ...(trace === undefined ? {} : { 'x-yokla-trace': trace }),
        },
      );
      const stream = target.response.stream;
      const result = await client.send(built, { stream: stream !== undefined });
      // A streamed answer becomes one document that the profile's paths read (ADR-0016).
      const read = stream === undefined ? undefined : readStream(result.chunks ?? [], stream);
      const body = read === undefined ? result.json : read.document;
      const extracted = body === undefined ? undefined : extractResponse(body, target.response);
      const response = {
        status: result.status,
        latencyMs: Math.round(result.latencyMs * 100) / 100,
        ...(read?.firstTextMs === undefined
          ? {}
          : { firstTextMs: Math.round(read.firstTextMs * 100) / 100 }),
        ...(extracted?.id === undefined ? {} : { id: extracted.id }),
        ...(extracted?.text === undefined ? {} : { text: extracted.text }),
        ...(extracted?.route === undefined ? {} : { route: extracted.route }),
        evidence: Object.fromEntries(
          Object.entries(extracted?.evidence ?? {}).map(([name, items]) => [
            name,
            items.map((item) => ({ ...item })),
          ]),
        ),
      };
      const issues = [...(extracted?.issues ?? [])];
      let error: string | undefined;
      if (result.status < 200 || result.status > 299) error = `HTTP ${String(result.status)}`;
      else if (read?.problem !== undefined) error = read.problem;
      else if (extracted === undefined) error = 'the response is not JSON';
      else if (extracted.text === undefined) error = issues.shift() ?? 'answer text not found';
      // Under injected faults, a failed answer is what the case judges, not a run error (ADR-0013).
      const failure = faults === undefined ? undefined : error;
      if (failure !== undefined) {
        error = undefined;
        issues.push(`gave no usable answer under the injected faults: ${failure}`);
      }
      const clarifying =
        extracted?.route !== undefined &&
        (target.response.clarification?.routes.includes(extracted.route) ?? false);
      const view: TurnView | undefined =
        error === undefined && (extracted?.text !== undefined || failure !== undefined)
          ? {
              user: turn.user,
              expect: turn.expect ?? NO_EXPECTATIONS,
              response: {
                status: result.status,
                latencyMs: response.latencyMs,
                text: failure === undefined ? (extracted?.text ?? '') : '',
                route: extracted?.route,
                id: extracted?.id,
                evidence: extracted?.evidence ?? {},
              },
              observed: undefined,
              clarifying,
              faults: faults === undefined ? undefined : { failure },
              proxy: undefined,
            }
          : undefined;
      outcome = {
        turn: {
          ...base,
          ...(clarifying ? { clarifying } : {}),
          response,
          ...(error === undefined ? {} : { error }),
          ...(issues.length === 0 ? {} : { issues }),
        },
        view,
        ...(tag === undefined ? {} : { tag }),
      };
      for (const entry of target.session.carry) {
        const [value] = body === undefined ? [] : queryJsonPath(body, entry.from);
        carry[entry.name] = value === undefined ? null : toJson(value);
      }
    } catch (error) {
      const failure = errorMessage(error);
      outcome =
        faults === undefined
          ? {
              turn: { ...base, error: failure },
              view: undefined,
              ...(tag === undefined ? {} : { tag }),
            }
          : {
              // No answer at all under faults: judged, like any other failure under them.
              turn: {
                ...base,
                issues: [`gave no usable answer under the injected faults: ${failure}`],
              },
              view: {
                user: turn.user,
                expect: turn.expect ?? NO_EXPECTATIONS,
                response: {
                  status: 0,
                  latencyMs: Math.round((performance.now() - started) * 100) / 100,
                  text: '',
                  route: undefined,
                  id: undefined,
                  evidence: {},
                },
                observed: undefined,
                clarifying: false,
                faults: { failure },
                proxy: undefined,
              },
              ...(tag === undefined ? {} : { tag }),
            };
    }
    // Serial correlation: calls the target makes after its answer belong to this turn,
    // so the next turn is marked only once they have stopped (ADR-0016).
    if (correlation === 'serial' && settle !== undefined) {
      const problem = await settle();
      if (problem !== undefined) {
        outcome = {
          ...outcome,
          turn: {
            ...outcome.turn,
            issues: [
              ...(outcome.turn.issues ?? []),
              `${problem} after its answer; later calls may be counted for the next turn`,
            ],
          },
        };
      }
    }
    exchanges.push(outcome);
    options.onTurn?.({
      caseId: testCase.id,
      sample: sampleIndex,
      turn: turnIndex,
      ...(outcome.turn.error === undefined ? {} : { error: outcome.turn.error }),
    });
    if (outcome.turn.error !== undefined) break;
  }
  return { index: sampleIndex, exchanges };
}

async function exchangeCase(
  options: RunOptions,
  client: HttpClient,
  testCase: Case,
  caseIndex: number,
  arm: Arm | undefined,
  cap: Cap | undefined,
  openUrl: string | undefined,
  settle: Settle | undefined,
): Promise<ExchangedCase> {
  const samples: ExchangedSample[] = [];
  const count = testCase.samples ?? options.samples ?? 1;
  for (let index = 0; index < count && cap?.stopped() !== true; index += 1) {
    samples.push(
      await runSample(options, client, testCase, caseIndex, index, arm, openUrl, settle),
    );
    await cap?.check();
  }
  return { testCase, samples };
}

/** Runs `worker` over `items` with at most `limit` in flight, keeping the input order. */
async function pool<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
  stopped: () => boolean = () => false,
) {
  const results: (R | undefined)[] = Array.from({ length: items.length });
  let next = 0;
  async function lane(): Promise<void> {
    for (let index = next++; index < items.length && !stopped(); index = next++) {
      const item = items[index];
      if (item !== undefined) results[index] = await worker(item, index);
    }
  }
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, () => lane()),
  );
  // Items that never started, because the run stopped, are left out; the order stays.
  return results.filter((result): result is R => result !== undefined);
}

interface Observation {
  /** Per answered turn: its fields, or undefined when no line matched. */
  readonly byExchange: ReadonlyMap<Exchange, Record<string, JsonValue> | undefined>;
  readonly summary: Results['run']['observation'];
  readonly issues: readonly string[];
}

const NOTHING_OBSERVED: Observation = { byExchange: new Map(), summary: undefined, issues: [] };

/** Reads the target's logs once and ties each answered turn to its line (ADR-0009). */
async function observe(
  options: RunOptions,
  startedAt: Date,
  cases: readonly ExchangedCase[],
): Promise<Observation> {
  const config = options.profile.target.observe?.logs;
  if (config === undefined) return NOTHING_OBSERVED;
  await (options.clock ?? systemClock).sleep(options.logSettleMs ?? 1_000);
  let lines: unknown[];
  try {
    lines = parseLogLines(
      await readLogText(config, { startedAt, cwd: options.profileDir }),
      config,
    );
  } catch (error) {
    return {
      ...NOTHING_OBSERVED,
      issues: [`the target's logs could not be read: ${errorMessage(error)}`],
    };
  }

  const answered = cases
    .flatMap((c) => c.samples.flatMap((sample) => sample.exchanges))
    .filter((exchange) => exchange.turn.response !== undefined);
  const found = correlate(
    lines,
    config,
    answered.map(({ turn }) => ({ requestId: turn.requestId, targetId: turn.response?.id })),
  );
  const byExchange = new Map<Exchange, Record<string, JsonValue> | undefined>();
  const totals: Record<string, number> = {};
  const missing: Record<string, number> = {};
  let matched = 0;
  for (const [index, exchange] of answered.entries()) {
    const line = found[index];
    const fields = line === undefined ? undefined : observedFields(line, config);
    byExchange.set(exchange, fields);
    if (fields === undefined) continue;
    matched += 1;
    for (const [name, value] of Object.entries(fields)) {
      if (typeof value === 'number') totals[name] = (totals[name] ?? 0) + value;
      if (value === null) missing[name] = (missing[name] ?? 0) + 1;
    }
  }
  return {
    byExchange,
    summary: {
      source: 'target-logs',
      correlation: config.correlate.by,
      lines: lines.length,
      matched,
      unmatched: answered.length - matched,
      totals,
      missing,
    },
    issues: [],
  };
}

/** A prompt as checks see it: only when all its text is there (ADR-0015). */
function promptView(prompt: TurnProxy['calls'][number]['prompt']): ProxyCallView['prompt'] {
  if (prompt === undefined || prompt === null) return null;
  const view: { role: PromptRole; text: string }[] = [];
  for (const { role, text } of prompt) {
    if (text === undefined) return null;
    view.push({ role, text });
  }
  return view;
}

/** Whether any recorded call sent `text` in a system message: every prompt-leak pass needs it. */
function inSystemPrompt(records: readonly ProxyRecord[], text: string): boolean {
  return records.some((record) =>
    (record.prompt ?? []).some(
      (message) => message.role === 'system' && (message.text ?? '').includes(text),
    ),
  );
}

/** The run's calls tied to its turns, and what of their prompts the results keep. */
interface ProxiedCalls {
  readonly byTurn: ReadonlyMap<Exchange, TurnProxy>;
  readonly prompts: PromptStorage;
}

/** Runs the checks over a case's exchanges, with what the logs observed, and aggregates. */
function judgeCase(
  options: RunOptions,
  prepared: Prepared,
  exchanged: ExchangedCase,
  observation: Observation,
  proxied: ProxiedCalls | undefined,
): CaseResult {
  const { testCase } = exchanged;
  const correlation = options.profile.target.observe?.logs?.correlate.by;
  const samples: SampleResult[] = exchanged.samples.map((sample) => {
    const history: TurnView[] = [];
    const turns = sample.exchanges.map((exchange, turnIndex): TurnResult => {
      let turn = exchange.turn;
      const fields = observation.byExchange.get(exchange);
      if (observation.byExchange.has(exchange) && correlation !== undefined) {
        turn =
          fields === undefined
            ? { ...turn, issues: [...(turn.issues ?? []), 'no matching line in the target logs'] }
            : { ...turn, observed: { source: 'target-logs', correlation, fields } };
      }
      const proxy = proxied?.byTurn.get(exchange);
      // The checks see the prompts' text; the results keep what the profile says (ADR-0015).
      if (proxy !== undefined && proxied !== undefined) {
        turn = { ...turn, proxy: storeTurnProxy(proxy, proxied.prompts) };
      }
      if (exchange.view === undefined) return turn;
      const view: TurnView = {
        ...exchange.view,
        observed: fields,
        proxy:
          proxy === undefined
            ? undefined
            : {
                calls: proxy.calls.map((call) => ({
                  inputTokens: call.usage.input,
                  prompt: promptView(call.prompt),
                })),
                costUsd: proxy.costUsd,
              },
      };
      // A turn with no usable answer under faults is judged only by the fault judges.
      const applicable =
        view.faults?.failure === undefined
          ? prepared.checks
          : prepared.checks.filter((check) => FAULT_JUDGES.has(check.id));
      const checks = runChecks(applicable, {
        case: testCase,
        turnIndex,
        turn: view,
        history: [...history],
        profile: options.profile,
        lang: prepared.languages.get(testCase.language),
      });
      history.push(view);
      return { ...turn, checks };
    });
    return { index: sample.index, cache: 'cold', turns };
  });
  const aggregate = aggregateCase(samples, prepared.policies, testCase.knownGap !== undefined);
  return {
    id: testCase.id,
    suite: testCase.suite,
    language: testCase.language,
    definitionSha256: definitionSha256(testCase),
    status: aggregate.status,
    unstable: aggregate.unstable,
    ...(testCase.knownGap === undefined ? {} : { knownGap: testCase.knownGap }),
    ...(reviewStatus(testCase) === 'proposed' ? { review: 'proposed' as const } : {}),
    dimensions: aggregate.dimensions,
    samples,
  };
}

interface OpenRecording {
  readonly control: ProxyControl;
  readonly id: string;
  readonly correlation: Correlation;
  readonly prompts: PromptStorage;
  readonly settle: { readonly quietMs: number; readonly maxWaitMs: number };
}

async function settleRecording(recording: OpenRecording): Promise<string | undefined> {
  try {
    const quiet = await recording.control.settle(recording.id, recording.settle);
    return quiet.settled
      ? undefined
      : `the target was still calling its model ${String(quiet.waitedMs)} ms`;
  } catch (error) {
    return `couldn't wait for the target's model calls to stop (${errorMessage(error)})`;
  }
}

/** The cost cap of a run (ADR-0014): checked after each sample, from the open recording. */
interface Cap {
  check(): Promise<void>;
  stopped(): boolean;
  reason(): string | undefined;
}

function costCap(options: RunOptions, recording: OpenRecording): Cap | undefined {
  const limit = options.maxCostUsd;
  if (limit === undefined) return undefined;
  let reason: string | undefined;
  return {
    async check() {
      if (reason !== undefined) return;
      const records = await recording.control.records(recording.id);
      let spent = 0;
      for (const record of records) {
        const cost = callCost(
          record.usage,
          options.prices?.[record.upstream]?.[record.model ?? ''],
        );
        if (cost === null) {
          reason = `stopped: a model call has no cost, so the cost cap of ${String(limit)} USD can't be enforced`;
          return;
        }
        spent += cost;
      }
      if (spent >= limit) {
        reason = `stopped at the cost cap: ${String(Math.round(spent * 1e6) / 1e6)} USD spent, ${String(limit)} USD allowed`;
      }
    },
    stopped: () => reason !== undefined,
    reason: () => reason,
  };
}

/** Opens a recording on the model proxy the profile declares; a proxy that doesn't answer is a configuration problem. */
async function openRecording(options: RunOptions): Promise<OpenRecording | undefined> {
  const config = options.profile.modelProxy;
  if (config === undefined) return undefined;
  try {
    const control = new ProxyControl(options.proxyUrl ?? `http://127.0.0.1:${String(config.port)}`);
    const health = await control.health();
    const unrouted = config.upstreams
      .map((upstream) => upstream.id)
      .filter((id) => !health.upstreams.includes(id));
    if (unrouted.length > 0) {
      throw new ConfigError(
        `the model proxy doesn't route ${unrouted.join(', ')}; start it with this profile`,
      );
    }
    const { id } = await control.open();
    return {
      control,
      id,
      correlation: config.correlation,
      prompts: config.prompts,
      settle: config.settle,
    };
  } catch (error) {
    if (error instanceof ProxyControlError) {
      throw new ConfigError(`${error.message}; start it with yokla proxy`);
    }
    throw error;
  }
}

/** A url with its {{env.NAME}} placeholders filled in. */
function withEnv(text: string, env: RunOptions['env']): string {
  return text.replaceAll(/\{\{\s*env\.(\w+)\s*\}\}/gu, (_m, name: string) => env[name] ?? '');
}

export async function runSuite(input: RunOptions): Promise<Results> {
  // ADR-0004: a rejected case doesn't run; a proposed one runs, and doesn't gate.
  const options = { ...input, cases: input.cases.filter((c) => reviewStatus(c) !== 'rejected') };
  preflight(options);
  const prepared = prepare(options);
  const target = options.profile.target;
  const startedAt = new Date();
  const started = performance.now();
  const url = options.targetUrl ?? withEnv(target.request.url, options.env);
  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    throw new ConfigError(`the target url "${url}" is not a valid absolute url`);
  }

  // A session.open url that is a path is resolved against the target url.
  const openTemplate = target.session.open?.request.url;
  let openUrl: string | undefined;
  if (openTemplate !== undefined) {
    const raw = withEnv(openTemplate, options.env);
    try {
      openUrl = raw.startsWith('/') ? new URL(raw, url).href : new URL(raw).href;
    } catch {
      throw new ConfigError(`the session.open url "${raw}" is not a valid url or path`);
    }
  }

  const client = new HttpClient({
    allowedOrigins: [origin, ...(openUrl === undefined ? [] : [new URL(openUrl).origin])],
    timeoutMs: target.request.timeoutMs,
    limits: target.limits,
    retryAfter: target.limits?.retryAfter,
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  });

  const recording = await openRecording(options);
  const cap = recording === undefined ? undefined : costCap(options, recording);
  const arm: Arm | undefined =
    recording === undefined
      ? undefined
      : (turn, arming) => recording.control.turn(recording.id, turn, arming);
  const settle: Settle | undefined =
    recording === undefined ? undefined : () => settleRecording(recording);
  let exchanged: ExchangedCase[] = [];
  // Undefined when there is no proxy, or its records couldn't be read.
  let records: ProxyRecord[] | undefined;
  const proxyIssues: string[] = [];
  try {
    exchanged = await pool(
      options.cases,
      options.concurrency ?? 1,
      (testCase, index) =>
        exchangeCase(options, client, testCase, index, arm, cap, openUrl, settle),
      () => cap?.stopped() === true,
    );
  } finally {
    if (recording !== undefined) {
      // Calls after the last answer are recorded only if the recording waits for them.
      const problem = await settleRecording(recording);
      if (problem !== undefined) {
        proxyIssues.push(`${problem} when the run ended; calls after that weren't recorded`);
      }
      try {
        records = await recording.control.close(recording.id);
      } catch (error) {
        proxyIssues.push(`the model proxy's records could not be read: ${errorMessage(error)}`);
      }
    }
  }
  const calls =
    recording === undefined || records === undefined
      ? undefined
      : {
          ...attributeCalls(
            records,
            exchanged
              .flatMap((c) => c.samples.flatMap((sample) => sample.exchanges))
              .flatMap((exchange) =>
                exchange.tag === undefined ? [] : [{ key: exchange, tag: exchange.tag }],
              ),
            recording.correlation,
            options.prices ?? {},
          ),
          prompts: recording.prompts,
        };
  const canary = options.profile.modelProxy?.inspect?.canary;
  if (canary !== undefined && records !== undefined && !inSystemPrompt(records, canary)) {
    proxyIssues.push(
      "the canary in modelProxy.inspect.canary reached no system prompt during the run, so prompt-leak couldn't apply",
    );
  }
  const observation = await observe(options, startedAt, exchanged);
  const cases = exchanged.map((c) => judgeCase(options, prepared, c, observation, calls));
  const stop = cap?.reason();
  const issues = [...observation.issues, ...proxyIssues, ...(stop === undefined ? [] : [stop])];
  const statuses: Partial<Record<CaseResult['status'], number>> = {};
  for (const c of cases) statuses[c.status] = (statuses[c.status] ?? 0) + 1;
  const finishedAt = new Date();
  return {
    schema: RESULTS_SCHEMA_ID,
    yokla: { version: options.yoklaVersion },
    run: {
      id: (options.ids ?? randomUUID)(),
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: Math.round(performance.now() - started),
      profile: { target: target.name, sha256: options.profileSha256 },
      environment: { node: process.version, platform: process.platform, arch: process.arch },
      correlation: recording?.correlation ?? 'none',
      partial: cap?.stopped() === true,
      ...(observation.summary === undefined ? {} : { observation: observation.summary }),
      ...(calls === undefined ? {} : { proxy: { ...calls.summary, prompts: calls.prompts.store } }),
      ...(issues.length === 0 ? {} : { issues }),
    },
    cases,
    checks: summariseChecks(cases),
    summary: { cases: cases.length, statuses },
  };
}
