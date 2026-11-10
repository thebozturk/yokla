// yokla.config.yaml (design §16, ADR-0010): settings for judging runs. Like
// the profile, it is a config file: unknown keys are errors.

import { z } from 'zod';
import { Id, Suite } from './common.ts';

const Thresholds = z.strictObject({
  maxFailures: z
    .int()
    .nonnegative()
    .optional()
    .meta({ description: 'Cases with status fail a suite may have. Default 0.' }),
  allowUnmeasured: z.boolean().optional().meta({
    description:
      'Whether a suite may have unmeasured cases and thresholds. Default false: unmeasured is never a pass.',
  }),
  latencyP50Ms: z.number().nonnegative().optional().meta({
    description: 'The median latency of the answered turns, every sample included (ADR-0014).',
  }),
  latencyP95Ms: z.number().nonnegative().optional().meta({
    description: 'The 95th percentile latency of the answered turns, every sample included.',
  }),
  costPerTurnUsd: z
    .number()
    .nonnegative()
    .optional()
    .meta({ description: 'The mean model cost of an answered turn, from the model proxy.' }),
  costUsd: z
    .number()
    .nonnegative()
    .optional()
    .meta({ description: "The suite's total model cost, from the model proxy." }),
});

export const GateConfig = Thresholds.extend({
  suites: z
    .partialRecord(Suite, Thresholds)
    .optional()
    .meta({ description: 'Overrides per suite of the thresholds above.' }),
});
export type GateConfig = z.output<typeof GateConfig>;

const Price = z
  .strictObject({
    input: z.number().nonnegative(),
    output: z.number().nonnegative(),
    cachedInput: z
      .number()
      .nonnegative()
      .optional()
      .meta({ description: 'Defaults to the input price, so cost is never understated.' }),
    cacheWrite: z
      .number()
      .nonnegative()
      .optional()
      .meta({ description: 'Defaults to the input price, so cost is never understated.' }),
  })
  .meta({ description: 'USD per million tokens.' });
export type Price = z.output<typeof Price>;

export const YoklaConfig = z.strictObject({
  version: z.literal(1),
  gate: GateConfig.default({}),
  prices: z
    .record(Id, z.record(z.string().min(1), Price))
    .default({})
    .meta({
      description:
        'Per upstream id, per model as the provider reports it (ADR-0012). A model without a price has no cost.',
    }),
  plan: z
    .strictObject({
      upperBoundFactor: z
        .number()
        .min(1)
        .default(2)
        .meta({ description: 'yokla plan prints the estimate times this as the upper bound.' }),
    })
    .default({ upperBoundFactor: 2 }),
});
export type YoklaConfig = z.output<typeof YoklaConfig>;
