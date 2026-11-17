// results.v1 (ADR-0007). Objects are open: a v1 reader must accept optional
// fields added later in v1, so unknown keys are allowed, unlike config files.

import { z } from 'zod';
import { RunCoverage } from '../explore/coverage.ts';
import { Exploration } from '../explore/trace.ts';
import { Id, LanguageCode, Suite, TransformKind } from './common.ts';
import {
  ModelOutput,
  PromptMessage,
  PromptRole,
  PromptStore,
  ProxyUsage,
  ToolCall,
  ToolResultChange,
} from './proxy.ts';

export const RESULTS_SCHEMA_ID = 'yokla.results/v1';

export const Severity = z.enum(['info', 'low', 'medium', 'high', 'critical']);
export const CASE_STATUSES = [
  'pass',
  'fail',
  'error',
  'fixture-missing',
  'known-gap',
  'gap-closed',
  // No check applied to any turn: never counted as a pass (design P5).
  'unmeasured',
] as const;
export const CaseStatus = z.enum(CASE_STATUSES);

/** The value a failing finding is about, taken from the answer (ADR-0033). */
export const FindingSubject = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('money'),
    amount: z.number(),
    currency: z.string().optional(),
  }),
  z.object({
    kind: z.literal('duration'),
    amount: z.number(),
    unit: z.enum(['day', 'week', 'month', 'year']),
  }),
  z.object({ kind: z.literal('text'), text: z.string().min(1) }),
]);
export type FindingSubject = z.output<typeof FindingSubject>;

export const ORIGIN_STAGES = ['input', 'model', 'app', 'unknown'] as const;

/**
 * Where a finding's subject first appears (ADR-0033): in what the model was
 * sent, in what it answered, only in the app's answer, or unknown. Names and
 * positions only: it never quotes prompt or answer text.
 */
export const FindingOrigin = z.object({
  stage: z.enum(ORIGIN_STAGES),
  /** The call's position among the turn's model calls, from 0. */
  call: z.int().nonnegative().optional(),
  /** For `input`, the role of the message that holds the value. */
  role: PromptRole.optional(),
  /** For `input` in a tool result, the tool it answers (ADR-0026). */
  tool: z.string().optional(),
  /** How the value was found: `number` is a bare number in JSON, weaker than `money`. */
  match: z.enum(['money', 'number', 'duration', 'text']).optional(),
  /** For `unknown`, why; for `app`, set when the turn made no model call. */
  reason: z.string().optional(),
});
export type FindingOrigin = z.output<typeof FindingOrigin>;

export const Finding = z.object({
  dimension: Id,
  verdict: z.enum(['pass', 'fail', 'error']),
  severity: Severity,
  message: z.string(),
  evidence: z.json().optional(),
  subject: FindingSubject.optional(),
  origin: FindingOrigin.optional(),
});

export const CheckResult = z.object({
  check: Id,
  /** false when the check's input was absent; then `findings` is empty (design §10). */
  applicable: z.boolean(),
  findings: z.array(Finding),
  /** Dimensions the check applies to but couldn't measure (ADR-0014); never a pass. */
  unmeasured: z.array(z.object({ dimension: Id, reason: z.string() })).optional(),
});

