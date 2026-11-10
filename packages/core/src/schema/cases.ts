// Case files (design §9): cases/*.yaml. One file holds one or more cases.

import { z } from 'zod';
import { Id, LanguageCode, Provenance, Suite } from './common.ts';
import { FaultPlan } from './fault.ts';

export const KnownGap = z.strictObject({
  reason: z.string().min(1),
  issue: z.string().min(1).optional(),
});

/** Domain-neutral expectations every case may use. Packs add their own keys. */
export const coreExpectations = {
  route: z
    .union([z.string().min(1), z.array(z.string().min(1)).min(1)])
    .meta({ description: 'The route(s) that may answer this turn.' }),
  answer: z
    .strictObject({
      contains: z.array(z.string().min(1)).min(1).optional(),
      notContains: z.array(z.string().min(1)).min(1).optional(),
    })
    .meta({
      description: "Text the answer must or must not contain, after the language pack's folding.",
    }),
  deadlineMs: z
    .int()
    .min(1)
    .meta({ description: 'The answer must arrive within this many milliseconds.' }),
  evidence: z
    .record(
      Id,
      z.strictObject({
        min: z.int().min(0).optional(),
        max: z.int().min(0).optional(),
        includes: z
          .array(z.string().min(1))
          .min(1)
          .optional()
          .meta({ description: 'Item ids that must be returned.' }),
      }),
    )
    .meta({ description: 'Expectations per evidence collection, e.g. products: { min: 1 }.' }),
};

const TurnRequest = z
  .strictObject({
    body: z
      .json()
      .optional()
      .meta({ description: 'Merged into the profile body: objects merge, other values replace.' }),
    headers: z.record(z.string().min(1), z.string()).optional(),
  })
  .meta({ description: 'Extra request content for this turn only.' });

/** Builds the case shape; packs contribute the keys of `expect`. */
export function caseShape<E extends z.ZodType>(language: z.ZodType<string>, expect: E) {
  return {
    id: Id,
    title: z.string().min(1).optional(),
    suite: Suite,
    language,
    turns: z
      .array(
        z.strictObject({
          user: z.string().min(1),
          request: TurnRequest.optional(),
          faults: z.array(FaultPlan).min(1).optional().meta({
            description:
              'Provider faults the model proxy injects into this turn (ADR-0013); the first plan that matches a call applies.',
          }),
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
