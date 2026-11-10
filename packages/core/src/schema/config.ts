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
      'Whether a suite may have unmeasured cases. Default false: unmeasured is never a pass.',
  }),
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
});
export type YoklaConfig = z.output<typeof YoklaConfig>;
