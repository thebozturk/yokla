import { describe, expect, it } from 'vitest';
import type { ProxyCallView } from '../checks/types.ts';
import { proxyCall } from '../testing.ts';
import { readToolResult, seenEvidence, type ToolResultsMapping } from './seen.ts';

type Message = NonNullable<ProxyCallView['prompt']>[number];
const result = (tool: string | undefined, text: string): Message => ({
  role: 'tool',
  text,
  ...(tool === undefined ? {} : { tool }),
});
const sent = (...prompt: Message[]) => proxyCall({ prompt });

const MAPPING: ToolResultsMapping = {
  search_products: {
    products: {
      items: '$.results[*]',
      fields: { id: 'product_id', price: 'price', inStock: { from: 'in_stock', as: 'boolean' } },
    },
  },
};
const search = (...results: unknown[]) => JSON.stringify({ results });
const ESPRESSO = { product_id: 'AR-1009', price: 329, in_stock: false };
const DRIP = { product_id: 'AR-1001', price: 79, in_stock: true };

describe('readToolResult (ADR-0026)', () => {
  it('reads the whole text as JSON, or else from its first { to its last }', () => {
    expect(readToolResult('{"a":1}')).toEqual({ value: { a: 1 } });
    expect(readToolResult('[1,2]')).toEqual({ value: [1, 2] });
    expect(readToolResult('Search returned 1 result:\n<data>\n{"a":{"b":2}}\n</data>')).toEqual({
      value: { a: { b: 2 } },
    });
  });

  it('gives undefined for text that is neither', () => {
    expect(readToolResult('No product with id X.')).toBeUndefined();
    expect(readToolResult('{"a": 1 ...[truncated]')).toBeUndefined();
    expect(readToolResult('} backwards {')).toBeUndefined();
  });
});

describe('seenEvidence (ADR-0026)', () => {
  it("maps the results of the mapped tools, with the tool, from every call's prompt", () => {
    const calls = [
      sent({ role: 'user', text: 'espresso?' }),
      sent(result('search_products', `Found:\n<data>\n${search(ESPRESSO)}\n</data>`)),
      sent(result('search_products', search(DRIP))),
    ];
    expect(seenEvidence(calls, MAPPING)).toEqual({
      seen: {
        products: [
          { tool: 'search_products', item: { id: 'AR-1009', price: 329, inStock: false } },
          { tool: 'search_products', item: { id: 'AR-1001', price: 79, inStock: true } },
        ],
      },
      issues: [],
    });
  });

  it('sees an item once, though an app sends its result again in later calls', () => {
    const again = result('search_products', search(ESPRESSO, DRIP));
    const calls = [sent(again), sent({ role: 'user', text: 'hm' }, again)];
    expect(seenEvidence(calls, MAPPING).seen['products']).toHaveLength(2);
    // Without ids, the same item is the same content.
    const noIds: ToolResultsMapping = {
      search_products: { products: { items: '$.results[*]', fields: { price: 'price' } } },
    };
    expect(seenEvidence(calls, noIds).seen['products']).toEqual([
      { tool: 'search_products', item: { price: 329 } },
      { tool: 'search_products', item: { price: 79 } },
    ]);
  });

  it('ignores other tools, results that name no tool, and other roles', () => {
    const calls = [
      sent(
        result('get_cart', search(ESPRESSO)),
        result(undefined, search(ESPRESSO)),
        { role: 'user', text: search(ESPRESSO) },
        { role: 'assistant', text: search(ESPRESSO), tool: 'search_products' },
      ),
    ];
    expect(seenEvidence(calls, MAPPING)).toEqual({ seen: {}, issues: [] });
    expect(seenEvidence([sent(result('search_products', search(ESPRESSO)))], undefined)).toEqual({
      seen: {},
      issues: [],
    });
  });

  it('notes a mapped result that is not JSON, once per tool, and reads the others', () => {
    const calls = [
      sent(result('search_products', 'The search failed.'), result('search_products', 'Again.')),
      sent(result('search_products', search(DRIP))),
      proxyCall({ prompt: null }),
    ];
    expect(seenEvidence(calls, MAPPING)).toEqual({
      seen: {
        products: [{ tool: 'search_products', item: { id: 'AR-1001', price: 79, inStock: true } }],
      },
      issues: ["a result of search_products isn't JSON, so nothing was read from it"],
    });
  });
});
