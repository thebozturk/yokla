// A cassette (ADR-0040): the model calls of a recorded run, to answer them
// again. It holds the providers' answers in full, which may carry the
// target's data, so it is kept like a results file.

import { z } from 'zod';
import { TransformKind } from './common.ts';
import { CassetteCall } from './proxy.ts';

export const CASSETTE_SCHEMA_ID = 'yokla.cassette/v1';

export const Cassette = z.object({
  schema: z.literal(CASSETTE_SCHEMA_ID),
  /** The SHA-256 of the profile the run was recorded with. */
  profileSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  recordedAt: z.iso.datetime(),
  /**
   * The transforms of the run's messages (ADR-0045); a replay with others is
   * refused, since every call would diverge.
   */
  transforms: z.array(TransformKind).optional(),
  calls: z.array(CassetteCall),
});
export type Cassette = z.output<typeof Cassette>;
