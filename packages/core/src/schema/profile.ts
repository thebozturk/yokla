// The system profile (design §7): yokla.profile.yaml.
// Everything specific to a target is configuration here, never code (P9).

import { z } from 'zod';
import { FieldName, FieldPath, Id, JsonPath, LanguageCode, Provenance } from './common.ts';
import { PromptStore } from './proxy.ts';

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

/** ADR-0016: an answer streamed as events, turned into one document the other paths read. */
const ResponseStream = z
  .strictObject({
    format: z.enum(['sse', 'ndjson']),
    event: JsonPath.optional().meta({
      description:
        "Where an event's name is in its data; by default the SSE event field, else message.",
    }),
    text: z
      .strictObject({ event: z.string().min(1), from: JsonPath })
      .meta({ description: 'The events that carry text pieces, and where the piece is.' }),
    done: z.string().min(1).optional().meta({
      description: 'The event that ends a complete answer; without it, the answer is incomplete.',
    }),
    error: z
      .strictObject({ event: z.string().min(1), from: JsonPath.optional() })
      .optional()
      .meta({ description: 'The event that reports a failure, and where its message is.' }),
  })
  .meta({
    description:
      'The paths below then read {text, events, all, last}: the joined text, every event, and per event name all its data and the last.',
  });

const HttpResponse = z.strictObject({
  stream: ResponseStream.optional(),
  text: JsonPath.meta({ description: "Where the assistant's answer text is." }),
  route: JsonPath.optional(),
  id: JsonPath.optional().meta({ description: "Where the target's own request id is." }),
  clarification: z
    .strictObject({ routes: z.array(z.string().min(1)).min(1) })
    .optional()
    .meta({
      description:
        'Routes that mean the target asked a clarifying question; product expectations then do not apply to that turn.',
    }),
  evidence: z.record(Id, EvidenceCollection).optional(),
});

const Carry = z.array(z.strictObject({ name: FieldName, from: JsonPath }));

/** ADR-0016: a request that opens the target's own session before the first turn. */
const SessionOpen = z.strictObject({
  request: HttpRequest.meta({
    description:
      'The url may be a path, such as /api/session, resolved against the target url. No {{message}}.',
  }),
  carry: Carry.min(1).meta({
    description: 'Values read from its answer and sent with every turn as {{carry.NAME}}.',
  }),
});

const Session = z
  .strictObject({
    mode: z
      .enum(['client', 'none'])
      .default('client')
      .meta({ description: 'client: yokla sends a new {{session}} id per sample.' }),
    carry: Carry.default([]).meta({
      description:
        'Values read from each response and sent with the next turn as {{carry.NAME}}, e.g. a server-issued conversation id.',
    }),
    open: SessionOpen.optional(),
  })
  .refine(
    (session) => {
      const names = [...session.carry, ...(session.open?.carry ?? [])].map((entry) => entry.name);
      return new Set(names).size === names.length;
    },
    { message: 'each carried name must be read in one place only', path: ['carry'] },
  );

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
      z
        .strictObject({
          kind: z.literal('command'),
          run: Command,
          timeoutMs: z.int().min(1).max(600_000).default(30_000),
        })
        .meta({
          description: 'Arguments may contain {{startedAt}}, the run start as an ISO 8601 time.',
        }),
    ]),
    contains: z.string().min(1).optional().meta({
      description:
        'Only lines whose text (colour codes removed) contains this, e.g. a log context outside the JSON.',
    }),
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

const Upstream = z.strictObject({
  id: Id.meta({ description: 'The app reaches this upstream at http://127.0.0.1:<port>/<id>.' }),
  kind: z.enum(['openai-compatible', 'anthropic']),
  upstream: z
    .url({ protocol: /^https?$/u })
    .meta({ description: 'The real provider base URL, e.g. https://api.openai.com/v1.' }),
  appBaseUrlEnv: z
    .string()
    .min(1)
    .optional()
    .meta({ description: "The app's setting that points it at the proxy; for people to read." }),
});

