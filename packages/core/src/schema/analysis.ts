// The analysis report (ADR-0047): what yokla analyze inventoried, probed and
// proposed, and how the proposal compares with a profile. It holds paths,
// kinds, shapes and the proposed entries; never a file's content or an
// answer's values.

import { z } from 'zod';
import { Provenance } from './common.ts';

export const ANALYSIS_SCHEMA_ID = 'yokla.analysis/v1';

/** What a file of the target's repository is (ADR-0047). */
export const INVENTORY_KINDS = [
  'data',
  'contract',
  'prompt',
  'doc',
  'env-example',
  'manifest',
  'code',
  'other',
] as const;
export const InventoryKind = z.enum(INVENTORY_KINDS);
export type InventoryKind = z.output<typeof InventoryKind>;

const Entry = z.object({ pointer: z.string(), value: z.json() });

export const Analysis = z
  .object({
    schema: z.literal(ANALYSIS_SCHEMA_ID),
    yokla: z.object({ version: z.string() }),
    inventory: z.object({
      /** Each file listed: its path in the repository, its kind and its size. */
      files: z.array(
        z.object({ path: z.string(), kind: InventoryKind, bytes: z.int().nonnegative() }),
      ),
      /** Files left out: binary, too large, or yokla's own. */
      skipped: z.int().nonnegative(),
      /** The listing stopped at --max-files. */
      capped: z.boolean(),
    }),
    /** The messages sent to the target, and the shape of each answer, without its values. */
    probes: z.array(
      z.object({
        message: z.string(),
        status: z.int(),
        latencyMs: z.number().nonnegative(),
        shape: z.string(),
      }),
    ),
    /** The proposed entries, each with where it came from. */
    entries: z.array(Entry.extend({ provenance: Provenance })),
    /** The model step (ADR-0049): what it read, what it cost, and whether the cap stopped it. */
    model: z
      .object({
        model: z.string(),
        calls: z.int().nonnegative(),
        /** Replies the cache gave, which cost nothing. */
        cached: z.int().nonnegative(),
        inputTokens: z.int().nonnegative().nullable(),
        outputTokens: z.int().nonnegative().nullable(),
        /** null when a call had no cost. */
        costUsd: z.number().nonnegative().nullable(),
        sent: z.array(z.string()),
        left: z.array(z.string()),
        partial: z.boolean(),
        /** The chunks whose reply couldn't be read: cut at maxTokens, or not JSON (ADR-0051). */
        unread: z.array(z.object({ files: z.array(z.string()), reason: z.string() })),
      })
      .optional(),
    /** Each contract file read, and what became of it (ADR-0057). */
    contracts: z
      .array(
        z.object({
          file: z.string(),
          /** What in it was read, such as `POST /v1/chat 200 application/json`. */
          read: z.string().optional(),
          at: z.string().optional(),
          outcome: z.enum(['proposed', 'no-operation', 'unusable', 'violated']),
          /** Why, and the keywords left out; a violation by its path and keyword, never a value. */
          details: z.array(z.string()),
        }),
      )
      .optional(),
    /** Values the model returned that failed their check, never proposed (ADR-0049). */
    unverified: z
      .array(z.object({ field: z.string(), file: z.string(), line: z.int(), reason: z.string() }))
      .optional(),
    /** Pointers whose verified values disagree; none is proposed (ADR-0049). */
    conflicts: z.array(z.object({ pointer: z.string(), evidence: z.array(z.string()) })).optional(),
    /** The proposal compared with a profile, entry by entry. */
    comparison: z
      .object({
        profile: z.string(),
        same: z.array(Entry),
        different: z.array(Entry.extend({ reference: z.json() })),
        new: z.array(Entry),
        missed: z.array(Entry),
        precision: z.number().min(0).max(1).nullable(),
        recall: z.number().min(0).max(1).nullable(),
        /**
         * The same comparison without target.response.schema, whose leaves
         * count one by one; absent when neither side has one (ADR-0065).
         */
        withoutSchema: z
          .object({
            same: z.int().min(0),
            different: z.int().min(0),
            new: z.int().min(0),
            missed: z.int().min(0),
            precision: z.number().min(0).max(1).nullable(),
            recall: z.number().min(0).max(1).nullable(),
          })
          .optional(),
      })
      .optional(),
  })
  .meta({ title: 'yokla analysis v1' });
export type Analysis = z.output<typeof Analysis>;
