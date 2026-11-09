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
    expect(parsed.target.session).toEqual({ mode: 'client' });
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
      'server sessions without an id path',
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
