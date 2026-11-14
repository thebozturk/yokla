import { describe, expect, it } from 'vitest';
import { schemaProblems, validateJson, type JsonSchema } from './jsonschema.ts';

/** The violations as `path keyword: message`, for short expectations. */
function broken(schema: JsonSchema, value: unknown): string[] {
  expect(schemaProblems(schema)).toEqual([]);
  return validateJson(schema, value).map((v) => `${v.path} ${v.keyword}: ${v.message}`);
}

describe('schemaProblems (ADR-0030)', () => {
  it('accepts every keyword of the subset', () => {
    const schema = {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $id: 'https://example.com/reply',
      $comment: 'c',
      title: 't',
      description: 'd',
      examples: [{}],
      default: {},
      deprecated: false,
      readOnly: false,
      writeOnly: false,
      type: 'object',
      required: ['data'],
      additionalProperties: false,
      minProperties: 1,
      maxProperties: 3,
      properties: {
        data: { $ref: '#/$defs/data' },
        tags: {
          type: 'array',
          prefixItems: [{ const: 'first' }],
          items: { type: 'string', minLength: 1, maxLength: 20, pattern: '^\\p{L}+$' },
          minItems: 1,
          maxItems: 5,
          uniqueItems: true,
        },
        at: { type: 'string', format: 'date-time' },
        kind: { enum: ['a', 'b'] },
        either: { anyOf: [{ type: 'null' }, { type: 'string' }] },
        one: { oneOf: [{ type: 'integer' }, { type: 'boolean' }] },
        all: { allOf: [{ minimum: 0 }, { maximum: 10 }] },
        none: { not: { type: 'null' } },
        price: {
          type: ['number', 'null'],
          exclusiveMinimum: 0,
          exclusiveMaximum: 100_000,
          multipleOf: 0.01,
        },
      },
      $defs: { data: true, never: false },
    };
    expect(schemaProblems(schema)).toEqual([]);
    expect(schemaProblems(true)).toEqual([]);
    expect(schemaProblems(false)).toEqual([]);
  });

  it('refuses a keyword it does not check, saying where it is', () => {
    expect(
      schemaProblems({
        properties: { 'a/b': { patternProperties: {} } },
        definitions: {},
      }),
    ).toEqual([
      '#/properties/a~1b/patternProperties: the keyword "patternProperties" isn\'t checked',
      '#/definitions: the keyword "definitions" isn\'t checked',
    ]);
  });

  it.each([
    [{ minLength: -1 }, '#/minLength: a whole number, 0 or more'],
    [{ maxItems: 1.5 }, '#/maxItems: a whole number, 0 or more'],
    [{ minimum: '3' }, '#/minimum: a number'],
    [{ type: 'float' }, '#/type: a type, or a list of types, from'],
    [{ type: [] }, '#/type: a type, or a list of types, from'],
    [{ type: ['string', 'string'] }, '#/type: a type, or a list of types, from'],
    [{ enum: [] }, '#/enum: a list of values'],
    [{ anyOf: [] }, '#/anyOf: a list of schemas'],
    [{ prefixItems: {} }, '#/prefixItems: a list of schemas'],
    [{ properties: [] }, '#/properties: an object of schemas'],
    [{ properties: { a: 3 } }, '#/properties/a: a schema is an object or a boolean'],
    [{ items: 'string' }, '#/items: a schema is an object or a boolean'],
    [{ required: ['a', 'a'] }, '#/required: a list of property names, each once'],
    [{ required: [1] }, '#/required: a list of property names, each once'],
    [{ uniqueItems: 'yes' }, '#/uniqueItems: true or false'],
    [{ multipleOf: 0 }, '#/multipleOf: a number above 0'],
    [{ pattern: '(' }, '#/pattern: a valid regular expression'],
    [{ pattern: '\\q' }, '#/pattern: a valid regular expression'],
    [{ format: 'ipv4' }, '#/format: the format "ipv4" isn\'t checked; yokla checks'],
    [
      { $ref: 'https://example.com/s.json' },
      'points outside the schema, which yokla never fetches',
    ],
    [{ $ref: '#/$defs/missing' }, '#/$ref: "#/$defs/missing" points to no schema in it'],
    [{ properties: {}, $ref: '#/properties' }, '#/$ref: "#/properties" points to no schema in it'],
    ['object', '#: a schema is an object or a boolean'],
  ])('refuses %j', (schema, problem) => {
    const problems = schemaProblems(schema);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(problem);
  });

  it('follows a reference by its escaped and percent-encoded pointer', () => {
    const schema = {
      $defs: { 'a/b': { type: 'string' }, 'c d': { type: 'number' }, 'e~f': { type: 'null' } },
      anyOf: [{ $ref: '#/$defs/a~1b' }, { $ref: '#/$defs/c%20d' }, { $ref: '#/$defs/e~0f' }],
    };
    expect(schemaProblems(schema)).toEqual([]);
    expect(validateJson(schema, 'x')).toEqual([]);
    expect(validateJson(schema, 1)).toEqual([]);
    expect(validateJson(schema, null)).toEqual([]);
    expect(validateJson(schema, true)).toEqual([
      { path: '$', keyword: 'anyOf', message: 'matches none of the 3 schemas' },
    ]);
  });
});

