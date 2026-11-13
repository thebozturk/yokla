import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildSchemas, type DomainPackSchemas } from './build.ts';
import { reviewStatus } from './common.ts';
import type { HttpProfileTarget, ProfileTarget } from './profile.ts';

const shop: DomainPackSchemas = {
  id: 'shop',
  profile: z.strictObject({ currency: z.string() }),
  expectations: { answerable: z.boolean() },
};

const { profile, caseFile } = buildSchemas({ languages: ['tr', 'en'], domainPacks: [shop] });

const validProfile = {
  version: 1,
  target: {
    name: 't',
    adapter: 'http',
    request: { url: 'http://127.0.0.1:3000/chat', body: { message: '{{message}}' } },
    response: {
      text: '$.answer',
      evidence: { products: { items: '$.items[*]', fields: { price: 'price.amount' } } },
    },
  },
  languages: ['tr'],
  domain: 'shop',
  shop: { currency: 'TRY' },
};

/** The target, which these tests expect to be an HTTP one. */
function http(target: ProfileTarget): HttpProfileTarget {
  if (target.adapter !== 'http') throw new Error('expected an HTTP target');
  return target;
}

function withChange(change: Record<string, unknown>): Record<string, unknown> {
  return { ...validProfile, ...change };
}

function capability(provenance: unknown) {
  return profile.safeParse(withChange({ capabilities: [{ id: 'search', provenance }] }));
}

describe('profile schema', () => {
  it('accepts a minimal profile and applies defaults', () => {
    const parsed = profile.parse(validProfile);
    expect(http(parsed.target).request.method).toBe('POST');
    expect(parsed.target.request.timeoutMs).toBe(30_000);
    expect(parsed.target.session).toEqual({ mode: 'client', carry: [] });
    expect(parsed.target.cacheBypass).toEqual({ kind: 'none' });
    expect(parsed.capabilities).toEqual([]);
  });

  it.each([
    ['an unknown top-level key', withChange({ extra: 1 })],
    ['a language without a pack', withChange({ languages: ['de'] })],
    ['a domain without a pack', withChange({ domain: 'bank' })],
    ['an invalid pack section', withChange({ shop: { currency: 1 } })],
    [
      'an invalid JSONPath',
      withChange({ target: { ...validProfile.target, response: { text: 'data.answer' } } }),
    ],
    ['an unknown adapter', withChange({ target: { ...validProfile.target, adapter: 'grpc' } })],
    [
      'a server session mode (server ids are carried instead)',
      withChange({ target: { ...validProfile.target, session: { mode: 'server' } } }),
    ],
  ])('rejects %s', (_name, input) => {
    expect(profile.safeParse(input).success).toBe(false);
  });

  it('requires evidence and status for machine-made entries only', () => {
    expect(capability({ source: 'doc', evidence: 'README.md', status: 'proposed' }).success).toBe(
      true,
    );
    expect(capability({ source: 'doc', status: 'approved' }).success).toBe(false);
    expect(capability({ source: 'code', evidence: 'src/a.ts:3' }).success).toBe(false);
    expect(capability({ source: 'human' }).success).toBe(true);
  });

  it('treats entries without provenance, and human ones, as approved', () => {
    const parsed = profile.parse(
      withChange({
        capabilities: [
          { id: 'a' },
          { id: 'b', provenance: { source: 'human' } },
          { id: 'c', provenance: { source: 'probe', evidence: 'run 1', status: 'proposed' } },
        ],
      }),
    );
    expect(parsed.capabilities.map(reviewStatus)).toEqual(['approved', 'approved', 'proposed']);
  });
});

const proxied = (prompts?: unknown) =>
  profile.safeParse(
    withChange({
      modelProxy: {
        upstreams: [{ id: 'openai', kind: 'openai-compatible', upstream: 'http://127.0.0.1:9' }],
        ...(prompts === undefined ? {} : { prompts }),
      },
    }),
  );

const messages = (prompts: unknown) =>
  proxied(prompts).error?.issues.map((issue) => issue.message) ?? [];