export const TurnResult = z.object({
  /** The message as sent: as the case wrote it, or as the run's transforms changed it. */
  user: z.string(),
  /** The message as the case wrote it, when a transform changed it (ADR-0045). */
  written: z.string().optional(),
  /** The id yokla sent with the request, when the profile asks for one. */
  requestId: z.string().optional(),
  response: z
    .object({
      status: z.int(),
      latencyMs: z.number().nonnegative(),
      /** For a streamed answer, the time to its first text piece (ADR-0016). */
      firstTextMs: z.number().nonnegative().optional(),
      /** The target's own request id, when the profile maps it. */
      id: z.string().optional(),
      text: z.string().optional(),
      route: z.string().optional(),
      evidence: z.record(z.string(), z.array(z.json())),
    })
    .optional(),
  /** true when the target answered with a clarifying question. */
  clarifying: z.boolean().optional(),
  /** Fields read from the target's logs (ADR-0009), labelled by their source. */
  observed: z
    .object({
      source: z.literal('target-logs'),
      correlation: z.enum(['request-id', 'target-id', 'order']),
      fields: z.record(z.string(), z.json()),
    })
    .optional(),
  /** The provider calls the model proxy tied to this turn (ADR-0012). */
  proxy: z
    .object({
      correlation: z.enum(['serial', 'header']),
      /** The x-yokla-trace value sent with the request, in header correlation. */
      trace: z.string().optional(),
      calls: z.array(
        z.object({
          id: z.string(),
          upstream: Id,
          model: z.string().nullable(),
          status: z.int().nullable(),
          durationMs: z.number().nonnegative(),
          stream: z.boolean(),
          usage: ProxyUsage,
          /** null without a price or with unmeasured tokens. */
          costUsd: z.number().nonnegative().nullable(),
          /** The fault the proxy injected, and whether it could apply (ADR-0013). */
          fault: z.object({ kind: z.string(), applied: z.boolean() }).optional(),
          /**
           * The messages the call sent, in the form the run's `prompts` store mode
           * keeps (ADR-0015); null when the proxy couldn't read the request.
           */
          prompt: z.array(PromptMessage).nullable().optional(),
          /** The names of the tools the call offered; null when unreadable (ADR-0025). */
          tools: z.array(z.string()).nullable().optional(),
          /** The tool calls the model asked for, kept as `prompts` keeps text (ADR-0025). */
          toolCalls: z.array(ToolCall).nullable().optional(),
          /** The text the model answered, kept as `prompts` keeps text (ADR-0033). */
          output: ModelOutput.nullable().optional(),
          /** Set when the proxy answered from a cassette, or found no call in it (ADR-0040). */
          replay: z.object({ diverged: z.boolean() }).optional(),
          /** The model the app asked for, when a swap sent the call to another (ADR-0042). */
          asked: z.string().optional(),
          /** The changes the proxy made to the tool results the call sent (ADR-0043). */
          toolChanges: z.array(ToolResultChange).optional(),
        }),
      ),
      /** The sum of the calls' cost; null when any call has none. */
      costUsd: z.number().nonnegative().nullable(),
    })
    .optional(),
  /** The model calls OpenTelemetry spans showed for this turn, by its traceparent (ADR-0029). */
  spans: z
    .object({
      calls: z.array(
        z.object({
          spanId: z.string(),
          provider: z.string().nullable(),
          model: z.string().nullable(),
          durationMs: z.number().nonnegative(),
          usage: ProxyUsage,
          /** null without a price or with unmeasured tokens. */
          costUsd: z.number().nonnegative().nullable(),
          error: z.boolean(),
        }),
      ),
      /** The sum of the calls' cost; null when any call has none. */
      costUsd: z.number().nonnegative().nullable(),
    })
    .optional(),
  /** Set when the request failed or the answer couldn't be read; later turns don't run. */
  error: z.string().optional(),
  /**
   * Items the model saw in the results of the tools the profile maps, per
   * evidence collection, with their tool (ADR-0026). Kept apart from `response.evidence`.
   */
  seen: z.record(z.string(), z.array(z.object({ tool: z.string(), item: z.json() }))).optional(),
  /** Non-fatal mapping problems, e.g. a route the profile maps but the response lacks. */
  issues: z.array(z.string()).optional(),
  checks: z.array(CheckResult),
});

/** One call yokla made to its own model (ADR-0028). */
export const OwnCall = z.object({
  model: z.string(),
  durationMs: z.number().nonnegative(),
  usage: z.object({
    input: z.int().nonnegative().nullable(),
    output: z.int().nonnegative().nullable(),
  }),
  /** null without a price or a token count. */
  costUsd: z.number().nonnegative().nullable(),
  /** true when the reply came from the customer cache, at no cost. */
  cached: z.boolean(),
});

export const Sample = z.object({
  index: z.int().nonnegative(),
  /** cold samples bypassed the target's cache; warm samples did not (design §11). */
  cache: z.enum(['cold', 'warm']),
  turns: z.array(TurnResult),
  /** A simulated customer's conversation (ADR-0028). */
  customer: z
    .object({
      seed: z.string(),
      ended: z.enum(['reached', 'maxTurns', 'error']),
      /** The turn, from 0, after whose answer the goal was reached. */
      reachedAt: z.int().nonnegative().optional(),
      calls: z.array(OwnCall),
      /** The sum of the calls' cost; null when any call has none. */
      costUsd: z.number().nonnegative().nullable(),
    })
    .optional(),
});

