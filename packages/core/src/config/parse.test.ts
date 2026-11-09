import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { formatIssue, parseConfig, type ParseResult } from './parse.ts';

const schema = z.strictObject({
  name: z.string(),
  answer: z.string().optional(),
  count: z.int().optional(),
  nested: z.strictObject({ flag: z.boolean() }).optional(),
  items: z.array(z.strictObject({ id: z.string() })).optional(),
});

function issues<T>(result: ParseResult<T>) {
  if (result.ok) throw new Error('expected issues');
  return result.issues;
}

describe('parseConfig', () => {
  it('parses valid YAML', () => {
    expect(parseConfig('name: shop\ncount: 2\n', 'a.yaml', schema)).toEqual({
      ok: true,
      value: { name: 'shop', count: 2 },
    });
  });

  it('accepts JSON', () => {
    expect(parseConfig('{"name": "shop", "items": [{"id": "x"}]}', 'a.json', schema)).toEqual({
      ok: true,
      value: { name: 'shop', items: [{ id: 'x' }] },
    });
  });

  it('uses YAML 1.2, so "no" and "on" stay strings', () => {
    expect(parseConfig('name: on\nanswer: no\n', 'a.yaml', schema)).toEqual({
      ok: true,
      value: { name: 'on', answer: 'no' },
    });
  });

  it('reports a type error at the value', () => {
    expect(issues(parseConfig('name: shop\ncount: many\n', 'a.yaml', schema))).toEqual([
      {
        file: 'a.yaml',
        line: 2,
        column: 8,
        path: 'count',
        message: 'Invalid input: expected number, received string',
      },
    ]);
  });

  it('reports an unknown key at the key itself', () => {
    const text = 'name: shop\nnested:\n  flag: true\n  falg: false\n';
    expect(issues(parseConfig(text, 'a.yaml', schema))).toEqual([
      { file: 'a.yaml', line: 4, column: 3, path: 'nested.falg', message: 'unknown key' },
    ]);
  });

  it('reports a missing key at its parent', () => {
    expect(issues(parseConfig('count: 1\n', 'a.yaml', schema))).toEqual([
      {
        file: 'a.yaml',
        line: 1,
        column: 1,
        path: 'name',
        message: expect.stringContaining('expected string') as unknown,
      },
    ]);
  });

  it('reports array items by index', () => {
    const text = 'name: shop\nitems:\n  - id: x\n  - id: 2\n';
    expect(issues(parseConfig(text, 'a.yaml', schema))).toMatchObject([
      { line: 4, column: 9, path: 'items[1].id' },
    ]);
  });

  it('rejects duplicate keys', () => {
    expect(issues(parseConfig('name: a\nname: b\n', 'a.yaml', schema))).toMatchObject([
      { line: 2, column: 1, message: expect.stringMatching(/unique/u) as unknown },
    ]);
  });

  it('reports syntax errors with their position', () => {
    // The parser notices the missing "]" at the end of the input.
    expect(issues(parseConfig('name: [unclosed\n', 'a.yaml', schema))[0]).toMatchObject({
      file: 'a.yaml',
      line: 2,
      column: 1,
    });
  });

  it('rejects custom tags', () => {
    expect(parseConfig('name: !!js/function "x"\n', 'a.yaml', schema).ok).toBe(false);
  });

  it('caps alias expansion', () => {
    const text = [
      'a: &a [x, x, x, x, x, x, x, x, x, x]',
      'b: &b [*a, *a, *a, *a, *a, *a, *a, *a, *a, *a]',
      'c: &c [*b, *b, *b, *b, *b, *b, *b, *b, *b, *b]',
      'name: [*c, *c, *c, *c, *c, *c, *c, *c, *c, *c]',
    ].join('\n');
    expect(issues(parseConfig(text, 'a.yaml', z.unknown()))[0]?.message).toMatch(/alias/iu);
  });
});

describe('formatIssue', () => {
  it('formats file, position, path and message', () => {
    expect(
      formatIssue({ file: 'p.yaml', line: 3, column: 5, path: 'target.url', message: 'bad' }),
    ).toBe('p.yaml:3:5: target.url: bad');
    expect(formatIssue({ file: 'p.yaml', path: '', message: 'bad' })).toBe('p.yaml: bad');
  });
});
