import { describe, expect, it } from 'vitest';
import {
  getFieldPath,
  parseJsonPath,
  queryJsonPath,
  selectJsonPath,
  updateJsonPath,
} from './jsonpath.ts';

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

/** A tool result's JSON, fresh for each change (ADR-0043). */
const searchResult = () => ({
  results: [{ name: 'Kubbe Çadır' }, { name: 'Plaj Çadırı' }],
  meta: { first: 'a', second: 'b' },
});
const exclaim = (value: unknown) => (typeof value === 'string' ? `${value}!` : undefined);

describe('updateJsonPath (ADR-0043)', () => {
  it('replaces each value the path selects, in place, and counts them', () => {
    const tree = searchResult();
    expect(updateJsonPath(tree, '$.results[*].name', exclaim)).toBe(2);
    expect(tree.results).toEqual([{ name: 'Kubbe Çadır!' }, { name: 'Plaj Çadırı!' }]);
    expect(updateJsonPath(tree, '$.results[1].name', exclaim)).toBe(1);
    expect(tree.results[1]).toEqual({ name: 'Plaj Çadırı!!' });
    expect(updateJsonPath(tree, "$.meta['second']", exclaim)).toBe(1);
    expect(updateJsonPath(tree, '$.meta[*]', exclaim)).toBe(2);
    expect(tree.meta).toEqual({ first: 'a!', second: 'b!!' });
    const reversed = searchResult();
    expect(
      updateJsonPath(reversed, '$.results', (value) =>
        Array.isArray(value) ? value.toReversed() : undefined,
      ),
    ).toBe(1);
    expect(reversed.results.map((item) => item.name)).toEqual(['Plaj Çadırı', 'Kubbe Çadır']);
    const items = searchResult();
    expect(updateJsonPath(items, '$.results[*]', () => 'x')).toBe(2);
    expect(items.results).toEqual(['x', 'x']);
    const second = searchResult();
    expect(updateJsonPath(second, '$.results[1]', () => 'y')).toBe(1);
    expect(second.results).toEqual([{ name: 'Kubbe Çadır' }, 'y']);
  });

  it('leaves a value whose update is undefined, and counts nothing it found nowhere', () => {
    const tree = searchResult();
    expect(updateJsonPath(tree, '$.results[*]', exclaim)).toBe(0);
    expect(tree).toEqual(searchResult());
    expect(updateJsonPath(tree, '$.nothing.name', exclaim)).toBe(0);
    expect(updateJsonPath(tree, '$.results[5].name', exclaim)).toBe(0);
    expect(updateJsonPath(tree, '$.meta[0]', exclaim)).toBe(0);
    expect(updateJsonPath(tree, '$.results.name', exclaim)).toBe(0);
    expect(updateJsonPath('text', '$[*]', exclaim)).toBe(0);
    // The root can't be replaced in place.
    expect(updateJsonPath(tree, '$', () => 'x')).toBe(0);
  });
});