/** A pattern whose matches `redacted` replaces; it must compile and must not match empty text. */
const RedactPattern = z
  .string()
  .min(1)
  .superRefine((source, context) => {
    let pattern: RegExp;
    try {
      pattern = new RegExp(source, 'u');
    } catch (error) {
      context.addIssue({
        code: 'custom',
        message: `not a regular expression: ${error instanceof Error ? error.message : String(error)}`,
      });
      return;
    }
    if (pattern.test('')) context.addIssue({ code: 'custom', message: 'matches empty text' });
  });

/** ADR-0015: what of each call's prompt is written to results and records files. */
const PromptStorage = z
  .strictObject({
    store: PromptStore.default('sizes').meta({
      description:
        'sizes: role and length; hashed: plus a SHA-256; redacted: plus the text with the redact patterns replaced; full: plus the hash and the text.',
    }),
    redact: z.array(RedactPattern).min(1).optional().meta({
      description: 'Regular expressions (Unicode mode) whose matches redacted replaces.',
    }),
  })
  .refine((storage) => storage.store !== 'redacted' || storage.redact !== undefined, {
    message: 'store: redacted needs at least one redact pattern',
    path: ['redact'],
  });

/** ADR-0015: what the inspection checks look for in the prompts the proxy captures. */
const Inspect = z.strictObject({
  canary: z.string().min(8).optional().meta({
    description:
      "A string the app's system prompt contains; prompt-leak fails when the answer contains it.",
  }),
  untrusted: z.record(Id, z.array(FieldName).min(1)).optional().meta({
    description:
      'Evidence fields that hold retrieved content, per collection, e.g. { products: [name] }; untrusted-in-system fails when one of their values is in a system message.',
  }),
});

/** ADR-0012: the model proxy between the app and its providers. */
const ModelProxy = z.strictObject({
  port: z.int().min(1).max(65_535).default(8787),
  upstreams: z
    .array(Upstream)
    .min(1)
    .refine((list) => new Set(list.map((u) => u.id)).size === list.length, {
      message: 'upstream ids must be unique',
    }),
  correlation: z.enum(['serial', 'header']).default('serial').meta({
    description:
      'serial: one request in flight; header: the app forwards x-yokla-trace to its provider calls.',
  }),
  prompts: PromptStorage.default({ store: 'sizes' }),
  inspect: Inspect.optional(),
  settle: z
    .strictObject({
      quietMs: z.int().min(0).max(600_000).default(250),
      maxWaitMs: z.int().min(0).max(600_000).default(10_000),
    })
    .default({ quietMs: 250, maxWaitMs: 10_000 })
    .meta({
      description:
        "ADR-0016: after each answer (serial) and before the run ends, wait until the target's model calls stop: none in flight, none for quietMs.",
    }),
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
  modelProxy: ModelProxy.optional(),
  refusal: z
    .strictObject({
      canonical: z.partialRecord(LanguageCode, z.array(z.string().min(1)).min(1)).optional(),
    })
    .optional(),
};

const BaseProfile = z.strictObject(profileShape);

/** A validated profile. Domain packs read their own section by key. */
export type Profile = z.output<typeof BaseProfile> & { readonly [section: string]: unknown };
export type ProfileTarget = z.output<typeof Target>;
export type ModelProxyConfig = z.output<typeof ModelProxy>;
export type FieldSpec = z.output<typeof FieldSpec>;
export type ResponseStream = z.output<typeof ResponseStream>;

/** Problems between profile sections: untrusted fields must be evidence fields the profile maps. */
export function profileProblems(
  profile: Pick<Profile, 'target' | 'modelProxy'>,
): { path: (string | number)[]; message: string }[] {
  const problems: { path: (string | number)[]; message: string }[] = [];
  const evidence = profile.target.response.evidence ?? {};
  for (const [name, fields] of Object.entries(profile.modelProxy?.inspect?.untrusted ?? {})) {
    const path = ['modelProxy', 'inspect', 'untrusted', name];
    const collection = evidence[name];
    if (collection === undefined) {
      problems.push({ path, message: `the profile maps no evidence collection "${name}"` });
      continue;
    }
    for (const [index, field] of fields.entries()) {
      if (!(field in collection.fields)) {
        problems.push({
          path: [...path, index],
          message: `evidence collection "${name}" maps no field "${field}"`,
        });
      }
    }
  }
  return problems;
}
