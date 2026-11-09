// The system profile (design §7): yokla.profile.yaml.

import { z } from 'zod';
import { FieldName, FieldPath, Id, JsonPath, LanguageCode, Provenance } from './common.ts';

const HttpRequest = z.strictObject({
  url: z.string().min(1).meta({ description: 'May contain {{env.NAME}}.' }),
  method: z.enum(['POST', 'PUT', 'PATCH']).default('POST'),
  headers: z
    .record(z.string().min(1), z.string())
    .optional()
    .meta({ description: 'Values may contain {{env.NAME}}. Secrets belong in the environment.' }),
  body: z.json().optional().meta({
    description: 'JSON body. String values may contain {{message}}, {{session}} and {{env.NAME}}.',
  }),
  timeoutMs: z.int().min(1).max(600_000).default(30_000),
});

const EvidenceCollection = z.strictObject({
  items: JsonPath.meta({
    description: 'Where the items are in the response, e.g. $.data.products[*].',
  }),
  fields: z.record(FieldName, FieldPath).meta({
    description: 'Evidence field name → path inside each item, e.g. price: price.amount.',
  }),
});

const HttpResponse = z.strictObject({
  text: JsonPath.meta({ description: "Where the assistant's answer text is." }),
  route: JsonPath.optional(),
  evidence: z.record(Id, EvidenceCollection).optional(),
});

const Session = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('client') }),
  z.strictObject({ mode: z.literal('none') }),
  z.strictObject({
    mode: z.literal('server'),
    id: JsonPath.meta({ description: 'Where the server returns the session id.' }),
  }),
]);

const Limits = z.strictObject({
  burstPerSecond: z.number().positive().optional(),
  perMinute: z.number().positive().optional(),
});

const CacheBypass = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('header'),
    name: z.string().min(1),
    value: z.string().default('1'),
  }),
  z.strictObject({ kind: z.literal('none') }),
]);

const Target = z.strictObject({
  name: z.string().min(1),
  adapter: z.literal('http'),
  request: HttpRequest,
  response: HttpResponse,
  session: Session.default({ mode: 'client' }),
  limits: Limits.optional(),
  cacheBypass: CacheBypass.default({ kind: 'none' }),
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
