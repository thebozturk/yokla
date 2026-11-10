// yokla.config.yaml (design §16, ADR-0010): settings for judging runs. Like
// the profile, it is a config file: unknown keys are errors.

import { z } from 'zod';
import { Suite } from './common.ts';

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

export const YoklaConfig = z.strictObject({
  version: z.literal(1),
  gate: GateConfig.default({}),
});
export type YoklaConfig = z.output<typeof YoklaConfig>;
