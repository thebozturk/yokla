// Case files (design §9): cases/*.yaml. One file holds one or more cases.

import { z } from 'zod';
import { Id, LanguageCode, Provenance, Suite } from './common.ts';

export const KnownGap = z.strictObject({
  reason: z.string().min(1),
  issue: z.string().min(1).optional(),
});

/** Builds the case shape; packs contribute the keys of `expect`. */
export function caseShape(language: z.ZodType<string>, expect: z.ZodType) {
  return {
    id: Id,
    title: z.string().min(1).optional(),
    suite: Suite,
    language,
    turns: z
      .array(
        z.strictObject({
          user: z.string().min(1),
          expect: expect
            .optional()
            .meta({ description: 'Expectations for the response to this turn.' }),
        }),
      )
      .min(1),
    samples: z
      .int()
      .min(1)
      .max(100)
      .optional()
      .meta({ description: 'Defaults per suite (design §11).' }),
    checks: z
      .array(Id)
      .min(1)
      .optional()
      .meta({ description: 'Run only these checks. By default every applicable check runs.' }),
    knownGap: KnownGap.optional(),
    tags: z.array(Id).default([]),
    provenance: Provenance.optional(),
  };
}

const BaseCase = z.strictObject(caseShape(LanguageCode, z.record(z.string(), z.unknown())));

/** A validated case. Packs read their own expectation keys. */
export type Case = z.output<typeof BaseCase>;
export type CaseTurn = Case['turns'][number];
export type CaseFile = { readonly version: 1; readonly cases: readonly Case[] };