describe('model proxy prompts (ADR-0015)', () => {
  it('keeps sizes by default, and accepts every store mode', () => {
    expect(proxied().data?.modelProxy?.prompts).toEqual({ store: 'sizes' });
    for (const store of ['sizes', 'hashed', 'full']) expect(proxied({ store }).success).toBe(true);
    expect(proxied({ store: 'redacted', redact: ['\\d{11}'] }).success).toBe(true);
    expect(proxied({ store: 'everything' }).success).toBe(false);
  });

  it('needs a pattern to redact, and refuses one that is broken or matches empty text', () => {
    expect(messages({ store: 'redacted' })).toEqual([
      'store: redacted needs at least one redact pattern',
    ]);
    expect(messages({ store: 'redacted', redact: [] })).toHaveLength(1);
    expect(messages({ store: 'redacted', redact: ['('] })[0]).toMatch(/^not a regular expression/u);
    // Valid without the u flag, but not in Unicode mode, which redaction uses.
    expect(messages({ store: 'sizes', redact: ['\\-'] })[0]).toMatch(/^not a regular expression/u);
    expect(messages({ store: 'sizes', redact: ['\\d*'] })).toEqual(['matches empty text']);
  });
});

const inspecting = (inspect: unknown) =>
  profile.safeParse(
    withChange({
      modelProxy: {
        upstreams: [{ id: 'openai', kind: 'openai-compatible', upstream: 'http://127.0.0.1:9' }],
        inspect,
      },
    }),
  );

const issues = (inspect: unknown) =>
  inspecting(inspect).error?.issues.map((issue) => [issue.path.join('.'), issue.message]);

describe('model proxy inspection (ADR-0015)', () => {
  it('accepts a canary and untrusted fields the profile maps as evidence', () => {
    expect(inspecting({ canary: 'YK-CANARY-1', untrusted: { products: ['price'] } }).success).toBe(
      true,
    );
    expect(inspecting({ canary: 'short' }).success).toBe(false);
  });

  it('refuses untrusted fields that are not mapped as evidence, saying where', () => {
    expect(issues({ untrusted: { stores: ['name'] } })).toEqual([
      ['modelProxy.inspect.untrusted.stores', 'the profile maps no evidence collection "stores"'],
    ]);
    expect(issues({ untrusted: { products: ['price', 'name'] } })).toEqual([
      [
        'modelProxy.inspect.untrusted.products.1',
        'evidence collection "products" maps no field "name"',
      ],
    ]);
  });
});

const socket = {
  name: 'chat',
  adapter: 'websocket',
  request: {
    url: 'wss://chat.example.com/ws?session={{session}}',
    headers: { authorization: 'Bearer {{env.TOKEN}}' },
    body: { type: 'user_message', text: '{{message}}' },
  },
  response: {
    stream: { event: '$.type', text: { event: 'delta', from: '$.text' }, done: 'end' },
    text: '$.text',
  },
};

const viaSocket = (change: Record<string, unknown> = {}, rest: Record<string, unknown> = {}) =>
  profile.safeParse(withChange({ target: { ...socket, ...change }, ...rest }));

const socketIssues = (change: Record<string, unknown>, rest: Record<string, unknown> = {}) =>
  viaSocket(change, rest).error?.issues.map((issue) => [issue.path.join('.'), issue.message]);

/** A model proxy section with this correlation. */
const proxy = (correlation: string) => ({
  modelProxy: {
    upstreams: [{ id: 'openai', kind: 'openai-compatible', upstream: 'http://127.0.0.1:9' }],
    correlation,
  },
});

describe('WebSocket targets (ADR-0024)', () => {
  it('accepts a WebSocket target, with defaults, and keeps http the default adapter', () => {
    const parsed = viaSocket();
    expect(parsed.error).toBeUndefined();
    const target = parsed.data?.target;
    expect(target?.adapter).toBe('websocket');
    expect(target?.request.timeoutMs).toBe(30_000);
    expect(target?.session).toEqual({ mode: 'client', carry: [] });
    const { adapter: _adapter, ...withoutAdapter } = validProfile.target;
    expect(profile.parse(withChange({ target: withoutAdapter })).target.adapter).toBe('http');
  });

  it('needs a ws or wss url, a message and a done event', () => {
    expect(
      socketIssues({ request: { ...socket.request, url: 'http://chat.example.com/ws' } }),
    ).toEqual([['target.request.url', 'use a ws:// or wss:// url']]);
    const { body: _body, ...noBody } = socket.request;
    expect(socketIssues({ request: noBody })?.[0]?.[0]).toBe('target.request.body');
    const { done: _done, ...noDone } = socket.response.stream;
    expect(socketIssues({ response: { ...socket.response, stream: noDone } })?.[0]?.[0]).toBe(
      'target.response.stream.done',
    );
    const { stream: _stream, ...noStream } = socket.response;
    expect(socketIssues({ response: noStream })?.[0]?.[0]).toBe('target.response.stream');
  });

  it('has no stream format, no HTTP method and no request id header', () => {
    const format = { ...socket.response.stream, format: 'sse' };
    expect(socketIssues({ response: { ...socket.response, stream: format } })?.[0]?.[1]).toMatch(
      /format/u,
    );
    expect(socketIssues({ request: { ...socket.request, method: 'POST' } })?.[0]?.[1]).toMatch(
      /method/u,
    );
    expect(
      socketIssues({
        request: { ...socket.request, requestId: { header: 'x-request-id' } },
      })?.[0]?.[1],
    ).toMatch(/requestId/u);
  });

  it('refuses header correlation, which needs a header on every turn', () => {
    expect(viaSocket({}, proxy('serial')).success).toBe(true);
    expect(socketIssues({}, proxy('header'))).toEqual([
      [
        'modelProxy.correlation',
        'a WebSocket target sends headers once, when the connection opens, so header correlation is not available: use serial',
      ],
    ]);
    expect(profile.safeParse(withChange(proxy('header'))).success).toBe(true);
  });
});