describe('validateJson (ADR-0030)', () => {
  it('names the path and the rule of each violation, never the value', () => {
    const schema = {
      type: 'object',
      required: ['data'],
      properties: {
        data: {
          type: 'object',
          required: ['answer', 'products'],
          properties: {
            answer: { type: 'string', minLength: 1 },
            products: {
              type: 'array',
              items: {
                type: 'object',
                required: ['id', 'price'],
                properties: { id: { type: 'string' }, price: { type: 'number', minimum: 0 } },
              },
            },
          },
        },
      },
    };
    expect(
      broken(schema, {
        data: { answer: '', products: [{ id: 'T1', price: 10 }, { id: 'T2', price: '9,90' }, {}] },
      }),
    ).toEqual([
      '$.data.answer minLength: 0 characters, at least 1',
      '$.data.products[1].price type: expected number, got string',
      '$.data.products[2] required: "id" is missing',
      '$.data.products[2] required: "price" is missing',
    ]);
    expect(broken(schema, { data: { answer: 'Merhaba', products: [] } })).toEqual([]);
    expect(broken(schema, [])).toEqual(['$ type: expected object, got array']);
  });

  it('writes a member that is not a name in brackets', () => {
    const schema = { additionalProperties: false, properties: { ok: true } };
    expect(broken(schema, { ok: 1, 'two words': 2, x: 3 })).toEqual([
      '$["two words"] additionalProperties: not allowed',
      '$.x additionalProperties: not allowed',
    ]);
  });

  it('tells types apart, an integer being a number too', () => {
    const cases: [string, unknown, boolean][] = [
      ['null', null, true],
      ['null', 0, false],
      ['boolean', false, true],
      ['boolean', 'false', false],
      ['object', {}, true],
      ['object', [], false],
      ['object', null, false],
      ['array', [], true],
      ['array', {}, false],
      ['number', 1.5, true],
      ['number', 2, true],
      ['number', '2', false],
      ['integer', 2, true],
      ['integer', 2.5, false],
      ['string', '', true],
      ['string', 1, false],
    ];
    for (const [type, value, valid] of cases) {
      expect(validateJson({ type }, value).length === 0, `${type} ${JSON.stringify(value)}`).toBe(
        valid,
      );
    }
    expect(broken({ type: ['string', 'null'] }, 3)).toEqual([
      '$ type: expected string or null, got integer',
    ]);
  });

  it('checks enum and const by JSON equality, whatever the order of keys', () => {
    expect(broken({ enum: [{ a: 1, b: [2] }, 'x'] }, { b: [2], a: 1 })).toEqual([]);
    expect(broken({ enum: [{ a: 1 }, 'x'] }, { a: 1, b: 2 })).toEqual([
      '$ enum: not one of the 2 allowed values',
    ]);
    expect(broken({ enum: ['x'] }, 'y')).toEqual(['$ enum: not one of the 1 allowed value']);
    expect(broken({ const: [1, { a: null }] }, [1, { a: null }])).toEqual([]);
    expect(broken({ const: [1, 2] }, [2, 1])).toEqual(['$ const: not the expected value']);
    expect(broken({ const: null }, 0)).toEqual(['$ const: not the expected value']);
  });

  it('combines schemas with allOf, anyOf, oneOf and not', () => {
    const range = { allOf: [{ minimum: 1 }, { maximum: 5 }] };
    expect(broken(range, 3)).toEqual([]);
    expect(broken(range, 9)).toEqual(['$ maximum: more than 5']);
    const either = { anyOf: [{ type: 'string' }, { type: 'null' }] };
    expect(broken(either, null)).toEqual([]);
    expect(broken(either, 1)).toEqual(['$ anyOf: matches none of the 2 schemas']);
    const one = { oneOf: [{ type: 'number' }, { type: 'integer' }, { type: 'string' }] };
    expect(broken(one, 1.5)).toEqual([]);
    expect(broken(one, 2)).toEqual(['$ oneOf: matches 2 of the 3 schemas, not exactly one']);
    expect(broken(one, null)).toEqual(['$ oneOf: matches 0 of the 3 schemas, not exactly one']);
    expect(broken({ not: { type: 'null' } }, null)).toEqual([
      '$ not: matches the schema it must not',
    ]);
    expect(broken({ not: { type: 'null' } }, 0)).toEqual([]);
  });

  it('checks objects: properties, required, additional ones and their count', () => {
    const schema = {
      properties: { a: { type: 'string' } },
      additionalProperties: { type: 'integer' },
      minProperties: 2,
      maxProperties: 3,
    };
    expect(broken(schema, { a: 'x', b: 1 })).toEqual([]);
    expect(broken(schema, { a: 1, b: 'y' })).toEqual([
      '$.a type: expected string, got integer',
      '$.b type: expected integer, got string',
    ]);
    expect(broken(schema, { a: 'x' })).toEqual(['$ minProperties: 1 property, at least 2']);
    expect(broken(schema, { a: 'x', b: 1, c: 2, d: 3 })).toEqual([
      '$ maxProperties: 4 properties, at most 3',
    ]);
    // Keywords of one kind ignore values of another.
    expect(broken(schema, 'text')).toEqual([]);
  });

  it('checks arrays: prefixItems, items, their count and uniqueness', () => {
    const schema = {
      prefixItems: [{ const: 'head' }],
      items: { type: 'integer' },
      minItems: 2,
      maxItems: 4,
      uniqueItems: true,
    };
    expect(broken(schema, ['head', 1, 2])).toEqual([]);
    expect(broken(schema, ['tail', 'x'])).toEqual([
      '$[0] const: not the expected value',
      '$[1] type: expected integer, got string',
    ]);
    expect(broken(schema, ['head'])).toEqual(['$ minItems: 1 item, at least 2']);
    expect(broken(schema, ['head', 1, 2, 3, 4])).toEqual(['$ maxItems: 5 items, at most 4']);
    expect(broken(schema, ['head', 1, 2, 1, 2])).toEqual([
      '$ maxItems: 5 items, at most 4',
      '$ uniqueItems: items 1 and 3 are equal',
    ]);
    expect(
      broken({ uniqueItems: true }, [
        { a: 1, b: 2 },
        { b: 2, a: 1 },
      ]),
    ).toEqual(['$ uniqueItems: items 0 and 1 are equal']);
    expect(broken({ uniqueItems: false }, [1, 1])).toEqual([]);
  });

  it('checks strings: their length in characters, and patterns with the u flag', () => {
    expect(broken({ maxLength: 2 }, '👍👍')).toEqual([]);
    expect(broken({ maxLength: 2 }, '👍👍👍')).toEqual(['$ maxLength: 3 characters, at most 2']);
    expect(broken({ minLength: 2 }, 'ğ')).toEqual(['$ minLength: 1 character, at least 2']);
    expect(broken({ pattern: '^\\p{Lu}' }, 'Çadır')).toEqual([]);
    expect(broken({ pattern: '^\\p{Lu}' }, 'çadır')).toEqual([
      "$ pattern: doesn't match /^\\p{Lu}/",
    ]);
  });

  it('checks numbers against their bounds and a multiple', () => {
    const schema = { minimum: 0, maximum: 10, exclusiveMinimum: -1, exclusiveMaximum: 11 };
    expect(broken(schema, 0)).toEqual([]);
    expect(broken(schema, 10)).toEqual([]);
    expect(broken(schema, -0.5)).toEqual(['$ minimum: less than 0']);
    expect(broken(schema, 10.5)).toEqual(['$ maximum: more than 10']);
    expect(broken({ exclusiveMinimum: 0 }, 0)).toEqual(['$ exclusiveMinimum: not more than 0']);
    expect(broken({ exclusiveMaximum: 5 }, 5)).toEqual(['$ exclusiveMaximum: not less than 5']);
    expect(broken({ multipleOf: 0.01 }, 1299.9)).toEqual([]);
    expect(broken({ multipleOf: 0.01 }, 19.99)).toEqual([]);
    expect(broken({ multipleOf: 0.1 }, 0.3)).toEqual([]);
    expect(broken({ multipleOf: 0.01 }, 19.999)).toEqual(['$ multipleOf: not a multiple of 0.01']);
    expect(broken({ multipleOf: 5 }, 12)).toEqual(['$ multipleOf: not a multiple of 5']);
  });

  it('allows anything under true, and nothing under false', () => {
    expect(broken(true, { any: 'thing' })).toEqual([]);
    expect(broken(false, null)).toEqual(['$ false: no value is allowed here']);
    expect(broken({ properties: { gone: false } }, { gone: 1 })).toEqual([
      '$.gone false: no value is allowed here',
    ]);
  });

  it('follows references, recursive ones too, and stops at one that loops', () => {
    const tree = {
      $defs: {
        node: {
          type: 'object',
          required: ['name'],
          properties: { name: { type: 'string' }, children: { items: { $ref: '#/$defs/node' } } },
        },
      },
      $ref: '#/$defs/node',
    };
    expect(
      broken(tree, { name: 'a', children: [{ name: 'b', children: [{ name: 'c' }] }] }),
    ).toEqual([]);
    expect(broken(tree, { name: 'a', children: [{ children: [{ name: 1 }] }] })).toEqual([
      '$.children[0].children[0].name type: expected string, got integer',
      '$.children[0] required: "name" is missing',
    ]);
    const loop = {
      $defs: { a: { $ref: '#/$defs/b' }, b: { $ref: '#/$defs/a' } },
      $ref: '#/$defs/a',
    };
    expect(broken(loop, 1)).toEqual([
      '$ $ref: #/$defs/a refers to itself without reaching a value',
    ]);
    expect(broken({ $ref: '#' }, 1)).toEqual([
      '$ $ref: # refers to itself without reaching a value',
    ]);
    // Also where a schema is only tried, as in anyOf.
    expect(broken({ anyOf: [{ $ref: '#' }] }, 1)).toEqual([
      '$ anyOf: matches none of the 1 schema',
    ]);
  });

  it('ignores annotations', () => {
    const annotated = {
      title: 'x',
      description: 'x',
      default: 'x',
      examples: ['x'],
      deprecated: true,
      readOnly: true,
      writeOnly: true,
      $comment: 'x',
      $id: 'x',
      $schema: 'x',
    };
    expect(broken(annotated, 42)).toEqual([]);
  });
});

