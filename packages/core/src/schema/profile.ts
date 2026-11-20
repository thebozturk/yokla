// The system profile (design §7): yokla.profile.yaml.
// Everything specific to a target is configuration here, never code (P9).

import { z } from 'zod';
import {
  FieldName,
  FieldPath,
  Id,
  JsonPath,
  LanguageCode,
  Pattern,
  Provenance,
  SchemaRule,
} from './common.ts';
import { PromptStore } from './proxy.ts';
import { resolvePointer } from '../profile/entries.ts';

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
  items: z.union([JsonPath, z.array(JsonPath).min(1)]).meta({
    description:
      'Where the items are in the response, e.g. $.data.products[*]; or several paths, read in order, an item with an id an earlier path returned left out (ADR-0020).',
  }),
  fields: z.record(FieldName, FieldSpec).meta({
    description:
      'Evidence field → where it is in each item, e.g. price: price.amount, or ' +
      'price: { from: [price.salePrice, price.listPrice], as: number }.',
  }),
});

/** ADR-0016: an answer streamed as events, turned into one document the other paths read. */
const streamShape = {
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
};

const STREAM_DOCUMENT =
  'The paths below then read {text, events, all, last}: the joined text, every event, and per event name all its data and the last.';

const ResponseStream = z
  .strictObject({ format: z.enum(['sse', 'ndjson']), ...streamShape })
  .meta({ description: STREAM_DOCUMENT });

/** ADR-0024: a WebSocket answer, one event per message; only `done` ends it. */
const MessageStream = z
  .strictObject({
    ...streamShape,
    event: JsonPath.optional().meta({
      description:
        "Where an event's name is in a message's data; without it, every event is message.",
    }),
    done: z.string().min(1).meta({
      description:
        'The event that ends an answer, such as message for an answer given in one message. Required: the connection stays open.',
    }),
  })
  .meta({ description: STREAM_DOCUMENT });

const HttpResponse = z.strictObject({
  stream: ResponseStream.optional(),
  text: z.union([JsonPath, z.array(JsonPath).min(1)]).meta({
    description:
      "Where the assistant's answer text is; or several paths, every string at each joined in order with a blank line, for answers given as components (ADR-0020).",
  }),
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
  schema: SchemaRule.optional().meta({
    description:
      'A JSON Schema every usable answer, or a part of it, must match: the contract of the response, judged by json-schema (ADR-0030).',
  }),
  contactPhrases: z.array(z.string().min(1)).min(1).optional().meta({
    description:
      "The target's own words for its channels to a person, such as a support URL or a phone line's name, matched after folding. request-handled counts them as a pointer to a person, with the language pack's deflection phrases (ADR-0075).",
  }),
});

