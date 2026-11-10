// Provider faults the model proxy injects (ADR-0013). Cases declare them per
// turn; the runner arms them on the proxy for that turn only.

import { z } from 'zod';
import { Id } from './common.ts';

export const Fault = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('status'),
    status: z.union([z.literal(429), z.literal(500), z.literal(503)]),
    retryAfterS: z.int().min(0).max(3600).optional(),
  }),
  z.strictObject({
    kind: z.literal('latency'),
    ms: z.int().min(0).max(600_000),
    jitterMs: z.int().min(0).max(600_000).default(0),
  }),
  z.strictObject({
    kind: z.literal('timeout'),
    holdMs: z
      .int()
      .min(1)
      .max(600_000)
      .default(120_000)
      .meta({ description: 'How long the connection stays open without an answer.' }),
  }),
  z.strictObject({ kind: z.literal('malformed-json') }),
  z.strictObject({ kind: z.literal('empty-content') }),
  z.strictObject({ kind: z.literal('truncated-stream') }),
  z.strictObject({ kind: z.literal('invalid-tool-call') }),
]);
export type Fault = z.output<typeof Fault>;
export const FAULT_KINDS = Fault.options.map((option) => option.shape.kind.value);

export const FaultPlan = z.strictObject({
  fault: Fault,
  calls: z
    .array(z.int().min(1))
    .min(1)
    .optional()
    .meta({ description: "The turn's model calls it applies to, from 1. Default: every call." }),
  upstream: Id.optional().meta({ description: 'Only calls to this upstream. Default: every one.' }),
});
export type FaultPlan = z.output<typeof FaultPlan>;