/** Each checked format, with values it accepts and values it refuses. */
const FORMATS: Record<string, { valid: string[]; invalid: string[] }> = {
  'date-time': {
    valid: ['2026-11-14T22:36:22Z', '2026-11-14t22:36:22.123+03:00', '2024-02-29T00:00:60-00:30'],
    invalid: [
      '2026-11-14 22:36:22Z',
      '2026-11-14T22:36:22',
      '2026-13-01T00:00:00Z',
      '2026-11-14T22:36:22Zt22:36:22Z',
      'T',
      '',
    ],
  },
  date: {
    valid: ['2026-11-14', '2024-02-29', '2000-02-29'],
    invalid: [
      '2026-02-29',
      '1900-02-29',
      '2026-04-31',
      '2026-00-10',
      '2026-13-10',
      '2026-11-00',
      '26-11-14',
      '2026-11-14T',
    ],
  },
  time: {
    valid: ['22:36:22Z', '00:00:00.5+14:00', '23:59:60z'],
    invalid: [
      '24:00:00Z',
      '12:60:00Z',
      '12:00:61Z',
      '12:00:00',
      '12:00:00+24:00',
      '12:00:00+03:60',
      '12:00Z',
    ],
  },
  email: {
    valid: ['ayse@example.com', 'a.b+c@mail.example.co.uk', 'user@localhost'],
    invalid: ['ayse', 'ayse@', '@example.com', 'a yse@example.com', 'a@b@c', 'a@.com'],
  },
  uri: {
    valid: ['https://example.com/a?b=c', 'mailto:ayse@example.com', 'urn:isbn:0451450523'],
    invalid: ['example.com', '/relative/path', 'https://exa mple.com', '1http://x'],
  },
  uuid: {
    valid: ['123e4567-e89b-12d3-a456-426614174000', '123E4567-E89B-12D3-A456-426614174000'],
    invalid: ['123e4567e89b12d3a456426614174000', '123e4567-e89b-12d3-a456-42661417400g'],
  },
};

describe('formats (ADR-0030)', () => {
  it.each(Object.entries(FORMATS))('%s: accepts its own and refuses the rest', (format, values) => {
    for (const value of values.valid) {
      expect(validateJson({ format }, value), `${format} ${value}`).toEqual([]);
    }
    for (const value of values.invalid) {
      expect(validateJson({ format }, value), `${format} ${value}`).toEqual([
        { path: '$', keyword: 'format', message: `not a ${format}` },
      ]);
    }
  });

  it('checks exactly these formats, and refuses any other when the schema loads', () => {
    for (const format of Object.keys(FORMATS)) expect(schemaProblems({ format })).toEqual([]);
    for (const format of ['ipv4', 'hostname', 'uri-reference', 'regex', 'duration']) {
      expect(schemaProblems({ format })).toHaveLength(1);
    }
  });
});
