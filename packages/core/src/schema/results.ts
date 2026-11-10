// results.v1 (ADR-0007). Objects are open: a v1 reader must accept optional
// fields added later in v1, so unknown keys are allowed, unlike config files.

import { z } from 'zod';
import { Id, LanguageCode, Suite } from './common.ts';

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

export const Finding = z.object({
  dimension: Id,
  verdict: z.enum(['pass', 'fail', 'error']),
  severity: Severity,
  message: z.string(),
  evidence: z.json().optional(),
});

export const CheckResult = z.object({
  check: Id,
  /** false when the check's input was absent; then `findings` is empty (design §10). */
  applicable: z.boolean(),
  findings: z.array(Finding),
});

export const TurnResult = z.object({
  user: z.string(),
  /** The id yokla sent with the request, when the profile asks for one. */
  requestId: z.string().optional(),
  response: z
    .object({
      status: z.int(),
      latencyMs: z.number().nonnegative(),
      /** The target's own request id, when the profile maps it. */
      id: z.string().optional(),
      text: z.string().optional(),
      route: z.string().optional(),
      evidence: z.record(z.string(), z.array(z.json())),
    })
    .optional(),
  /** Fields read from the target's logs (ADR-0009), labelled by their source. */
  observed: z
    .object({
      source: z.literal('target-logs'),
      correlation: z.enum(['request-id', 'target-id', 'order']),
      fields: z.record(z.string(), z.json()),
    })
    .optional(),
  /** Set when the request failed or the answer couldn't be read; later turns don't run. */
  error: z.string().optional(),
  /** Non-fatal mapping problems, e.g. a route the profile maps but the response lacks. */
  issues: z.array(z.string()).optional(),
  checks: z.array(CheckResult),
});

export const Sample = z.object({
  index: z.int().nonnegative(),
  /** cold samples bypassed the target's cache; warm samples did not (design §11). */
  cache: z.enum(['cold', 'warm']),
  turns: z.array(TurnResult),
});

export const DimensionResult = z.object({
  dimension: Id,
  policy: z.enum(['worst-of-n', 'majority-of-n', 'percentile', 'mean']),
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
  status: CaseStatus,
  /** true when samples disagree. */
  unstable: z.boolean(),
  knownGap: z.object({ reason: z.string(), issue: z.string().optional() }).optional(),
  dimensions: z.array(DimensionResult),
  samples: z.array(Sample),
});

export const CheckSummary = z.object({
  check: Id,
  applied: z.int().nonnegative(),
  notApplicable: z.int().nonnegative(),
  passed: z.int().nonnegative(),
  failed: z.int().nonnegative(),
  errors: z.int().nonnegative(),
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
