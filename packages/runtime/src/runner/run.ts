// Runs cases against a target, checks every answered turn and produces
// results.v1 (design §11, ADR-0007). Everything target-specific comes from the
// profile (P9); everything domain-specific comes from the packs the caller
// passes in (P7). A case where no check applied is `unmeasured`, never `pass`.

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  aggregateCase,
  buildRequest,
  checkTemplates,
  extractResponse,
  queryJsonPath,
  RESULTS_SCHEMA_ID,
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
  type Results,
} from '@yokla/core';
import { HttpClient, HttpError } from '../http/client.ts';
import type { Clock } from '../http/rate-limit.ts';
import { testNetAddress } from '../http/test-net.ts';
import { cacheBypass } from '../process/cache-bypass.ts';
import { CommandError } from '../process/command.ts';

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
  /** Reads a file for a pack. Default: relative to profileDir. */
  readonly readText?: (path: string) => string;
  readonly onTurn?: (event: {
    caseId: string;
    sample: number;
    turn: number;
    error?: string;
  }) => void;
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

async function runSample(
  options: RunOptions,
  prepared: Prepared,
  client: HttpClient,
  testCase: Case,
  caseIndex: number,
  sampleIndex: number,
): Promise<SampleResult> {
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

  const turns: TurnResult[] = [];
  const session = target.session.mode === 'client' ? ids() : undefined;
  const carry: Record<string, JsonValue> = {};
  const history: TurnView[] = [];

  try {
    await bypass.prepare();
  } catch (error) {
    const firstTurn = testCase.turns[0];
    turns.push({
      user: firstTurn?.user ?? '',
      error: `cache bypass failed: ${errorMessage(error)}`,
      checks: [],
    });
    return { index: sampleIndex, cache: 'cold', turns };
  }

  for (const [turnIndex, turn] of testCase.turns.entries()) {
    const requestId = request.requestId === undefined ? undefined : ids();
    const base = { user: turn.user, ...(requestId === undefined ? {} : { requestId }), checks: [] };
    let outcome: TurnResult;
    try {
      const built = buildRequest(
        request,
        turn,
        { message: turn.user, session, requestId, carry, env: options.env },
        { ...bypass.headers, ...identityHeaders },
      );
      const result = await client.send(built);
      const extracted =
        result.json === undefined ? undefined : extractResponse(result.json, target.response);
      const response = {
        status: result.status,
        latencyMs: Math.round(result.latencyMs * 100) / 100,
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
      else if (extracted === undefined) error = 'the response is not JSON';
      else if (extracted.text === undefined) error = issues.shift() ?? 'answer text not found';
      const clarifying =
        extracted?.route !== undefined &&
        (target.response.clarification?.routes.includes(extracted.route) ?? false);
      let checks: TurnResult['checks'] = [];
      if (error === undefined && extracted?.text !== undefined) {
        const view: TurnView = {
          user: turn.user,
          expect: turn.expect ?? NO_EXPECTATIONS,
          response: {
            status: result.status,
            latencyMs: response.latencyMs,
            text: extracted.text,
            route: extracted.route,
            id: extracted.id,
            evidence: extracted.evidence,
          },
          observed: undefined,
          clarifying,
        };
        checks = runChecks(prepared.checks, {
          case: testCase,
          turnIndex,
          turn: view,
          history: [...history],
          profile: options.profile,
          lang: prepared.languages.get(testCase.language),
        });
        history.push(view);
      }
      outcome = {
        ...base,
        checks,
        ...(clarifying ? { clarifying } : {}),
        response,
        ...(error === undefined ? {} : { error }),
        ...(issues.length === 0 ? {} : { issues }),
      };
      for (const entry of target.session.carry) {
        const [value] = result.json === undefined ? [] : queryJsonPath(result.json, entry.from);
        carry[entry.name] = value === undefined ? null : toJson(value);
      }
    } catch (error) {
      outcome = { ...base, error: errorMessage(error) };
    }
    turns.push(outcome);
    options.onTurn?.({
      caseId: testCase.id,
      sample: sampleIndex,
      turn: turnIndex,
      ...(outcome.error === undefined ? {} : { error: outcome.error }),
    });
    if (outcome.error !== undefined) break;
  }
  return { index: sampleIndex, cache: 'cold', turns };
}

async function runCase(
  options: RunOptions,
  prepared: Prepared,
  client: HttpClient,
  testCase: Case,
  caseIndex: number,
): Promise<CaseResult> {
  const samples: SampleResult[] = [];
  const count = testCase.samples ?? options.samples ?? 1;
  for (let index = 0; index < count; index += 1) {
    samples.push(await runSample(options, prepared, client, testCase, caseIndex, index));
  }
  const aggregate = aggregateCase(samples, prepared.policies, testCase.knownGap !== undefined);
  return {
    id: testCase.id,
    suite: testCase.suite,
    language: testCase.language,
    status: aggregate.status,
    unstable: aggregate.unstable,
    ...(testCase.knownGap === undefined ? {} : { knownGap: testCase.knownGap }),
    dimensions: aggregate.dimensions,
    samples,
  };
}

/** Runs `worker` over `items` with at most `limit` in flight, keeping the input order. */
async function pool<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
) {
  const results: R[] = Array.from({ length: items.length });
  let next = 0;
  async function lane(): Promise<void> {
    for (let index = next++; index < items.length; index = next++) {
      const item = items[index];
      if (item !== undefined) results[index] = await worker(item, index);
    }
  }
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, () => lane()),
  );
  return results;
}

export async function runSuite(options: RunOptions): Promise<Results> {
  preflight(options);
  const prepared = prepare(options);
  const target = options.profile.target;
  const startedAt = new Date();
  const started = performance.now();
  const url =
    options.targetUrl ??
    target.request.url.replaceAll(
      /\{\{\s*env\.(\w+)\s*\}\}/gu,
      (_m, name: string) => options.env[name] ?? '',
    );
  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    throw new ConfigError(`the target url "${url}" is not a valid absolute url`);
  }

  const client = new HttpClient({
    allowedOrigins: [origin],
    timeoutMs: target.request.timeoutMs,
    limits: target.limits,
    retryAfter: target.limits?.retryAfter,
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  });

  const cases = await pool(options.cases, options.concurrency ?? 1, (testCase, index) =>
    runCase(options, prepared, client, testCase, index),
  );

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
      correlation: 'none',
      partial: false,
    },
    cases,
    checks: summariseChecks(cases),
    summary: { cases: cases.length, statuses },
  };
}