export const DimensionResult = z.object({
  dimension: Id,
  policy: z.enum(['worst-of-n', 'majority-of-n', 'percentile', 'mean', 'advisory']),
  verdict: z.enum(['pass', 'fail', 'unmeasured']),
  samples: z.int().nonnegative(),
  failed: z.int().nonnegative(),
  /** Wilson 95 % interval of the failure rate (design §13). */
  interval: z.object({ level: z.literal(0.95), lower: z.number(), upper: z.number() }).optional(),
});

export const CaseResult = z.object({
  id: Id,
  suite: Suite,
  language: LanguageCode,
  /** SHA-256 of what decides the verdict (ADR-0011); the gate compares a case only while it holds. */
  definitionSha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .optional(),
  status: CaseStatus,
  /** true when samples disagree. */
  unstable: z.boolean(),
  knownGap: z.object({ reason: z.string(), issue: z.string().optional() }).optional(),
  /** A proposed case ran, but doesn't gate until a person approves it (ADR-0004, ADR-0018). */
  review: z.literal('proposed').optional(),
  dimensions: z.array(DimensionResult),
  samples: z.array(Sample),
  /** The samples the case planned, when it stopped early once its failure was settled (ADR-0038). */
  samplesPlanned: z.int().positive().optional(),
  /** Why the case is fixture-missing: the facts the data no longer holds, one line each (ADR-0053). */
  fixture: z.array(z.string().min(1)).min(1).optional(),
});

export const CheckSummary = z.object({
  check: Id,
  applied: z.int().nonnegative(),
  notApplicable: z.int().nonnegative(),
  passed: z.int().nonnegative(),
  failed: z.int().nonnegative(),
  errors: z.int().nonnegative(),
  /** Applied, but measured nothing it could judge (ADR-0014). */
  unmeasured: z.int().nonnegative().optional(),
});

