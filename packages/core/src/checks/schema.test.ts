import { describe, expect, it } from 'vitest';
import type { JsonValue } from '../extract/response.ts';
import type { SchemaRule } from '../schema/common.ts';
import type { Profile } from '../schema/profile.ts';
import { checkContext, mutate, turnView } from '../testing.ts';
import { runChecks } from './run.ts';
import { jsonSchemaCheck, MAX_VIOLATIONS } from './schema.ts';
import type { CheckContext, CheckOutcome, TurnView } from './types.ts';

const REPLY = {
  type: 'object',
  required: ['answer', 'metadata'],
  properties: {
    answer: { type: 'string' },
    metadata: {
      type: 'object',
      required: ['route', 'language'],
      properties: { route: { type: 'string' }, language: { enum: ['tr', 'en'] } },
    },
  },
};

const BODY = {
  data: {
    answer: 'Merhaba',
    metadata: { route: 'ai', language: 'tr' },
    products: [
      { id: 'T1', price: 10 },
      { id: 'T2', price: 20 },
    ],
  },
};

function answered(document: JsonValue | undefined, expectations: Record<string, unknown> = {}) {
  return turnView({
    expect: expectations,
    response: { text: 'Merhaba', ...(document === undefined ? {} : { document }) },
  });
}

/** A profile with this rule as the contract of every answer. */
function withContract(rule: SchemaRule): Profile {
  const { profile } = checkContext(turnView());
  const { target } = profile;
  if (target.adapter !== 'http') throw new Error('expected an HTTP target');
  return { ...profile, target: { ...target, response: { ...target.response, schema: rule } } };
}

/** A profile whose every answer must match `schema` at `at`. */
function contracted(at: string, schema: Record<string, JsonValue> | boolean): Profile {
  return withContract({ at, schema });
}

function run(turn: TurnView, change: Partial<CheckContext> = {}): CheckOutcome {
  return jsonSchemaCheck.run(checkContext(turn, change));
}

function messages(outcome: CheckOutcome): string[] {
  return outcome.applicable
    ? outcome.findings.map((f) => `${f.verdict}: ${f.message}`)
    : [`n/a: ${outcome.reason}`];
}

describe('json-schema (ADR-0030)', () => {
  it('does not apply without a schema, or to a response that is not JSON', () => {
    expect(messages(run(answered(BODY)))).toEqual(['n/a: no schema for the response']);
    expect(messages(run(answered(undefined), { profile: contracted('$.data', REPLY) }))).toEqual([
      'n/a: the response is not JSON',
    ]);
  });

  it("holds every answer to the profile's contract, and a turn to its own schemas", () => {
    const outcome = run(
      answered(BODY, {
        schema: [
          { at: '$.data.products[*]', schema: { required: ['id', 'price'] } },
          { at: '$.data.products[*].price', schema: { type: 'number', maximum: 15 } },
        ],
      }),
      { profile: contracted('$.data', REPLY) },
    );
    expect(messages(outcome)).toEqual([
      'pass: matches the schema at $.data (target.response.schema)',
      'pass: matches the schema at $.data.products[*]',
      'fail: breaks the schema at $.data.products[*].price: $.data.products[1].price: maximum, more than 15',
    ]);
    expect(outcome.applicable && outcome.findings.map((f) => [f.dimension, f.severity])).toEqual([
      ['contract', 'high'],
      ['contract', 'high'],
      ['contract', 'high'],
    ]);
    expect(outcome.applicable && outcome.findings[2]?.evidence).toEqual({
      at: '$.data.products[*].price',
      from: 'turn',
      violations: [
        { path: '$.data.products[1].price', keyword: 'maximum', message: 'more than 15' },
      ],
      total: 1,
    });
  });

  it('fails when the path selects nothing: the contract says the part is there', () => {
    const outcome = run(answered({ data: {} }), { profile: contracted('$.data.metadata', true) });
    expect(messages(outcome)).toEqual([
      'fail: nothing at $.data.metadata (target.response.schema)',
    ]);
    expect(outcome.applicable && outcome.findings[0]?.evidence).toEqual({
      at: '$.data.metadata',
      from: 'profile',
    });
  });

  it('validates the whole document at $ by default', () => {
    const outcome = run(answered(BODY, { schema: [{ at: '$', schema: { required: ['error'] } }] }));
    expect(messages(outcome)).toEqual([
      'fail: breaks the schema at $: $: required, "error" is missing',
    ]);
    expect(messages(run(answered(BODY, { schema: [{ schema: { required: ['data'] } }] })))).toEqual(
      ['pass: matches the schema at $'],
    );
  });

  it(`counts every broken rule, and keeps the first ${String(MAX_VIOLATIONS)}`, () => {
    const many = Array.from({ length: 12 }, (_, index) => ({ id: index }));
    const outcome = run(
      answered({ items: many }, { schema: [{ at: '$.items[*].id', schema: { type: 'string' } }] }),
    );
    expect(messages(outcome)).toEqual([
      'fail: breaks the schema at $.items[*].id: $.items[0].id: type, expected string, got integer, and 11 more',
    ]);
    const evidence = outcome.applicable ? outcome.findings[0]?.evidence : undefined;
    expect(Reflect.get(Object(evidence), 'total')).toBe(12);
    expect(Reflect.get(Object(evidence), 'violations')).toHaveLength(MAX_VIOLATIONS);
  });

  it('catches a field the contract requires gone from the response', () => {
    const base = answered(BODY);
    const profile = contracted('$.data', REPLY);
    const mutated = mutate(base, (view) => ({
      ...view,
      response: {
        ...view.response,
        document: { data: { answer: 'Merhaba', metadata: { route: 'ai' } } },
      },
    }));
    expect(messages(run(base, { profile }))).toEqual([
      'pass: matches the schema at $.data (target.response.schema)',
    ]);
    expect(messages(run(mutated, { profile }))).toEqual([
      'fail: breaks the schema at $.data (target.response.schema): $.data.metadata: required, "language" is missing',
    ]);
  });

  it('reports a schemaFile left unread as an error, never a pass', () => {
    const unread = withContract({ at: '$', schemaFile: 'reply.json' });
    const [result] = runChecks(
      [jsonSchemaCheck],
      checkContext(answered(BODY), { profile: unread }),
    );
    expect(result?.findings).toEqual([
      expect.objectContaining({
        verdict: 'error',
        message: 'check "json-schema" failed: the schema in reply.json was not read',
      }),
    ]);
  });
});
