// Case files (design §9): cases/*.yaml. One file holds one or more cases.

import { z } from 'zod';
import { Id, LanguageCode, Pattern, Provenance, SchemaRule, Suite } from './common.ts';
import { squeeze } from '../text/match.ts';
import { FaultPlan } from './fault.ts';
import { ToolInjection } from './proxy.ts';

export const KnownGap = z.strictObject({
  reason: z.string().min(1),
  issue: z.string().min(1).optional(),
});

/** The kinds of request a turn may say it is (ADR-0075). A fourth needs its own ADR. */
export const REQUEST_KINDS = ['chitchat', 'handoff', 'support'] as const;
export type RequestKind = (typeof REQUEST_KINDS)[number];

/** Domain-neutral expectations every case may use. Packs add their own keys. */
export const coreExpectations = {
  route: z
    .union([z.string().min(1), z.array(z.string().min(1)).min(1)])
    .meta({ description: 'The route(s) that may answer this turn.' }),
  answer: z
    .strictObject({
      contains: z.array(z.string().min(1)).min(1).optional(),
      notContains: z.array(z.string().min(1)).min(1).optional(),
      matches: z.array(Pattern).min(1).optional().meta({
        description: 'Regular expressions the answer must match (ADR-0030).',
      }),
      notMatches: z.array(Pattern).min(1).optional().meta({
        description: 'Regular expressions the answer must not match (ADR-0030).',
      }),
      notEmpty: z.literal(true).optional().meta({
        description: 'The answer text has at least one letter or digit (ADR-0018).',
      }),
    })
    .meta({
      description:
        "Text the answer must or must not contain, after the language pack's folding; patterns it must or must not match, as it came; and whether it may be empty.",
    }),
  language: LanguageCode.meta({
    description: 'The language the answer must be in, judged by language-match (ADR-0018).',
  }),
  internals: z.literal(true).meta({
    description:
      "The turn asks for the assistant's internals; judged by internals-leak: the answer names no model, tool or profile marker (ADR-0082).",
  }),
  request: z.enum(REQUEST_KINDS).meta({
    description:
      'What kind of request the turn is, judged by request-handled (ADR-0075): chitchat (a greeting, thanks, small talk), handoff (the user asks for a person) or support (a question about their own order, payment, account, return or delivery).',
  }),
  similar: z
    .strictObject({
      to: z.array(z.string().min(1)).min(1).meta({ description: 'The reference answers.' }),
      min: z.number().min(0).max(1).optional().meta({
        description: 'Pass when the answer scores at least this against one reference.',
      }),
      max: z.number().min(0).max(1).optional().meta({
        description: 'Pass when the answer scores at most this against every reference.',
      }),
    })
    .refine((similar) => similar.min !== undefined || similar.max !== undefined, {
      message: 'similar needs min or max: a threshold chosen for the case',
    })
    .refine((similar) => (similar.min ?? 0) <= (similar.max ?? 1), {
      message: 'similar.min is above similar.max, so no answer could pass',
    })
    .meta({
      description:
        "How close the answer's wording must stay to reference answers, or how far from them, from 0 to 1: the cosine similarity of character trigrams, after the language pack's folding. Judged by answer-similarity (ADR-0030).",
    }),
  custom: z.record(z.string().min(1), z.json()).meta({
    description:
      "Values for the checks the configuration loads, by check id, each validated by the check's own expect schema (ADR-0030).",
  }),
  schema: z.array(SchemaRule).min(1).meta({
    description:
      'JSON Schemas the response, or parts of it, must match, judged by json-schema (ADR-0030).',
  }),
  allowStatus: z.array(z.int().min(300).max(599)).min(1).meta({
    description:
      'Non-2xx statuses that count as a handled answer, such as 400 for an empty message. The turn is then judged on its status, never stopped by it (ADR-0018).',
  }),
  deadlineMs: z
    .int()
    .min(1)
    .meta({ description: 'The answer must arrive within this many milliseconds.' }),
  budget: z
    .strictObject({
      costUsd: z.number().nonnegative().optional(),
      modelCalls: z.int().min(0).optional(),
      inputTokens: z.int().min(0).optional().meta({
        description: 'The most input tokens any one model call of the turn may send (ADR-0015).',
      }),
      outputTokens: z.int().min(0).optional().meta({
        description: 'The most output tokens any one model call of the turn may write (ADR-0082).',
      }),
    })
    .refine(
      (budget) =>
        budget.costUsd !== undefined ||
        budget.modelCalls !== undefined ||
        budget.inputTokens !== undefined ||
        budget.outputTokens !== undefined,
      { message: 'a budget needs costUsd, modelCalls, inputTokens or outputTokens' },
    )
    .meta({
      description:
        "The most the turn's model calls may cost, how many there may be (ADR-0014), and how large each prompt may be (ADR-0015).",
    }),
  notSentToModel: z
    .array(
      z
        .string()
        .min(1)
        .refine((value) => squeeze(value).length >= 3, {
          message: 'needs at least 3 characters besides spaces, dots, dashes and parentheses',
        }),
    )
    .min(1)
    .meta({
      description:
        "Seeded values, such as fake personal data, that must not appear in any message of the turn's model calls (ADR-0015).",
    }),
  tools: z
    .strictObject({
      called: z.array(z.string().min(1)).min(1).optional().meta({
        description: 'Tools the model must ask for at least once in the turn.',
      }),
      notCalled: z
        .array(z.string().min(1))
        .min(1)
        .optional()
        .meta({ description: 'Tools the model must not ask for in the turn.' }),
      args: z
        .record(z.string().min(1), z.record(z.string().min(1), z.json()))
        .optional()
        .meta({
          description:
            'Per tool, argument values some call of it must have; a dotted path into its arguments, e.g. filters.priceMax.',
        }),
      order: z.array(z.string().min(1)).min(2).optional().meta({
        description: 'Tools that must be asked for in this order; other calls may come between.',
      }),
      maxCalls: z
        .int()
        .min(0)
        .optional()
        .meta({ description: 'The most tool calls the turn may ask for.' }),
    })
    .refine((tools) => Object.values(tools).some((value) => value !== undefined), {
      message: 'tools needs called, notCalled, args, order or maxCalls',
    })
    .meta({
      description:
        "What the turn's model calls must and must not ask of tools, judged by tool-calls (ADR-0025).",
    }),
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
        excludes: z
          .array(z.string().min(1))
          .min(1)
          .optional()
          .meta({ description: 'Item ids that must not be returned (ADR-0082).' }),
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

/** What ends a simulated conversation: expectations judged from the answer alone (ADR-0028). */
const Reached = z
  .strictObject({
    route: coreExpectations.route.optional(),
    answer: coreExpectations.answer.optional(),
    evidence: coreExpectations.evidence.optional(),
  })
  .refine((reached) => Object.values(reached).some((value) => value !== undefined), {
    message: 'reached needs route, answer or evidence',
  })
  .meta({
    description:
      'The goal is reached after the first answer that meets these, judged as the turn expectations of the same names.',
  });

/** A simulated customer instead of fixed turns (ADR-0028). */
function customerShape<E extends z.ZodType>(expect: E) {
  return z
    .strictObject({
      persona: z.string().min(1).meta({ description: 'Who the customer is.' }),
      goal: z.string().min(1).meta({ description: 'What the customer wants, in its words.' }),
      opening: z
        .string()
        .min(1)
        .optional()
        .meta({ description: 'The first message, as written; else the customer writes it.' }),
      maxTurns: z.int().min(1).max(20),
      reached: Reached,
      expect: expect
        .optional()
        .meta({ description: 'Expectations for every answer of the conversation.' }),
    })
    .meta({
      description:
        "A model plays the customer, with the configuration's models.customer; the conversation ends once reached holds, or at maxTurns.",
    });
}

/** A case has fixed turns or a simulated customer, never both (ADR-0028). */
export function caseDriverProblem(value: {
  readonly turns: readonly unknown[];
  readonly customer?: unknown;
}): string | undefined {
  if (value.customer !== undefined && value.turns.length > 0) {
    return 'a case has turns or a customer, not both';
  }
  if (value.customer === undefined && value.turns.length === 0) {
    return 'a case needs at least one turn, or a customer';
  }
  return undefined;
}

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
          toolResults: z.array(ToolInjection).min(1).optional().meta({
            description:
              "Text the model proxy injects into a tool's results in this turn, before the model sees them (ADR-0043).",
          }),
          expect: expect
            .optional()
            .meta({ description: 'Expectations for the response to this turn.' }),
        }),
      )
      .default([]),
    customer: customerShape(expect).optional(),
    samples: z.int().min(1).max(100).optional().meta({
      description: 'How many times to run the case. Default: yokla run --samples, else 1.',
    }),
    checks: z
      .array(Id)
      .min(1)
      .optional()
      .meta({ description: 'Run only these checks. By default every applicable check runs.' }),
    knownGap: KnownGap.optional(),
    tags: z.array(Id).default([]).meta({
      description:
        'Labels the summary groups the results by, and yokla run --tag selects cases by (ADR-0077).',
    }),
    weight: z.number().positive().optional().meta({
      description:
        "The case's share of traffic, in any unit; only ratios matter. The summary's weighted pass rate counts a case by its weight (ADR-0076). Default: 1.",
    }),
    provenance: Provenance.optional(),
  };
}

const BaseCase = z
  .strictObject(caseShape(LanguageCode, z.record(z.string(), z.unknown())))
  .superRefine((value, context) => {
    const problem = caseDriverProblem(value);
    if (problem !== undefined)
      context.addIssue({ code: 'custom', path: ['turns'], message: problem });
  });

/** A validated case. Packs read their own expectation keys. */
export type Case = z.output<typeof BaseCase>;
export type CaseTurn = Case['turns'][number];
export type CaseCustomer = NonNullable<Case['customer']>;
export type CaseFile = { readonly version: 1; readonly cases: readonly Case[] };
