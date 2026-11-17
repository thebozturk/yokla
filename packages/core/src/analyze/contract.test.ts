import { describe, expect, it } from 'vitest';
import { schemaProblems } from '../jsonschema/jsonschema.ts';
import { contractAt, contractKind, readJsonSchema, readOpenApi } from './contract.ts';

const answer = {
  type: 'object',
  required: ['answer'],
  properties: {
    answer: { type: 'string', example: 'Hi', 'x-note': 'n' },
    price: { $ref: '#/components/schemas/Money' },
  },
};

const openApi = (change: Record<string, unknown> = {}) => ({
  openapi: '3.0.3',
  servers: [{ url: 'https://shop.test/api/' }],
  paths: {
    '/v1/chat': {
      post: {
        responses: {
          '201': {
            content: {
              'application/vnd.shop+json': {
                schema: {
                  type: 'object',
                  properties: { data: { $ref: '#/components/schemas/Answer' } },
                },
              },
            },
          },
          '200': { $ref: '#/components/responses/Ok' },
        },
      },
    },
    '/v1/items/{id}': {
      get: {
        responses: { '2XX': { content: { 'application/json': { schema: { type: 'array' } } } } },
      },
    },
  },
  components: {
    responses: {
      Ok: {
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: { data: { $ref: '#/components/schemas/Answer' } },
            },
          },
        },
      },
    },
    schemas: {
      Answer: answer,
      Money: { type: 'number', nullable: true, minimum: 0 },
      Unused: { type: 'string' },
    },
  },
  ...change,
});