/** ADR-0024: a connection opened once per sample, and one message sent per turn. */
const WebSocketRequest = z.strictObject({
  url: z
    .string()
    .regex(/^wss?:\/\//iu, 'use a ws:// or wss:// url')
    .meta({
      description:
        'ws:// or wss://. May contain {{env.NAME}}, {{session}} and the values session.open carries. Sent once, when the connection opens.',
    }),
  headers: z.record(z.string().min(1), z.string()).optional().meta({
    description:
      'Handshake headers, sent once, when the connection opens. Values may contain {{env.NAME}}. Secrets belong in the environment.',
  }),
  protocols: z
    .array(z.string().min(1))
    .min(1)
    .optional()
    .meta({ description: 'Subprotocols to ask for.' }),
  body: z.json().meta({
    description:
      'The message sent for each turn, as JSON text. Strings may contain {{message}}, {{session}}, {{requestId}}, {{carry.NAME}} and {{env.NAME}}.',
  }),
  timeoutMs: z.int().min(1).max(600_000).default(30_000).meta({
    description: 'Bounds opening the connection, and each answer up to its done event.',
  }),
});

const WebSocketResponse = HttpResponse.extend({ stream: MessageStream });

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

/** A single {{env.NAME}} placeholder: a secret stays in the environment (ADR-0031). */
const ENV_ONLY = /^\{\{\s*env\.[A-Za-z_][A-Za-z0-9_]*\s*\}\}$/u;

const authTiming = {
  refreshBeforeMs: z.int().min(0).default(30_000).meta({
    description:
      'Fetch a new token when less than this of its lifetime remains, or less than half of it.',
  }),
};

/** ADR-0031: a token by OAuth 2.0 client credentials (RFC 6749 §4.4). */
const OAuthClientCredentials = z.strictObject({
  kind: z.literal('oauth2-client-credentials'),
  tokenUrl: z.string().min(1).meta({
    description: 'The token endpoint: HTTPS, except to a loopback host.',
  }),
  clientId: z.string().min(1).meta({ description: 'May be {{env.NAME}}.' }),
  clientSecret: z
    .string()
    .regex(ENV_ONLY, 'use a single {{env.NAME}} placeholder: the secret stays in the environment')
    .meta({ description: 'A single {{env.NAME}} placeholder.' }),
  clientAuth: z.enum(['basic', 'body']).default('basic').meta({
    description: 'How the client authenticates: HTTP Basic, or its id and secret in the form.',
  }),
  scope: z.string().min(1).optional(),
  params: z
    .record(z.string().min(1), z.string())
    .optional()
    .meta({ description: 'Further form fields, such as audience. Values may be {{env.NAME}}.' }),
  timeoutMs: z.int().min(1).max(600_000).default(10_000),
  ...authTiming,
});

/** ADR-0031: a token from a request the profile describes, such as a login. */
const AuthRequest = z.strictObject({
  kind: z.literal('request'),
  request: HttpRequest.omit({ requestId: true }).meta({
    description:
      'An absolute url, HTTPS except to a loopback host. Takes {{env.NAME}} placeholders only.',
  }),
  token: JsonPath.meta({ description: 'Where its answer holds the token.' }),
  expiresIn: JsonPath.optional().meta({
    description: "Where its answer holds the token's lifetime, in seconds.",
  }),
  ...authTiming,
});

const Auth = z.discriminatedUnion('kind', [OAuthClientCredentials, AuthRequest]).meta({
  description:
    'How yokla gets a token for the target, once per run and again before it expires or after a 401; {{auth.token}} puts it where the target expects it (ADR-0031).',
});

const targetShape = {
  name: z.string().min(1),
  auth: Auth.optional(),
  session: Session.default({ mode: 'client', carry: [] }),
  limits: Limits.optional(),
  cacheBypass: CacheBypass.default({ kind: 'none' }),
  observe: z.strictObject({ logs: LogSource.optional() }).optional(),
};

const HttpTarget = z.strictObject({
  ...targetShape,
  adapter: z.literal('http').default('http'),
  request: HttpRequest,
  response: HttpResponse,
});

const WebSocketTarget = z.strictObject({
  ...targetShape,
  adapter: z.literal('websocket'),
  request: WebSocketRequest,
  response: WebSocketResponse,
});

const Target = z.discriminatedUnion('adapter', [HttpTarget, WebSocketTarget]);

const Upstream = z.strictObject({
  id: Id.meta({ description: 'The app reaches this upstream at http://127.0.0.1:<port>/<id>.' }),
  kind: z.enum(['openai-compatible', 'anthropic', 'gemini', 'ai-gateway']).meta({
    description:
      "The provider's API: OpenAI-compatible, Anthropic's Messages, Gemini's native API on AI Studio or Vertex AI (ADR-0032), or the AI SDK's gateway protocol (ADR-0069).",
  }),
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
/** ADR-0029: model calls read from OpenTelemetry spans the app exports to the proxy. */
const Spans = z
  .strictObject({
    quietMs: z.int().min(0).max(600_000).default(6_000),
    maxWaitMs: z.int().min(0).max(600_000).default(20_000),
  })
  .meta({
    description:
      'When the run ends, wait until no span has come for quietMs, or maxWaitMs ran out. The app exports to http://127.0.0.1:<port>/_yokla/otlp/v1/traces; each turn gets its own traceparent.',
  });

const ModelProxy = z.strictObject({
  port: z.int().min(1).max(65_535).default(8787),
  upstreams: z
    .array(Upstream)
    .refine((list) => new Set(list.map((u) => u.id)).size === list.length, {
      message: 'upstream ids must be unique',
    })
    .meta({ description: 'May be empty when spans show the model calls (ADR-0029).' }),
  spans: Spans.optional(),
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
  toolResults: z.record(z.string().min(1), z.record(Id, EvidenceCollection)).optional().meta({
    description:
      "ADR-0026: per tool, evidence collections in its results, as the model saw them in the target's prompts. A collection must be one response.evidence maps. A result is read as JSON: its whole text, or else from its first { to its last }.",
  }),
});

/** A JSON Pointer (RFC 6901) to an entry of the profile (ADR-0047). */
const EntryPointer = z
  .string()
  .regex(/^(?:\/(?:[^~/]|~[01])*)+$/u, 'use a JSON Pointer such as /ecommerce/catalog/path');

const Capability = z.strictObject({
  id: Id,
  description: z.string().min(1).optional(),
  provenance: Provenance.optional(),
});

/** Profile fields that don't depend on packs. */
/** Rules no answer may break, in any case (ADR-0030). */
const EveryAnswer = z
  .strictObject({
    notContains: z.array(z.string().min(1)).min(1).optional().meta({
      description: "Phrases no answer may contain, after the language pack's folding.",
    }),
    notMatches: z.array(Pattern).min(1).optional().meta({
      description: 'Regular expressions no answer may match, as it came.',
    }),
  })
  .refine((rules) => rules.notContains !== undefined || rules.notMatches !== undefined, {
    message: 'everyAnswer needs notContains or notMatches',
  })
  .meta({
    description:
      'Rules every turn with a usable answer is held to, in every case, judged by answer-text (ADR-0030).',
  });

/** A test customer the person set up in a test copy of the target (ADR-0083). */
const Identity = z.strictObject({
  request: z
    .strictObject({
      body: z.json().optional().meta({
        description: 'Merged into the request body of every turn sent as the identity.',
      }),
      headers: z.record(z.string().min(1), z.string()).optional(),
    })
    .optional()
    .meta({
      description:
        'What tells the target who is asking, such as a customer id or a token, {{env.NAME}} allowed.',
    }),
  name: z.string().min(1).optional().meta({
    description: 'How a shopper names the person, such as "Ayşe Yılmaz".',
  }),
  seeded: z.array(z.string().min(3)).min(1).optional().meta({
    description:
      "The identity's own personal data in the test copy, such as an address or a phone number; pii-leak looks for it in answers to anyone else.",
  }),
  orders: z.array(z.string().min(1)).min(1).optional().meta({
    description: "Ids of the identity's orders in the test copy.",
  }),
});

export const profileShape = {
  version: z.literal(1),
  target: Target,
  languages: z.array(LanguageCode).min(1),
  domain: Id,
  capabilities: z.array(Capability).default([]),
  modelProxy: ModelProxy.optional(),
  everyAnswer: EveryAnswer.optional(),
  identities: z.record(Id, Identity).optional().meta({
    description:
      'Test customers, by name; a turn sent `as` one goes with its request, in its own session (ADR-0083).',
  }),
  redteam: z
    .strictObject({
      internals: z.array(z.string().min(3)).min(1).optional().meta({
        description:
          'Strings an answer to a question about the internals must never hold, such as an internal tool name or a debug flag (ADR-0082).',
      }),
    })
    .optional()
    .meta({ description: 'What the red-team checks look for (ADR-0082).' }),
  refusal: z
    .strictObject({
      canonical: z.partialRecord(LanguageCode, z.array(z.string().min(1)).min(1)).optional(),
    })
    .optional(),
  provenance: z
    .record(EntryPointer, Provenance, {
      error: (issue) =>
        issue.code === 'invalid_key'
          ? 'each key is a JSON Pointer to an entry, such as /ecommerce/catalog/path'
          : undefined,
    })
    .optional()
    .meta({
      description:
        'ADR-0047: where entries came from, by JSON Pointer. An entry without one was written by a person. A profile with a proposed or rejected entry does not run.',
    }),
};

const BaseProfile = z.strictObject(profileShape);

/** A validated profile. Domain packs read their own section by key. */
export type Profile = z.output<typeof BaseProfile> & { readonly [section: string]: unknown };
export type ProfileTarget = z.output<typeof Target>;
export type HttpProfileTarget = z.output<typeof HttpTarget>;
export type WebSocketProfileTarget = z.output<typeof WebSocketTarget>;
export type ModelProxyConfig = z.output<typeof ModelProxy>;
export type FieldSpec = z.output<typeof FieldSpec>;
export type ResponseStream = z.output<typeof ResponseStream>;
export type MessageStream = z.output<typeof MessageStream>;
export type TargetAuth = z.output<typeof Auth>;

/**
 * Whether a url keeps credentials off the network in clear text: HTTPS, or
 * HTTP to a loopback host (ADR-0031).
 */
export function isSafeCredentialUrl(url: string): boolean {
  if (/^https:\/\//iu.test(url)) return true;
  const host = /^http:\/\/([^/?#]*)/iu.exec(url)?.[1]?.toLowerCase();
  if (host === undefined) return false;
  const name = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0];
  return name === '127.0.0.1' || name === 'localhost' || name === '[::1]';
}

/**
 * Problems between profile sections: untrusted fields must be evidence fields
 * the profile maps, and a WebSocket target can't correlate by header (ADR-0024).
 */
export function profileProblems(
  profile: Pick<Profile, 'target' | 'modelProxy' | 'provenance'>,
): { path: (string | number)[]; message: string }[] {
  const problems: { path: (string | number)[]; message: string }[] = [];
  // Each pointer of the provenance map names an entry of the profile (ADR-0047).
  for (const pointer of Object.keys(profile.provenance ?? {})) {
    if (pointer === '/provenance' || pointer.startsWith('/provenance/')) {
      problems.push({
        path: ['provenance', pointer],
        message: 'a provenance names an entry of the profile, not of the provenance map',
      });
    } else if (resolvePointer(profile, pointer) === undefined) {
      problems.push({
        path: ['provenance', pointer],
        message: `${pointer} leads to no entry of the profile`,
      });
    }
  }
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
  for (const [tool, collections] of Object.entries(profile.modelProxy?.toolResults ?? {})) {
    for (const name of Object.keys(collections)) {
      if (!(name in evidence)) {
        problems.push({
          path: ['modelProxy', 'toolResults', tool, name],
          message: `the profile maps no evidence collection "${name}" in response.evidence`,
        });
      }
    }
  }
  if (profile.modelProxy !== undefined && profile.modelProxy.upstreams.length === 0) {
    if (profile.modelProxy.spans === undefined) {
      problems.push({
        path: ['modelProxy', 'upstreams'],
        message: 'the model proxy needs an upstream, or spans to read model calls from',
      });
    }
  }
  if (profile.target.adapter === 'websocket' && profile.modelProxy?.spans !== undefined) {
    problems.push({
      path: ['modelProxy', 'spans'],
      message:
        'spans are tied to turns by a traceparent header per turn, which a WebSocket target sends once, when the connection opens',
    });
  }
  const { auth } = profile.target;
  if (auth !== undefined) {
    const url = auth.kind === 'request' ? auth.request.url : auth.tokenUrl;
    if (!isSafeCredentialUrl(url)) {
      problems.push({
        path: ['target', 'auth', ...(auth.kind === 'request' ? ['request', 'url'] : ['tokenUrl'])],
        message:
          'credentials never travel in clear text over a network: use an absolute https url, or http to a loopback host',
      });
    }
  }
  if (profile.target.adapter === 'websocket' && profile.modelProxy?.correlation === 'header') {
    problems.push({
      path: ['modelProxy', 'correlation'],
      message:
        'a WebSocket target sends headers once, when the connection opens, so header correlation is not available: use serial',
    });
  }
  return problems;
}