describe('case schema', () => {
  const validCase = {
    id: 'tents-tr',
    suite: 'factual',
    language: 'tr',
    turns: [{ user: 'Çadır?' }],
  };

  it('accepts a case and pack expectations', () => {
    const parsed = caseFile.parse({
      version: 1,
      cases: [{ ...validCase, turns: [{ user: 'Çadır?', expect: { answerable: true } }] }],
    });
    expect(parsed.cases[0]?.tags).toEqual([]);
  });

  it.each([
    [
      'an expectation no pack owns',
      { ...validCase, turns: [{ user: 'x', expect: { mystery: 1 } }] },
    ],
    ['an unknown suite', { ...validCase, suite: 'vibes' }],
    ['a language without a pack', { ...validCase, language: 'de' }],
    ['an invalid id', { ...validCase, id: 'Tents TR' }],
    ['no turns', { ...validCase, turns: [] }],
  ])('rejects %s', (_name, input) => {
    expect(caseFile.safeParse({ version: 1, cases: [input] }).success).toBe(false);
  });
});

describe('buildSchemas', () => {
  it('rejects a pack loaded twice', () => {
    expect(() => buildSchemas({ languages: ['tr'], domainPacks: [shop, shop] })).toThrow(
      /loaded twice/u,
    );
  });

  it('rejects two packs that own the same expectation', () => {
    const other: DomainPackSchemas = { id: 'other', expectations: { answerable: z.boolean() } };
    expect(() => buildSchemas({ languages: ['tr'], domainPacks: [shop, other] })).toThrow(
      /two domain packs/u,
    );
  });

  it('rejects a pack id that clashes with a profile field', () => {
    expect(() => buildSchemas({ languages: ['tr'], domainPacks: [{ id: 'target' }] })).toThrow(
      /clashes/u,
    );
  });

  it('requires a domain pack', () => {
    expect(() => buildSchemas({ languages: ['tr'], domainPacks: [] })).toThrow(/at least one/u);
  });
});

function withTarget(change: Record<string, unknown>): Record<string, unknown> {
  return withChange({ target: { ...validProfile.target, ...change } });
}

const response = (fields: unknown) => ({
  text: '$.message',
  evidence: { products: { items: '$.products[*]', fields } },
});

