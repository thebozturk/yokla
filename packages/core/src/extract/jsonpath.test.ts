import { describe, expect, it } from 'vitest';
import { getFieldPath, parseJsonPath, queryJsonPath, selectJsonPath } from './jsonpath.ts';

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

describe('selectJsonPath (ADR-0030)', () => {
  it('gives each value it selects with its own path', () => {
    expect(selectJsonPath(doc, '$.data.products[*].price.amount')).toEqual([
      { path: '$.data.products[0].price.amount', value: 10 },
      { path: '$.data.products[1].price.amount', value: 20 },
    ]);
    expect(selectJsonPath(doc, "$.data['odd key']")).toEqual([
      { path: '$.data["odd key"]', value: 1 },
    ]);
    expect(selectJsonPath(doc, '$.data.byId[*].n')).toEqual([
      { path: '$.data.byId.x.n', value: 1 },
      { path: '$.data.byId.y.n', value: 2 },
    ]);
    expect(selectJsonPath(doc, '$.data.products[1].id')).toEqual([
      { path: '$.data.products[1].id', value: 'b' },
    ]);
    expect(selectJsonPath(doc, '$')).toEqual([{ path: '$', value: doc }]);
  });

  it('selects nothing where the document has nothing', () => {
    expect(selectJsonPath(doc, '$.data.missing')).toEqual([]);
    expect(selectJsonPath(doc, '$.data.products[5]')).toEqual([]);
    expect(selectJsonPath(doc, '$.data.answer[*]')).toEqual([]);
    expect(selectJsonPath(doc, '$.data.products.id')).toEqual([]);
    expect(selectJsonPath(doc, '$.data[0]')).toEqual([]);
  });

  it('selects what queryJsonPath selects, in the same order', () => {
    for (const path of ['$.data.products[*]', '$.data.byId[*]', '$.data[*]', '$..x'.slice(0, 1)]) {
      expect(selectJsonPath(doc, path).map((node) => node.value)).toEqual(queryJsonPath(doc, path));
    }
  });
});

describe('getFieldPath', () => {
  it('reads dotted paths and returns undefined when absent', () => {
    expect(getFieldPath({ price: { amount: 5 } }, 'price.amount')).toBe(5);
    expect(getFieldPath({ price: null }, 'price.amount')).toBeUndefined();
    expect(getFieldPath({}, 'toString')).toBeUndefined();
  });
});