export const Results = z
  .object({
    schema: z.literal(RESULTS_SCHEMA_ID),
    yokla: z.object({ version: z.string().min(1) }),
    run: z.object({
      id: z.string().min(1),
      startedAt: z.iso.datetime(),
      finishedAt: z.iso.datetime(),
      durationMs: z.number().nonnegative(),
      profile: z.object({ target: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/u) }),
      environment: z.object({ node: z.string(), platform: z.string(), arch: z.string() }),
      /** How provider calls were attributed to requests (design §12). v0.1 has no proxy: "none". */
      correlation: z.enum(['none', 'serial', 'header', 'traceparent']),
      /** true when the run stopped early, for example at the budget cap. */
      partial: z.boolean(),
      /** How samples were run: stopEarly when a case stopped once its failure was settled (ADR-0038). */
      sampling: z.object({ stopEarly: z.boolean() }).optional(),
      /** Set when the run recorded its model calls into a cassette (ADR-0040). */
      record: z.object({ calls: z.int().nonnegative() }).optional(),
      /** Set when the model proxy answered from a cassette (ADR-0040). */
      replay: z
        .object({
          cassetteSha256: z.string().regex(/^[a-f0-9]{64}$/u),
          loose: z.boolean(),
          /** Calls the cassette had no match for. */
          diverged: z.int().nonnegative(),
        })
        .optional(),
      /** The model swaps the run made, and how many calls each changed (ADR-0042). */
      swaps: z
        .array(
          z.object({
            upstream: Id,
            asked: z.string(),
            model: z.string(),
            to: Id.optional(),
            calls: z.int().nonnegative(),
          }),
        )
        .optional(),
      /** The run's transforms of the cases' messages, and how many messages each changed (ADR-0045). */
      transforms: z
        .array(z.object({ kind: TransformKind, messages: z.int().nonnegative() }))
        .optional(),
      /** What the run reached, when asked to measure it (ADR-0044). */
      coverage: RunCoverage.optional(),
      /** Every candidate yokla explore ran, kept or not (ADR-0046). */
      exploration: Exploration.optional(),
      /** The files the domain pack read: the data the run was judged on (ADR-0053). */
      data: z
        .array(
          z.object({
            /** As the profile names it, relative to the profile. */
            path: z.string().min(1),
            sha256: z.string().regex(/^[a-f0-9]{64}$/u),
            /** Its non-empty lines: one per JSON Lines row. */
            rows: z.int().nonnegative(),
            /** Unknown when the file was read by other means than the file system. */
            modifiedAt: z.iso.datetime().optional(),
          }),
        )
        .optional(),
      /** The run's changes to every result of a tool, and how many results each changed (ADR-0043). */
      toolChanges: z
        .array(z.object({ tool: z.string(), at: z.string(), results: z.int().nonnegative() }))
        .optional(),
      /** Measurements read from the target's logs (ADR-0009). */
      observation: z
        .object({
          source: z.literal('target-logs'),
          correlation: z.enum(['request-id', 'target-id', 'order']),
          /** Log lines that passed the filters. */
          lines: z.int().nonnegative(),
          /** Turns with a matching line, and turns without one. */
          matched: z.int().nonnegative(),
          unmatched: z.int().nonnegative(),
          /** Sums of the numeric observed fields over matched turns. */
          totals: z.record(z.string(), z.number()),
          /** Per field, the matched turns where it had no value; a total leaves them out. */
          missing: z.record(z.string(), z.int().positive()),
        })
        .optional(),
      /** What the model proxy recorded during the run (ADR-0012). */
      proxy: z
        .object({
          correlation: z.enum(['serial', 'header']),
          /** Calls recorded during the run, tied to a turn or not. */
          records: z.int().nonnegative(),
          attributed: z.int().nonnegative(),
          unattributed: z.int().nonnegative(),
          /** Sums over every recorded call. */
          totals: z.record(z.string(), z.number()),
          /** Per total, the calls without a value; the total leaves them out. */
          missing: z.record(z.string(), z.int().positive()),
          /** What of each call's prompt these results keep (ADR-0015). */
          prompts: PromptStore.optional(),
        })
        .optional(),
      /** The model calls OpenTelemetry spans showed during the run (ADR-0029). */
      spans: z
        .object({
          /** Model-call spans received during the run, tied to a turn or not. */
          received: z.int().nonnegative(),
          attributed: z.int().nonnegative(),
          unattributed: z.int().nonnegative(),
          /** Sums over every received call. */
          totals: z.record(z.string(), z.number()),
          /** Per total, the calls without a value; the total leaves them out. */
          missing: z.record(z.string(), z.int().positive()),
          /** Whether the spans stopped coming before the run's wait ran out. */
          settled: z.boolean(),
        })
        .optional(),
      /** How the run was authenticated, with no secret in it (ADR-0031). */
      auth: z
        .object({
          kind: z.enum(['oauth2-client-credentials', 'request']),
          /** Tokens fetched: the first, and each one after expiry or a 401. */
          tokens: z.int().nonnegative(),
          /** Requests sent again with a new token after the target answered 401. */
          retried: z.int().nonnegative(),
        })
        .optional(),
      /** The check modules the configuration loaded, so a changed check shows (ADR-0030). */
      checkModules: z
        .array(
          z.object({
            id: z.string(),
            /** Its path, relative to the configuration file. */
            module: z.string(),
            sha256: z.string().regex(/^[a-f0-9]{64}$/u),
          }),
        )
        .optional(),
      /** yokla's own model calls over the run, apart from the target's (ADR-0028). */
      own: z
        .object({
          calls: z.int().nonnegative(),
          cached: z.int().nonnegative(),
          costUsd: z.number().nonnegative().nullable(),
        })
        .optional(),
      /** Problems that affect the whole run, e.g. logs that couldn't be read. */
      issues: z.array(z.string()).optional(),
    }),
    cases: z.array(CaseResult),
    checks: z.array(CheckSummary),
    summary: z.object({
      cases: z.int().nonnegative(),
      statuses: z.partialRecord(CaseStatus, z.int().nonnegative()),
    }),
  })
  .meta({ title: 'yokla results v1' });

export type Results = z.output<typeof Results>;
export type CaseResult = z.output<typeof CaseResult>;
export type Finding = z.output<typeof Finding>;