describe('target configuration', () => {
  it('reads evidence fields from one path or from fallbacks with a conversion', () => {
    const parsed = profile.parse(
      withTarget({
        response: response({
          id: 'externalId',
          price: { from: ['price.salePrice', 'price.listPrice'], as: 'number' },
        }),
      }),
    );
    expect(parsed.target.response.evidence?.['products']?.fields['price']).toEqual({
      from: ['price.salePrice', 'price.listPrice'],
      as: 'number',
    });
  });

  it.each([
    ['an empty fallback list', response({ price: { from: [] } })],
    ['an unknown conversion', response({ price: { from: 'price', as: 'decimal' } })],
  ])('rejects %s', (_name, value) => {
    expect(profile.safeParse(withTarget({ response: value })).success).toBe(false);
  });

  it('carries response values into later turns and sends a request id', () => {
    const parsed = profile.parse(
      withTarget({
        request: { ...validProfile.target.request, requestId: { header: 'x-request-id' } },
        response: { text: '$.message', id: '$.requestId' },
        session: { carry: [{ name: 'conversationId', from: '$.metadata.conversationId' }] },
      }),
    );
    expect(parsed.target.session).toEqual({
      mode: 'client',
      carry: [{ name: 'conversationId', from: '$.metadata.conversationId' }],
    });
    expect(http(parsed.target).request.requestId).toEqual({ header: 'x-request-id' });
  });

  it('configures rate-limit headers and units, with defaults', () => {
    const defaults = profile.parse(withTarget({ limits: { burstPerSecond: 3 } }));
    expect(defaults.target.limits?.retryAfter).toEqual({
      headers: ['retry-after'],
      unit: 'seconds',
      maxWaitMs: 60_000,
    });
    const tiered = profile.parse(
      withTarget({
        limits: {
          perHour: 2000,
          retryAfter: { headers: ['retry-after', 'retry-after-*'], unit: 'milliseconds' },
          clientIdentity: { header: 'x-forwarded-for', pool: 'test-net' },
        },
      }),
    );
    expect(tiered.target.limits?.clientIdentity).toEqual({
      header: 'x-forwarded-for',
      pool: 'test-net',
      per: 'case',
    });
  });

  it('rejects client addresses outside the TEST-NET pool', () => {
    const result = profile.safeParse(
      withTarget({ limits: { clientIdentity: { header: 'x-forwarded-for', pool: 'random' } } }),
    );
    expect(result.success).toBe(false);
  });

  it('accepts a cache-bypass command given as an argument list only', () => {
    const parsed = profile.parse(
      withTarget({ cacheBypass: { kind: 'command', run: ['./clear-cache.sh', '--all'] } }),
    );
    expect(parsed.target.cacheBypass).toEqual({
      kind: 'command',
      run: ['./clear-cache.sh', '--all'],
      timeoutMs: 30_000,
    });
    expect(
      profile.safeParse(withTarget({ cacheBypass: { kind: 'command', run: [] } })).success,
    ).toBe(false);
    expect(
      profile.safeParse(withTarget({ cacheBypass: { kind: 'command', run: 'rm -rf x' } })).success,
    ).toBe(false);
  });

  it('accepts a log source with correlation and field reductions', () => {
    const parsed = profile.parse(
      withTarget({
        observe: {
          logs: {
            source: {
              kind: 'command',
              run: ['docker', 'compose', 'logs', '--no-color', 'backend'],
            },
            match: [{ path: '$.context', equals: 'Telemetry' }],
            correlate: { by: 'request-id', field: '$.requestId' },
            fields: {
              costUsd: { from: '$.modelCallUsage[*].costUsd', reduce: 'sum' },
              cacheHit: '$.cacheHit',
            },
          },
        },
      }),
    );
    expect(parsed.target.observe?.logs?.fields['costUsd']).toEqual({
      from: '$.modelCallUsage[*].costUsd',
      reduce: 'sum',
    });
  });

  it('rejects an unknown correlation mode', () => {
    const logs = {
      source: { kind: 'file', path: 'app.log' },
      correlate: { by: 'timestamp' },
      fields: {},
    };
    expect(profile.safeParse(withTarget({ observe: { logs } })).success).toBe(false);
  });
});

function turn(extra: Record<string, unknown>) {
  return {
    version: 1,
    cases: [{ id: 'c', suite: 'quality', language: 'tr', turns: [{ user: 'x', ...extra }] }],
  };
}

describe('core expectations and turn requests', () => {
  it('accepts route, answer and evidence expectations next to pack ones', () => {
    const expectation = {
      route: ['retrieval', 'ai'],
      answer: { contains: ['bulamadım'], notContains: ['stokta'] },
      evidence: { products: { min: 1, max: 5, includes: ['P-1'] } },
      answerable: true,
    };
    expect(caseFile.safeParse(turn({ expect: expectation })).success).toBe(true);
  });

  it('rejects a negative evidence count', () => {
    expect(
      caseFile.safeParse(turn({ expect: { evidence: { products: { min: -1 } } } })).success,
    ).toBe(false);
  });

  it('accepts extra body fields and headers for one turn', () => {
    const request = { body: { context: { page: 'product' } }, headers: { 'x-device-key': 'd' } };
    expect(caseFile.safeParse(turn({ request })).success).toBe(true);
  });

  it('rejects a pack expectation that clashes with a core expectation', () => {
    const clash: DomainPackSchemas = { id: 'clash', expectations: { route: z.string() } };
    expect(() => buildSchemas({ languages: ['tr'], domainPacks: [clash] })).toThrow(
      /core expectation/u,
    );
  });
});
