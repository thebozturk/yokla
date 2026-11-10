import { describe, expect, it } from 'vitest';
import { getFieldPath, parseJsonPath, queryJsonPath } from './jsonpath.ts';

const doc = {
  data: {
    answer: 'ok',
    products: [
      { id: 'a', price: { amount: 10 } },
      { id: 'b', price: { amount: 20 } },
    ],
    'odd key': 1,
    byId: { x: { n: 1 }, y: { n: 2 } },
  },
};

describe('parseJsonPath', () => {
  it('parses every supported segment', () => {
    expect(parseJsonPath("$.data['odd key'].products[1][*]")).toEqual([
      { kind: 'name', name: 'data' },
      { kind: 'name', name: 'odd key' },
      { kind: 'name', name: 'products' },
      { kind: 'index', index: 1 },
      { kind: 'wildcard' },
    ]);
    expect(parseJsonPath('$')).toEqual([]);
  });

  it.each(['data.answer', '$..answer', '$.data[?(@.id)]', '$.data[-1]', "$['unterminated]"])(
    'rejects %s',
    (path) => {
      expect(() => parseJsonPath(path)).toThrow(/invalid JSONPath/u);
    },
  );
});

describe('queryJsonPath', () => {
  it.each([
    ['$.data.answer', ['ok']],
    ['$.data.products[*].id', ['a', 'b']],
    ['$.data.products[1].price.amount', [20]],
    ["$.data['odd key']", [1]],
    ['$.data.byId[*].n', [1, 2]],
    ['$', [doc]],
  ])('%s', (path, expected) => {
    expect(queryJsonPath(doc, path)).toEqual(expected);
  });

  it.each(['$.data.missing', '$.data.products[5]', '$.data.answer[*]', '$.data.answer.length'])(
    'selects nothing for %s',
    (path) => {
      expect(queryJsonPath(doc, path)).toEqual([]);
    },
  );

  it('does not read inherited properties', () => {
    expect(queryJsonPath({}, '$.constructor')).toEqual([]);
  });
});

describe('getFieldPath', () => {
  it('reads dotted paths and returns undefined when absent', () => {
    expect(getFieldPath({ price: { amount: 5 } }, 'price.amount')).toBe(5);
    expect(getFieldPath({ price: null }, 'price.amount')).toBeUndefined();
    expect(getFieldPath({}, 'toString')).toBeUndefined();
  });
});
