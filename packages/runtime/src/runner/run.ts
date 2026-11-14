// Runs cases against a target, checks every answered turn and produces
// results.v1 (design §11, ADR-0007). Everything target-specific comes from the
// profile (P9); everything domain-specific comes from the packs the caller
// passes in (P7). A case where no check applied is `unmeasured`, never `pass`.

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  aggregateCase,
  answeredStatus,
  buildMessage,
  buildRequest,
  callCost,
  caseDefinition,
  checkTemplates,
  eventName,
  extractResponse,
  goalReached,
  messageEvents,
  seenEvidence,
  CUSTOMER_LANGUAGES,
  UNANSWERED_JUDGES,
  queryJsonPath,
  readEvents,
  readStream,
  RESULTS_SCHEMA_ID,
  reviewStatus,
  runChecks,
  summariseChecks,
  toJson,
  type AggregationPolicy,
  type Case,
  type CaseCustomer,
  type CaseTurn,
  type Check,
  type Exchanged,
  type DomainPack,
  type LanguagePack,
  type TurnView,
  type JsonValue,
  type MessageStream,
  type Profile,
  type ProfileTarget,
  type FaultPlan,
  type PromptRole,
  type PromptStorage,
  type ProxyCallView,
  type ProxyRecord,
  type Results,
  type SpanCall,
  type YoklaConfig,
} from '@yokla/core';
import { HttpClient, HttpError } from '../http/client.ts';
import { RateLimiter, systemClock, type Clock } from '../http/rate-limit.ts';
import { testNetAddress } from '../http/test-net.ts';
import { cacheBypass } from '../process/cache-bypass.ts';
import { CommandError } from '../process/command.ts';
import { correlate, observedFields, parseLogLines, readLogText } from '../observe/logs.ts';
import { ProxyControl, ProxyControlError } from '../proxy/control.ts';
import { ModelClientError } from '../models/client.ts';
import { CustomerPlayer, type OwnCall } from '../models/customer.ts';
import {
  closeText,
  openWebSocket,
  WebSocketError,
  type WebSocketConnection,
} from '../ws/client.ts';
import {
  attributeCalls,
  attributeSpans,
  storeTurnProxy,
  type Correlation,
  type TurnProxy,
  type TurnSpans,
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
  /** yokla's own models, such as the simulated customer's (ADR-0028). */
  readonly models?: YoklaConfig['models'];
  /** Ask the customer model anew, whatever its reply cache holds (ADR-0028). */
  readonly freshCustomer?: boolean;
  /** Where yokla keeps generated and cached data. Default: yokla-data next to the profile. */
  readonly dataDir?: string;
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
  if (
    error instanceof HttpError ||
    error instanceof CommandError ||
    error instanceof WebSocketError
  )
    return `${error.kind}: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}

const REQUEST_ID = /\{\{\s*requestId\s*\}\}/u;

/** Whether a template mentions {{requestId}} anywhere. */
function mentionsRequestId(template: unknown): boolean {
  return template !== undefined && REQUEST_ID.test(JSON.stringify(template));
}

/**
 * Whether a turn gets a request id: in a header over HTTP, or where the
 * WebSocket message uses {{requestId}} (ADR-0024).
 */
function sendsRequestId(target: ProfileTarget, turnBody?: unknown): boolean {
  return target.adapter === 'http'
    ? target.request.requestId !== undefined
    : mentionsRequestId(target.request.body) || mentionsRequestId(turnBody);
}

/** Whether a WebSocket message ends the answer: the done event, or the error event. */
function endsAnswer(text: string, spec: MessageStream): boolean {
  const [event] = messageEvents([{ atMs: 0, text }]);
  if (event === undefined) return false;
  const name = eventName(event, spec);
  return name === spec.done || name === spec.error?.event;
}

function counted(count: number, noun: string): string {
  return `${String(count)} ${noun}${count === 1 ? '' : 's'}`;
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
  if (logs?.correlate.by === 'request-id' && !sendsRequestId(target)) {
    problems.push(
      target.adapter === 'http'
        ? 'observe.logs correlates by request id, but request.requestId is not configured'
        : 'observe.logs correlates by request id, but the WebSocket message has no {{requestId}}',
    );
  }
  if (target.adapter === 'websocket') {
    for (const c of options.cases) {
      if (c.turns.some((turn) => turn.request?.headers !== undefined)) {
        problems.push(
          `case "${c.id}" sets request headers, which a WebSocket target sends once, when the connection opens`,
        );
      }
    }
  }
  if (logs?.correlate.by === 'target-id' && target.response.id === undefined) {
    problems.push('observe.logs correlates by target id, but response.id is not mapped');
  }
  if (logs?.correlate.by === 'order' && (options.concurrency ?? 1) > 1) {
    problems.push('observe.logs correlates by order, which needs a concurrency of 1');
  }
  // Spans alone tie calls to turns by traceparent, which allows any concurrency (ADR-0029).
  if (
    proxiesCalls(options.profile) &&
    options.profile.modelProxy?.correlation === 'serial' &&
    (options.concurrency ?? 1) > 1
  ) {
    problems.push('modelProxy correlates serially, which needs a concurrency of 1');
  }
  const simulated = options.cases.filter((c) => c.customer !== undefined);
  if (
    options.maxCostUsd !== undefined &&
    options.profile.modelProxy === undefined &&
    simulated.length === 0
  ) {
    problems.push('a cost cap needs a modelProxy in the profile: without one, spend is unknown');
  }
  // A simulated customer needs yokla's own model, and a prompt in the case's language (ADR-0028).
  const customerModel = options.models?.customer;
  for (const c of simulated) {
    if (customerModel === undefined) {
      problems.push(
        `case "${c.id}" has a customer, which needs models.customer in yokla.config.yaml`,
      );
    }
    if (!CUSTOMER_LANGUAGES.includes(c.language)) {
      problems.push(
        `case "${c.id}" is in "${c.language}", and the customer prompt is in ${CUSTOMER_LANGUAGES.join(', ')} only`,
      );
    }
  }
  const keyEnv = customerModel?.apiKeyEnv;
  if (simulated.length > 0 && keyEnv !== undefined && options.env[keyEnv] === undefined) {
    problems.push(`environment variable ${keyEnv} is not set`);
  }
  for (const c of options.cases) {
    if (!c.turns.some((turn) => turn.faults !== undefined)) continue;
    if (options.profile.modelProxy === undefined) {
      problems.push(`case "${c.id}" injects faults, which needs a modelProxy in the profile`);
    } else if (!proxiesCalls(options.profile)) {
      // Faults are injected into calls the proxy forwards; spans only describe calls.
      problems.push(`case "${c.id}" injects faults, which needs an upstream in modelProxy`);
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

/** Whether the model proxy forwards the target's calls: without upstreams, only spans show them (ADR-0029). */
function proxiesCalls(profile: Profile): boolean {
  return (profile.modelProxy?.upstreams.length ?? 0) > 0;
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

/** What the samples of a WebSocket target share (ADR-0024). */
interface SocketSetup {
  /** The origins a connection may go to: the target's. */
  readonly origins: readonly string[];
  /** Paces messages by the profile's limits. */
  readonly pace: (() => Promise<void>) | undefined;
}

/** A turn's answer, whatever carried it. */
interface Answered {
  readonly status: number;
  readonly latencyMs: number;
  /** The document the profile's paths read; undefined when the body isn't JSON. */
  readonly body: unknown;
  readonly firstTextMs: number | undefined;
  /** Why the answer is incomplete, when it is. */
  readonly problem: string | undefined;
  readonly issues: readonly string[];
}

interface ExchangedSample {
  readonly index: number;
  readonly exchanges: Exchange[];
  /** A simulated customer's conversation (ADR-0028). */
  readonly customer?: NonNullable<SampleResult['customer']>;
}

/** yokla's own spend over the run (ADR-0028), for the cap and the results. */
interface OwnSpend {
  calls: number;
  cached: number;
  costUsd: number;
  /** A call without a cost: the total is unknown from there. */
  unknown: boolean;
}

/** What a simulated customer needs from the run (ADR-0028). */
interface Simulation {
  readonly player: CustomerPlayer;
  readonly spend: OwnSpend;
  readonly languages: ReadonlyMap<string, LanguagePack>;
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
  socket: SocketSetup | undefined,
  simulation: Simulation | undefined,
): Promise<ExchangedSample> {
  const target = options.profile.target;
  const ids = options.ids ?? randomUUID;
  const bypass = cacheBypass(target.cacheBypass, options.profileDir);
  const targetUrl = options.targetUrl ?? target.request.url;
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
      const serial =
        options.profile.modelProxy?.correlation === 'serial' && proxiesCalls(options.profile);
      if (serial) {
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
      if (serial) await settle?.();
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

  // A WebSocket target's connection: one per sample, after session.open (ADR-0024).
  let connection: WebSocketConnection | undefined;
  if (target.adapter === 'websocket') {
    try {
      const built = buildRequest(
        { url: targetUrl, headers: target.request.headers },
        undefined,
        { message: '', session, requestId: undefined, carry, env: options.env },
        { ...bypass.headers, ...identityHeaders },
      );
      connection = await openWebSocket(built.url, {
        allowedOrigins: socket?.origins ?? [],
        timeoutMs: target.request.timeoutMs,
        headers: built.headers,
        protocols: target.request.protocols,
        ...(socket?.pace === undefined ? {} : { pace: socket.pace }),
      });
    } catch (error) {
      exchanges.push({
        turn: {
          user: testCase.turns[0]?.user ?? '',
          error: `connection failed: ${errorMessage(error)}`,
          checks: [],
        },
        view: undefined,
      });
      return { index: sampleIndex, exchanges };
    }
  }

  /** Sends one turn and reads its answer, over HTTP or the sample's connection. */
  const exchangeTurn = async (
    turn: Case['turns'][number],
    values: Parameters<typeof buildRequest>[2],
    headers: Readonly<Record<string, string>>,
  ): Promise<Answered> => {
    if (target.adapter === 'http') {
      const built = buildRequest({ ...target.request, url: targetUrl }, turn, values, headers);
      const stream = target.response.stream;
      const result = await client.send(built, { stream: stream !== undefined });
      // A streamed answer becomes one document that the profile's paths read (ADR-0016).
      const read = stream === undefined ? undefined : readStream(result.chunks ?? [], stream);
      return {
        status: result.status,
        latencyMs: result.latencyMs,
        body: read === undefined ? result.json : read.document,
        firstTextMs: read?.firstTextMs,
        problem: read?.problem,
        issues: [],
      };
    }
    if (connection === undefined) throw new Error('the WebSocket connection is not open');
    const spec = target.response.stream;
    const answer = await connection.exchange(
      buildMessage(target.request.body, turn, values),
      (text) => endsAnswer(text, spec),
    );
    // Each message is one event of the answer's stream (ADR-0024).
    const read = readEvents(messageEvents(answer.messages), spec);
    const closed = answer.closed === undefined ? 'no close code' : closeText(answer.closed);
    const problem =
      answer.end === 'closed'
        ? answer.sent
          ? `the connection closed before its "${spec.done}" event (${closed})`
          : `the connection closed after the previous answer (${closed})`
        : answer.end === 'timeout'
          ? `no "${spec.done}" event within ${String(target.request.timeoutMs)} ms`
          : read.problem;
    return {
      // The status the connection opened with: the answer is judged by its done event.
      status: 101,
      latencyMs: answer.latencyMs,
      body: read.document,
      firstTextMs: read.firstTextMs,
      problem,
      issues:
        answer.between === 0
          ? []
          : [
              `${counted(answer.between, 'message')} arrived after the previous answer's "${spec.done}" event; they belong to no turn`,
            ],
    };
  };

  /** Sends one turn, reads and keeps its answer. */
  const runTurn = async (turn: CaseTurn, turnIndex: number): Promise<Exchange> => {
    {
      const requestId = sendsRequestId(target, turn.request?.body) ? ids() : undefined;
      // With a model proxy, the turn's id: marked on the proxy before the request
      // (serial), or sent for the app to pass on to its model calls (header).
      // Without upstreams, the proxy forwards no calls to tie to the turn.
      const proxied = proxiesCalls(options.profile);
      const correlation = options.profile.modelProxy?.correlation;
      // With spans on, a W3C traceparent of the turn's own (ADR-0029).
      const traceId =
        options.profile.modelProxy?.spans !== undefined && target.adapter === 'http'
          ? randomBytes(16).toString('hex')
          : undefined;
      const tag =
        correlation === undefined
          ? undefined
          : { id: requestId ?? ids(), ...(traceId === undefined ? {} : { traceId }) };
      const trace = correlation === 'header' && proxied ? tag?.id : undefined;
      const base = {
        user: turn.user,
        ...(requestId === undefined ? {} : { requestId }),
        checks: [],
      };
      let outcome: Exchange;
      const faults = turn.faults;
      const started = performance.now();
      try {
        if (tag !== undefined && proxied && (correlation === 'serial' || faults !== undefined)) {
          await arm?.(tag.id, {
            inFlight: correlation === 'serial',
            // The jitter seed: what identifies this turn in every run (ADR-0017).
            ...(faults === undefined
              ? {}
              : { faults, seed: `${testCase.id}|${String(sampleIndex)}|${String(turnIndex)}` }),
          });
        }
        const result = await exchangeTurn(
          turn,
          { message: turn.user, session, requestId, carry, env: options.env },
          {
            ...bypass.headers,
            ...identityHeaders,
            ...(trace === undefined ? {} : { 'x-yokla-trace': trace }),
            ...(traceId === undefined
              ? {}
              : { traceparent: `00-${traceId}-${randomBytes(8).toString('hex')}-01` }),
          },
        );
        const { body } = result;
        const extracted = body === undefined ? undefined : extractResponse(body, target.response);
        const response = {
          status: result.status,
          latencyMs: Math.round(result.latencyMs * 100) / 100,
          ...(result.firstTextMs === undefined
            ? {}
            : { firstTextMs: Math.round(result.firstTextMs * 100) / 100 }),
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
        if (!answeredStatus(result.status)) error = `HTTP ${String(result.status)}`;
        else if (result.problem !== undefined) error = result.problem;
        else if (extracted === undefined) error = 'the response is not JSON';
        else if (extracted.text === undefined) error = issues.shift() ?? 'answer text not found';
        issues.push(...result.issues);
        // Under injected faults, a failed answer is what the case judges, not a run error (ADR-0013).
        const failure = faults === undefined ? undefined : error;
        if (failure !== undefined) {
          error = undefined;
          issues.push(`gave no usable answer under the injected faults: ${failure}`);
        }
        // An edge-case turn, one that allows other statuses, is judged on whether the
        // target handled it, never stopped by its answer (ADR-0018, ADR-0019).
        const edgeCase = failure === undefined && turn.expect?.['allowStatus'] !== undefined;
        const unusable = edgeCase ? error : undefined;
        if (edgeCase) error = undefined;
        const statusOnly = edgeCase && unusable !== undefined;
        const clarifying =
          extracted?.route !== undefined &&
          (target.response.clarification?.routes.includes(extracted.route) ?? false);
        const view: TurnView | undefined =
          error === undefined &&
          (extracted?.text !== undefined || failure !== undefined || statusOnly)
            ? {
                user: turn.user,
                expect: turn.expect ?? NO_EXPECTATIONS,
                response: {
                  status: result.status,
                  latencyMs: response.latencyMs,
                  text: failure === undefined && !statusOnly ? (extracted?.text ?? '') : '',
                  route: extracted?.route,
                  id: extracted?.id,
                  evidence: extracted?.evidence ?? {},
                },
                observed: undefined,
                seen: {},
                clarifying,
                faults: faults === undefined ? undefined : { failure },
                // A non-2xx status is judged by the status itself; anything else, by why.
                unusable: answeredStatus(result.status) ? unusable : undefined,
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
        // An edge-case turn that got no answer at all: judged like any unhandled answer (ADR-0019).
        const edgeCase = faults === undefined && turn.expect?.['allowStatus'] !== undefined;
        outcome =
          faults === undefined && !edgeCase
            ? {
                turn: { ...base, error: failure },
                view: undefined,
                ...(tag === undefined ? {} : { tag }),
              }
            : {
                // No answer at all under faults: judged, like any other failure under them.
                turn: {
                  ...base,
                  ...(edgeCase
                    ? {}
                    : { issues: [`gave no usable answer under the injected faults: ${failure}`] }),
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
                  seen: {},
                  clarifying: false,
                  faults: edgeCase ? undefined : { failure },
                  unusable: edgeCase ? failure : undefined,
                  proxy: undefined,
                },
                ...(tag === undefined ? {} : { tag }),
              };
      }
      // Serial correlation: calls the target makes after its answer belong to this turn,
      // so the next turn is marked only once they have stopped (ADR-0016).
      if (correlation === 'serial' && settle !== undefined && proxied) {
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
      return outcome;
    }
  };

  let customer: ExchangedSample['customer'];
  try {
    if (testCase.customer === undefined) {
      for (const [turnIndex, turn] of testCase.turns.entries()) {
        const outcome = await runTurn(turn, turnIndex);
        if (outcome.turn.error !== undefined) break;
      }
    } else if (simulation !== undefined) {
      customer = await converse(options, testCase, testCase.customer, sampleIndex, simulation, {
        runTurn,
        exchanges,
      });
    }
  } finally {
    await connection?.close();
  }
  return { index: sampleIndex, exchanges, ...(customer === undefined ? {} : { customer }) };
}

/**
 * A simulated customer's conversation (ADR-0028): the opening, or else the
 * customer's first message; then after each answer, the goal is judged from
 * the answer, and while it isn't reached the customer writes the next message,
 * up to maxTurns. The last turn's view says whether the goal was reached, for
 * goal-reached.
 */
async function converse(
  options: RunOptions,
  testCase: Case,
  customer: CaseCustomer,
  sampleIndex: number,
  simulation: Simulation,
  sample: {
    readonly runTurn: (turn: CaseTurn, index: number) => Promise<Exchange>;
    readonly exchanges: Exchange[];
  },
): Promise<NonNullable<ExchangedSample['customer']>> {
  const seed = `${testCase.id}|${String(sampleIndex)}`;
  const calls: OwnCall[] = [];
  const said: Exchanged[] = [];
  const history: TurnView[] = [];
  const lang = simulation.languages.get(testCase.language);
  let ended: 'reached' | 'maxTurns' | 'error' = 'maxTurns';
  let reachedAt: number | undefined;
  let message = customer.opening;
  for (let turnIndex = 0; turnIndex < customer.maxTurns; turnIndex += 1) {
    if (message === undefined) {
      try {
        const next = await simulation.player.next(customer, testCase.language, seed, said);
        calls.push(next.call);
        countSpend(simulation.spend, next.call);
        message = next.text;
      } catch (error) {
        const why = error instanceof ModelClientError ? error.message : errorMessage(error);
        sample.exchanges.push({
          turn: { user: '', error: `the customer model failed: ${why}`, checks: [] },
          view: undefined,
        });
        ended = 'error';
        break;
      }
    }
    const outcome = await sample.runTurn(
      { user: message, ...(customer.expect === undefined ? {} : { expect: customer.expect }) },
      turnIndex,
    );
    if (outcome.turn.error !== undefined || outcome.view === undefined) {
      ended = 'error';
      break;
    }
    const { view } = outcome;
    const reached = goalReached(customer.reached, {
      case: testCase,
      turnIndex,
      turn: view,
      history: [...history],
      profile: options.profile,
      lang,
      languages: simulation.languages,
    });
    history.push(view);
    said.push({ customer: message, answer: outcome.turn.response?.text ?? '' });
    message = undefined;
    if (reached) {
      ended = 'reached';
      reachedAt = turnIndex;
      break;
    }
  }
  // The last answered turn carries the conversation's outcome, for goal-reached.
  const last = sample.exchanges.at(-1);
  if (ended !== 'error' && last?.view !== undefined) {
    sample.exchanges[sample.exchanges.length - 1] = {
      ...last,
      view: {
        ...last.view,
        customer: {
          reached: ended === 'reached',
          turns: said.length,
          maxTurns: customer.maxTurns,
        },
      },
    };
  }
  return {
    seed,
    ended,
    ...(reachedAt === undefined ? {} : { reachedAt }),
    calls,
    costUsd: sumCosts(calls),
  };
}

function countSpend(spend: OwnSpend, call: OwnCall): void {
  spend.calls += 1;
  if (call.cached) spend.cached += 1;
  if (call.costUsd === null) spend.unknown = true;
  else spend.costUsd += call.costUsd;
}

function sumCosts(calls: readonly OwnCall[]): number | null {
  let total = 0;
  for (const call of calls) {
    if (call.costUsd === null) return null;
    total += call.costUsd;
  }
  return Math.round(total * 1e9) / 1e9;
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
  socket: SocketSetup | undefined,
  simulation: Simulation | undefined,
): Promise<ExchangedCase> {
  const samples: ExchangedSample[] = [];
  const count = testCase.samples ?? options.samples ?? 1;
  for (let index = 0; index < count && cap?.stopped() !== true; index += 1) {
    samples.push(
      await runSample(
        options,
        client,
        testCase,
        caseIndex,
        index,
        arm,
        openUrl,
        settle,
        socket,
        simulation,
      ),
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
  const view: { role: PromptRole; text: string; tool?: string }[] = [];
  for (const { role, text, tool } of prompt) {
    if (text === undefined) return null;
    view.push({ role, text, ...(tool === undefined ? {} : { tool }) });
  }
  return view;
}

/** The tool calls as checks see them, with their arguments; null when any is unknown (ADR-0025). */
function toolCallsView(calls: TurnProxy['calls'][number]['toolCalls']): ProxyCallView['toolCalls'] {
  if (calls === undefined || calls === null) return null;
  const view: { name: string; arguments: string }[] = [];
  for (const { name, arguments: text } of calls) {
    if (text === undefined) return null;
    view.push({ name, arguments: text });
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

/** The model calls spans showed, per turn (ADR-0029). */
type SpannedCalls = ReadonlyMap<Exchange, TurnSpans>;

/** Runs the checks over a case's exchanges, with what the logs observed, and aggregates. */
function judgeCase(
  options: RunOptions,
  prepared: Prepared,
  exchanged: ExchangedCase,
  observation: Observation,
  proxied: ProxiedCalls | undefined,
  spanned: SpannedCalls | undefined,
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
      const spans = spanned?.get(exchange);
      if (spans !== undefined) turn = { ...turn, spans };
      if (exchange.view === undefined) return turn;
      const proxyCalls = (proxy?.calls ?? []).map((call) => ({
        inputTokens: call.usage.input,
        prompt: promptView(call.prompt),
        offered: call.tools ?? null,
        toolCalls: toolCallsView(call.toolCalls),
      }));
      // A turn without proxy calls is judged on the calls its spans showed, which carry no
      // prompts or tool calls (ADR-0029).
      const fromSpans = proxyCalls.length === 0 && spans !== undefined && spans.calls.length > 0;
      const calls = fromSpans
        ? spans.calls.map((call) => ({
            inputTokens: call.usage.input,
            prompt: null,
            offered: null,
            toolCalls: null,
          }))
        : proxyCalls;
      // What the model saw in the results of the tools the profile maps (ADR-0026).
      const found = seenEvidence(calls, options.profile.modelProxy?.toolResults);
      if (Object.keys(found.seen).length > 0) turn = { ...turn, seen: found.seen };
      if (found.issues.length > 0) {
        turn = { ...turn, issues: [...(turn.issues ?? []), ...found.issues] };
      }
      const view: TurnView = {
        ...exchange.view,
        observed: fields,
        seen: found.seen,
        proxy: fromSpans
          ? { calls, costUsd: spans.costUsd }
          : proxy === undefined
            ? undefined
            : { calls, costUsd: proxy.costUsd },
      };
      // A turn without a usable answer, under faults or with a non-2xx status it allows,
      // is judged only by the checks that need no answer.
      const unanswered =
        view.faults?.failure !== undefined ||
        view.unusable !== undefined ||
        !answeredStatus(view.response.status);
      const applicable = unanswered
        ? prepared.checks.filter((check) => UNANSWERED_JUDGES.has(check.id))
        : prepared.checks;
      const checks = runChecks(applicable, {
        case: testCase,
        turnIndex,
        turn: view,
        history: [...history],
        profile: options.profile,
        lang: prepared.languages.get(testCase.language),
        languages: prepared.languages,
      });
      history.push(view);
      return { ...turn, checks };
    });
    return {
      index: sample.index,
      cache: 'cold',
      turns,
      ...(sample.customer === undefined ? {} : { customer: sample.customer }),
    };
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

function costCap(
  options: RunOptions,
  recording: OpenRecording | undefined,
  own: OwnSpend | undefined,
): Cap | undefined {
  const limit = options.maxCostUsd;
  if (limit === undefined) return undefined;
  let reason: string | undefined;
  return {
    async check() {
      if (reason !== undefined) return;
      // yokla's own spend counts with the target's (ADR-0028).
      if (own?.unknown === true) {
        reason = `stopped: a call of yokla's own model has no cost, so the cost cap of ${String(limit)} USD can't be enforced`;
        return;
      }
      const recorded =
        recording === undefined
          ? { records: [], spans: [] }
          : await recording.control.recorded(recording.id);
      let spent = own?.costUsd ?? 0;
      // Without upstreams, the calls spans showed are the target's spend (ADR-0029).
      if (!proxiesCalls(options.profile)) {
        for (const span of recorded.spans) {
          const cost = callCost(
            span.usage,
            options.prices?.[span.provider ?? '']?.[span.model ?? ''],
          );
          if (cost === null) {
            reason = `stopped: a span's model call has no cost, so the cost cap of ${String(limit)} USD can't be enforced`;
            return;
          }
          spent += cost;
        }
      }
      for (const record of recorded.records) {
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

  // A session.open url that is a path is resolved against the target url; for a
  // WebSocket target, with ws read as http and wss as https (ADR-0024).
  const openTemplate = target.session.open?.request.url;
  let openUrl: string | undefined;
  if (openTemplate !== undefined) {
    const raw = withEnv(openTemplate, options.env);
    const base = url.replace(/^ws(s?):/iu, 'http$1:');
    try {
      openUrl = raw.startsWith('/') ? new URL(raw, base).href : new URL(raw).href;
    } catch {
      throw new ConfigError(`the session.open url "${raw}" is not a valid url or path`);
    }
  }
  if (target.adapter === 'websocket' && !/^wss?:$/u.test(new URL(url).protocol)) {
    throw new ConfigError(`the target url "${url}" is not a ws:// or wss:// url`);
  }
  const limiter =
    target.adapter === 'websocket' && target.limits !== undefined
      ? new RateLimiter(target.limits, options.clock ?? systemClock)
      : undefined;
  const socket: SocketSetup | undefined =
    target.adapter === 'websocket'
      ? { origins: [origin], pace: limiter === undefined ? undefined : () => limiter.acquire() }
      : undefined;

  const client = new HttpClient({
    allowedOrigins: [origin, ...(openUrl === undefined ? [] : [new URL(openUrl).origin])],
    timeoutMs: target.request.timeoutMs,
    limits: target.limits,
    retryAfter: target.limits?.retryAfter,
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  });

  const recording = await openRecording(options);
  const customerModel = options.models?.customer;
  const simulation: Simulation | undefined =
    customerModel === undefined || !options.cases.some((c) => c.customer !== undefined)
      ? undefined
      : {
          player: new CustomerPlayer({
            model: customerModel,
            env: options.env,
            cacheDir: resolve(
              options.dataDir ?? resolve(options.profileDir, 'yokla-data'),
              'customer',
            ),
            ...(options.freshCustomer === true ? { fresh: true } : {}),
          }),
          spend: { calls: 0, cached: 0, costUsd: 0, unknown: false },
          languages: prepared.languages,
        };
  const cap =
    recording === undefined && simulation === undefined
      ? undefined
      : costCap(options, recording, simulation?.spend);
  const arm: Arm | undefined =
    recording === undefined
      ? undefined
      : (turn, arming) => recording.control.turn(recording.id, turn, arming);
  const settle: Settle | undefined =
    recording === undefined ? undefined : () => settleRecording(recording);
  let exchanged: ExchangedCase[] = [];
  // Undefined when there is no proxy, or its records couldn't be read.
  let records: ProxyRecord[] | undefined;
  let spanCalls: SpanCall[] | undefined;
  let spansSettled = true;
  const proxyIssues: string[] = [];
  try {
    exchanged = await pool(
      options.cases,
      options.concurrency ?? 1,
      (testCase, index) =>
        exchangeCase(
          options,
          client,
          testCase,
          index,
          arm,
          cap,
          openUrl,
          settle,
          socket,
          simulation,
        ),
      () => cap?.stopped() === true,
    );
  } finally {
    if (recording !== undefined) {
      // Calls after the last answer are recorded only if the recording waits for them.
      // Without upstreams, the proxy forwards none to wait for.
      const problem = proxiesCalls(options.profile) ? await settleRecording(recording) : undefined;
      if (problem !== undefined) {
        proxyIssues.push(`${problem} when the run ended; calls after that weren't recorded`);
      }
      // Spans come in batches, after the calls they describe (ADR-0029).
      const wait = options.profile.modelProxy?.spans;
      if (wait !== undefined) {
        try {
          spansSettled = (await recording.control.settleSpans(recording.id, wait)).settled;
          if (!spansSettled) {
            proxyIssues.push(
              `spans kept coming until spans.maxWaitMs ran out; spans after that weren't read`,
            );
          }
        } catch (error) {
          proxyIssues.push(`the spans could not be waited for: ${errorMessage(error)}`);
        }
      }
      try {
        const closed = await recording.control.closeAll(recording.id);
        records = closed.records;
        if (wait !== undefined) spanCalls = closed.spans;
      } catch (error) {
        proxyIssues.push(`the model proxy's records could not be read: ${errorMessage(error)}`);
      }
    }
  }
  const calls =
    recording === undefined || records === undefined || !proxiesCalls(options.profile)
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
  const spanned =
    spanCalls === undefined
      ? undefined
      : attributeSpans(
          spanCalls,
          exchanged
            .flatMap((c) => c.samples.flatMap((sample) => sample.exchanges))
            .flatMap((exchange) =>
              exchange.tag?.traceId === undefined
                ? []
                : [{ key: exchange, traceId: exchange.tag.traceId }],
            ),
          options.prices ?? {},
          spansSettled,
        );
  if (spanned !== undefined && spanned.summary.received > 0 && spanned.summary.attributed === 0) {
    proxyIssues.push(
      "no span carried a turn's trace id: the app may not pass the incoming traceparent on to its model calls",
    );
  }
  const cases = exchanged.map((c) =>
    judgeCase(options, prepared, c, observation, calls, spanned?.byTurn),
  );
  const stop = cap?.reason();
  const capIssues =
    options.maxCostUsd !== undefined && recording === undefined && simulation !== undefined
      ? [
          "the cost cap counted yokla's own model calls only: without a model proxy, the target's cost is unknown",
        ]
      : [];
  const issues = [
    ...observation.issues,
    ...proxyIssues,
    ...capIssues,
    ...(stop === undefined ? [] : [stop]),
  ];
  const own = simulation?.spend;
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
      // Without upstreams, spans tie the calls to turns, by traceparent (ADR-0029).
      correlation:
        recording === undefined
          ? 'none'
          : proxiesCalls(options.profile)
            ? recording.correlation
            : 'traceparent',
      partial: cap?.stopped() === true,
      ...(observation.summary === undefined ? {} : { observation: observation.summary }),
      ...(calls === undefined ? {} : { proxy: { ...calls.summary, prompts: calls.prompts.store } }),
      ...(spanned === undefined ? {} : { spans: spanned.summary }),
      ...(own === undefined
        ? {}
        : {
            own: {
              calls: own.calls,
              cached: own.cached,
              costUsd: own.unknown ? null : Math.round(own.costUsd * 1e9) / 1e9,
            },
          }),
      ...(issues.length === 0 ? {} : { issues }),
    },
    cases,
    checks: summariseChecks(cases),
    summary: { cases: cases.length, statuses },
  };
}
