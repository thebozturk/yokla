import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildSchemas, type DomainPackSchemas } from './build.ts';
import { reviewStatus } from './common.ts';

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

function withChange(change: Record<string, unknown>): Record<string, unknown> {
  return { ...validProfile, ...change };
}

function capability(provenance: unknown) {
  return profile.safeParse(withChange({ capabilities: [{ id: 'search', provenance }] }));
}

describe('profile schema', () => {
  it('accepts a minimal profile and applies defaults', () => {
    const parsed = profile.parse(validProfile);
    expect(parsed.target.request.method).toBe('POST');
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
    expect(parsed.target.request.requestId).toEqual({ header: 'x-request-id' });
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