describe('contract files (ADR-0057)', () => {
  it('tells an OpenAPI 3 document and a JSON Schema from anything else', () => {
    expect(contractKind({ openapi: '3.1.0' })).toBe('openapi');
    expect(contractKind({ $schema: 'https://json-schema.org/draft/2020-12/schema' })).toBe(
      'json-schema',
    );
    expect(contractKind({ swagger: '2.0' })).toBeUndefined();
    expect(contractKind({ openapi: '2.0', $schema: 'x' })).toBeUndefined();
    expect(contractKind(['openapi'])).toBeUndefined();
  });

  it("reads the request's operation, its lowest 2xx JSON response, after the server's path", () => {
    const read = readOpenApi(openApi(), { path: '/api/v1/chat', method: 'post' });
    expect(read).toEqual({
      ok: true,
      read: 'POST /v1/chat 200 application/json',
      schema: {
        type: 'object',
        properties: { data: { $ref: '#/$defs/Answer' } },
        $defs: {
          Answer: {
            type: 'object',
            required: ['answer'],
            properties: { answer: { type: 'string' }, price: { $ref: '#/$defs/Money' } },
          },
          // nullable adds null to the type.
          Money: { type: ['number', 'null'], minimum: 0 },
        },
      },
      dropped: ['example (1)', 'x-note (1)'],
    });
    expect(schemaProblems(read.ok ? read.schema : false)).toEqual([]);
  });

  it('translates inside every keyword that holds schemas, and follows a component that refers to itself', () => {
    const document = openApi({
      paths: {
        '/v1/chat': {
          post: {
            responses: {
              '201': {
                content: {
                  'application/problem+json': {
                    schema: {
                      type: 'object',
                      properties: {
                        list: { type: 'array', items: { $ref: '#/components/schemas/Node' } },
                        either: { anyOf: [{ type: 'string', example: 'a' }, { type: 'null' }] },
                        code: { type: ['string', 'integer'], nullable: true },
                        kept: { type: ['string', 'null'], nullable: true },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      components: {
        schemas: {
          Node: { type: 'object', properties: { next: { $ref: '#/components/schemas/Node' } } },
        },
      },
    });
    expect(readOpenApi(document, { path: '/api/v1/chat', method: 'POST' })).toEqual({
      ok: true,
      read: 'POST /v1/chat 201 application/problem+json',
      schema: {
        type: 'object',
        properties: {
          list: { type: 'array', items: { $ref: '#/$defs/Node' } },
          either: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          code: { type: ['string', 'integer', 'null'] },
          kept: { type: ['string', 'null'] },
        },
        $defs: { Node: { type: 'object', properties: { next: { $ref: '#/$defs/Node' } } } },
      },
      dropped: ['example (1)'],
    });
  });

  it('takes a literal path before a template that would match it too', () => {
    const literal = {
      get: {
        responses: { '200': { content: { 'application/json': { schema: { type: 'object' } } } } },
      },
    };
    const document = openApi({
      paths: { '/v1/items/{id}': {}, '/v1/items/special': literal },
    });
    expect(readOpenApi(document, { path: '/api/v1/items/special', method: 'GET' })).toMatchObject({
      read: 'GET /v1/items/special 200 application/json',
    });
    // By name alone, "{" comes before a letter outside ASCII.
    const turkish = openApi({ paths: { '/v1/items/{id}': {}, '/v1/items/çadır': literal } });
    expect(readOpenApi(turkish, { path: '/api/v1/items/çadır', method: 'GET' })).toMatchObject({
      read: 'GET /v1/items/çadır 200 application/json',
    });
  });

  it('matches a {parameter} to one segment, and takes 2XX where no code is given', () => {
    const read = readOpenApi(openApi(), { path: '/api/v1/items/42', method: 'GET' });
    expect(read).toMatchObject({ ok: true, read: 'GET /v1/items/{id} 2XX application/json' });
    expect(readOpenApi(openApi(), { path: '/api/v1/items/4/2', method: 'GET' })).toEqual({
      ok: false,
      outcome: 'no-operation',
      problem: 'no operation for GET /api/v1/items/4/2',
    });
  });

  it('says why an operation gives nothing to check', () => {
    const plain = openApi({
      paths: { '/v1/chat': { post: { responses: { '204': { description: 'nothing' } } } } },
    });
    expect(readOpenApi(plain, { path: '/api/v1/chat', method: 'POST' })).toEqual({
      ok: false,
      outcome: 'unusable',
      problem: 'POST /v1/chat has no 2xx JSON response schema',
    });
    expect(readOpenApi(openApi(), { path: '/v1/chat', method: 'DELETE' })).toMatchObject({
      outcome: 'no-operation',
    });
  });

  it('reads a JSON Schema document whole', () => {
    const document = { $schema: 'x', type: 'object' };
    expect(readJsonSchema(document)).toEqual({
      ok: true,
      schema: document,
      read: 'the whole schema',
      dropped: [],
    });
  });

  it('applies the schema at the deepest object the text and every collection share', () => {
    const read = readOpenApi(openApi(), { path: '/api/v1/chat', method: 'POST' });
    if (!read.ok) throw new Error('no contract');
    const placed = contractAt(read.schema, '$.data.answer', ['$.data.products[*]']);
    expect(placed).toEqual({
      at: '$.data',
      schema: {
        type: 'object',
        required: ['answer'],
        properties: { answer: { type: 'string' }, price: { $ref: '#/$defs/Money' } },
        $defs: { Money: { type: ['number', 'null'], minimum: 0 } },
      },
    });
    expect(schemaProblems(placed.schema)).toEqual([]);
  });

  it('applies it to the whole answer where the paths share nothing, or the schema has no object there', () => {
    const schema = {
      type: 'object',
      properties: { data: { type: 'object' }, list: { type: 'string' } },
    };
    expect(contractAt(schema, '$.text', ['$.items[*]']).at).toBe('$');
    expect(contractAt(schema, '$.list.text', []).at).toBe('$');
    expect(contractAt(schema, '$.other.text', []).at).toBe('$');
    expect(contractAt(schema, "$['data']['text']", []).at).toBe('$.data');
    expect(contractAt({ properties: { 'a b': { properties: {} } } }, "$['a b'].text", [])).toEqual({
      at: "$['a b']",
      schema: { properties: {} },
    });
  });
});
