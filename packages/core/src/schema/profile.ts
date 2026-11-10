// The system profile (design §7): yokla.profile.yaml.
// Everything specific to a target is configuration here, never code (P9).

import { z } from 'zod';
import { FieldName, FieldPath, Id, JsonPath, LanguageCode, Provenance } from './common.ts';

/** A command run locally as an argument list, never through a shell. */
const Command = z
  .array(z.string().min(1))
  .min(1)
  .meta({ description: 'Program and arguments, e.g. [docker, compose, logs, backend]. No shell.' });

const HttpRequest = z.strictObject({
  url: z.string().min(1).meta({ description: 'May contain {{env.NAME}}.' }),
  method: z.enum(['POST', 'PUT', 'PATCH']).default('POST'),
  headers: z
    .record(z.string().min(1), z.string())
    .optional()
    .meta({ description: 'Values may contain {{env.NAME}}. Secrets belong in the environment.' }),
  body: z
    .json()
    .optional()
    .meta({
      description:
        'JSON body. Strings may contain {{message}}, {{session}}, {{requestId}}, {{carry.NAME}} and {{env.NAME}}. ' +
        'A string that is only a placeholder with no value is left out.',
    }),
  timeoutMs: z.int().min(1).max(600_000).default(30_000),
  requestId: z
    .strictObject({ header: z.string().min(1) })
    .optional()
    .meta({ description: 'Send a unique id per request in this header, for log correlation.' }),
});

/** Where a field's value is: one path, or several tried in order until one is not null. */
export const FieldSpec = z.union([
  FieldPath,
  z.strictObject({
    from: z.union([FieldPath, z.array(FieldPath).min(1)]),
    as: z
      .enum(['string', 'number', 'boolean'])
      .optional()
      .meta({ description: 'Convert the value, e.g. a decimal string to a number.' }),
  }),
]);

const EvidenceCollection = z.strictObject({
  items: JsonPath.meta({
    description: 'Where the items are in the response, e.g. $.data.products[*].',
  }),
  fields: z.record(FieldName, FieldSpec).meta({
    description:
      'Evidence field → where it is in each item, e.g. price: price.amount, or ' +
      'price: { from: [price.salePrice, price.listPrice], as: number }.',
  }),
});

const HttpResponse = z.strictObject({
  text: JsonPath.meta({ description: "Where the assistant's answer text is." }),
  route: JsonPath.optional(),
  id: JsonPath.optional().meta({ description: "Where the target's own request id is." }),
  evidence: z.record(Id, EvidenceCollection).optional(),
});

const Session = z.strictObject({
  mode: z
    .enum(['client', 'none'])
    .default('client')
    .meta({ description: 'client: yokla sends a new {{session}} id per sample.' }),
  carry: z
    .array(z.strictObject({ name: FieldName, from: JsonPath }))
    .default([])
    .meta({
      description:
        'Values read from each response and sent with the next turn as {{carry.NAME}}, e.g. a server-issued conversation id.',
    }),
});

const Limits = z.strictObject({
  burstPerSecond: z.number().positive().optional(),
  perMinute: z.number().positive().optional(),
  perHour: z.number().positive().optional(),
  retryAfter: z
    .strictObject({
      headers: z.array(z.string().min(1)).min(1).default(['retry-after']).meta({
        description: 'Header names to read; a trailing * matches a prefix, e.g. retry-after-*.',
      }),
      unit: z.enum(['seconds', 'milliseconds']).default('seconds'),
      maxWaitMs: z.int().min(0).max(3_600_000).default(60_000),
    })
    .default({ headers: ['retry-after'], unit: 'seconds', maxWaitMs: 60_000 }),
  clientIdentity: z
    .strictObject({
      header: z.string().min(1).meta({ description: 'e.g. x-forwarded-for' }),
      pool: z
        .literal('test-net')
        .meta({ description: 'Addresses from the TEST-NET ranges (RFC 5737).' }),
      per: z.enum(['case', 'sample']).default('case'),
    })
    .optional()
    .meta({
      description: 'Opt-in: send a rotating client address when the target limits per address.',
    }),
});

const CacheBypass = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('header'),
    name: z.string().min(1),
    value: z.string().default('1'),
  }),
  z
    .strictObject({
      kind: z.literal('command'),
      run: Command,
      timeoutMs: z.int().min(1).max(600_000).default(30_000),
    })
    .meta({ description: 'Runs before each cold sample, e.g. to clear the target cache.' }),
  z.strictObject({ kind: z.literal('none') }),
]);

/** A field read from a log line: a path, or a path over an array with a reduction. */
const LogField = z.union([
  JsonPath,
  z.strictObject({
    from: JsonPath,
    reduce: z.enum(['first', 'sum', 'count', 'any', 'all']).default('first'),
  }),
]);

const LogSource = z
  .strictObject({
    source: z.discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('file'), path: z.string().min(1) }),
      z.strictObject({
        kind: z.literal('command'),
        run: Command,
        timeoutMs: z.int().min(1).max(600_000).default(30_000),
      }),
    ]),
    match: z
      .array(
        z.strictObject({ path: JsonPath, equals: z.union([z.string(), z.number(), z.boolean()]) }),
      )
      .default([])
      .meta({ description: 'Only lines where every path has this value, e.g. a log context.' }),
    correlate: z.strictObject({
      by: z.enum(['request-id', 'target-id', 'order']),
      field: JsonPath.optional().meta({ description: 'The line field holding the id.' }),
    }),
    fields: z.record(FieldName, LogField),
  })
  .meta({ description: 'ADR-0009. Lines are JSON; text before the first "{" is ignored.' });

const Target = z.strictObject({
  name: z.string().min(1),
  adapter: z.literal('http'),
  request: HttpRequest,
  response: HttpResponse,
  session: Session.default({ mode: 'client', carry: [] }),
  limits: Limits.optional(),
  cacheBypass: CacheBypass.default({ kind: 'none' }),
  observe: z.strictObject({ logs: LogSource.optional() }).optional(),
});

const Capability = z.strictObject({
  id: Id,
  description: z.string().min(1).optional(),
  provenance: Provenance.optional(),
});

/** Profile fields that don't depend on packs. */
export const profileShape = {
  version: z.literal(1),
  target: Target,
  languages: z.array(LanguageCode).min(1),
  domain: Id,
  capabilities: z.array(Capability).default([]),
  refusal: z
    .strictObject({
      canonical: z.record(LanguageCode, z.array(z.string().min(1)).min(1)).optional(),
    })
    .optional(),
};

const BaseProfile = z.strictObject(profileShape);

/** A validated profile. Domain packs read their own section by key. */
export type Profile = z.output<typeof BaseProfile> & { readonly [section: string]: unknown };
export type ProfileTarget = z.output<typeof Target>;
export type FieldSpec = z.output<typeof FieldSpec>;
