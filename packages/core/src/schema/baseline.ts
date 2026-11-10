// yokla.baseline/v1 (ADR-0011): the accepted state of a suite, small enough to
// commit and review. It holds no answers, evidence or timings. Objects are
// open, like results.v1: later v1 versions may add optional fields.

import { z } from 'zod';
import { Id, Suite } from './common.ts';
import { CaseStatus } from './results.ts';

export const BASELINE_SCHEMA_ID = 'yokla.baseline/v1';

const Sha256 = z.string().regex(/^[a-f0-9]{64}$/u);

export const Baseline = z.object({
  schema: z.literal(BASELINE_SCHEMA_ID),
  yokla: z.object({ version: z.string().min(1) }),
  /** The run the baseline was accepted from. */
  run: z.object({
    id: z.string().min(1),
    startedAt: z.iso.datetime(),
    profile: z.object({ target: z.string(), sha256: Sha256 }),
  }),
  /** Sorted by id. */
  cases: z.array(
    z.object({
      id: Id,
      suite: Suite,
      status: CaseStatus,
      definitionSha256: Sha256.optional(),
    }),
  ),
});
export type Baseline = z.output<typeof Baseline>;
