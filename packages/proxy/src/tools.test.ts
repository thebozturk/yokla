import { describe, expect, it } from 'vitest';
import { readOffered, readToolCalls } from './tools.ts';

const json = (value: unknown) => JSON.stringify(value);
const sse = (...events: unknown[]) =>
  `${events.map((event) => `data: ${json(event)}`).join('\n\n')}\n\ndata: [DONE]\n\n`;

describe('readOffered (ADR-0025)', () => {
  it('names the tools of chat completions, the Responses API and Anthropic', () => {
    expect(
      readOffered(
        json({
          tools: [
            { type: 'function', function: { name: 'search_products', parameters: {} } },
            { type: 'function', function: { name: 'add_to_cart' } },
          ],
          functions: [{ name: 'legacy_lookup' }],
        }),
      ),
    ).toEqual(['search_products', 'add_to_cart', 'legacy_lookup']);
    expect(
      readOffered(
        json({ tools: [{ type: 'function', name: 'get_policy' }, { type: 'web_search' }] }),
      ),
    ).toEqual(['get_policy', 'web_search']);
    expect(readOffered(json({ tools: [{ name: 'lookup_order', input_schema: {} }] }))).toEqual([
      'lookup_order',
    ]);
  });

  it('gives [] for a request without tools, and null for one it cannot read', () => {
    expect(readOffered(json({ messages: [] }))).toEqual([]);
    expect(readOffered('')).toEqual([]);
    expect(readOffered('{')).toBeNull();
    expect(readOffered('[1]')).toBeNull();
    expect(readOffered(undefined)).toBeNull();
  });
});

describe('readToolCalls from a JSON answer (ADR-0025)', () => {
  it('reads chat completions tool calls in order, and a legacy function call', () => {
    const body = json({
      choices: [
        {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'a',
                type: 'function',
                function: { name: 'search_products', arguments: '{"q":"tent"}' },
              },
              { id: 'b', type: 'function', function: { name: 'get_policy', arguments: '' } },
            ],
          },
        },
      ],
    });
    expect(readToolCalls('openai-compatible', body, false, 200)).toEqual([
      { name: 'search_products', arguments: '{"q":"tent"}' },
      { name: 'get_policy', arguments: '' },
    ]);
    const legacy = json({
      choices: [{ message: { function_call: { name: 'lookup', arguments: '{}' } } }],
    });
    expect(readToolCalls('openai-compatible', legacy, false, 200)).toEqual([
      { name: 'lookup', arguments: '{}' },
    ]);
    const plain = json({ choices: [{ message: { role: 'assistant', content: 'Merhaba' } }] });
    expect(readToolCalls('openai-compatible', plain, false, 200)).toEqual([]);
  });

  it('reads Responses API function calls and Anthropic tool_use blocks', () => {
    const responses = json({
      output: [
        { type: 'message', content: [] },
        { type: 'function_call', name: 'search_products', arguments: '{"max":500}' },
      ],
    });
    expect(readToolCalls('openai-compatible', responses, false, 200)).toEqual([
      { name: 'search_products', arguments: '{"max":500}' },
    ]);
    const anthropic = json({
      content: [
        { type: 'text', text: 'Bakıyorum.' },
        { type: 'tool_use', id: 't1', name: 'search_products', input: { max: 500 } },
        { type: 'tool_use', id: 't2', name: 'cheapest_shown' },
      ],
    });
    expect(readToolCalls('anthropic', anthropic, false, 200)).toEqual([
      { name: 'search_products', arguments: '{"max":500}' },
      { name: 'cheapest_shown', arguments: '{}' },
    ]);
  });

  it('gives [] for embeddings and for a call that got no answer or an error', () => {
    const embeddings = json({ object: 'list', data: [{ object: 'embedding', embedding: [0.1] }] });
    expect(readToolCalls('openai-compatible', embeddings, false, 200)).toEqual([]);
    expect(readToolCalls('openai-compatible', '{"error":{}}', false, 500)).toEqual([]);
    expect(readToolCalls('anthropic', undefined, false, null)).toEqual([]);
    expect(readToolCalls('openai-compatible', '', false, 429)).toEqual([]);
  });

  it('gives null for an answer it cannot read', () => {
    expect(readToolCalls('openai-compatible', '{"choices": [', false, 200)).toBeNull();
    expect(readToolCalls('openai-compatible', '{"something":"else"}', false, 200)).toBeNull();
    expect(readToolCalls('anthropic', '{"type":"message"}', false, 200)).toBeNull();
    expect(readToolCalls('anthropic', undefined, false, 200)).toBeNull();
  });
});

describe('readToolCalls from a stream (ADR-0025)', () => {
  it('joins the pieces of chat completions calls by index', () => {
    const body = sse(
      { choices: [{ delta: { role: 'assistant' } }] },
      {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: 'a', function: { name: 'search_products', arguments: '' } },
              ],
            },
          },
        ],
      },
      {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 1, id: 'b', function: { name: 'get_policy', arguments: '{"topic"' } },
              ],
            },
          },
        ],
      },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"q":' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"tent"}' } }] } }] },
      {
        choices: [
          { delta: { tool_calls: [{ index: 1, function: { arguments: ':"returns"}' } }] } },
        ],
      },
      { choices: [], usage: { prompt_tokens: 5, completion_tokens: 3 } },
    );
    expect(readToolCalls('openai-compatible', body, true, 200)).toEqual([
      { name: 'search_products', arguments: '{"q":"tent"}' },
      { name: 'get_policy', arguments: '{"topic":"returns"}' },
    ]);
    const text = sse({ choices: [{ delta: { content: 'Merhaba' } }] });
    expect(readToolCalls('openai-compatible', text, true, 200)).toEqual([]);
  });

  it('orders calls by their index, whichever piece came first', () => {
    const body = sse(
      {
        choices: [
          { delta: { tool_calls: [{ index: 1, function: { name: 'second', arguments: '{}' } }] } },
        ],
      },
      {
        choices: [
          { delta: { tool_calls: [{ index: 0, function: { name: 'first', arguments: '{}' } }] } },
        ],
      },
    );
    expect(readToolCalls('openai-compatible', body, true, 200)?.map((call) => call.name)).toEqual([
      'first',
      'second',
    ]);
  });

  it('reads the Responses API calls from its completed event', () => {
    const body = sse(
      { type: 'response.output_item.added', item: { type: 'function_call', name: 'x' } },
      {
        type: 'response.completed',
        response: { output: [{ type: 'function_call', name: 'search_products', arguments: '{}' }] },
      },
    );
    expect(readToolCalls('openai-compatible', body, true, 200)).toEqual([
      { name: 'search_products', arguments: '{}' },
    ]);
  });

  it('joins Anthropic input pieces, and keeps the start input of a call without pieces', () => {
    const body = sse(
      { type: 'message_start', message: { usage: { input_tokens: 5 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Bakıyorum' } },
      {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'tool_use', name: 'search_products', input: {} },
      },
      {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'input_json_delta', partial_json: '{"max":' },
      },
      {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'input_json_delta', partial_json: '500}' },
      },
      {
        type: 'content_block_start',
        index: 2,
        content_block: { type: 'tool_use', name: 'cheapest_shown', input: {} },
      },
      // A tool the provider runs itself is not a call the app gets.
      {
        type: 'content_block_start',
        index: 3,
        content_block: { type: 'server_tool_use', name: 'web_search', input: {} },
      },
      { type: 'message_delta', usage: { output_tokens: 9 } },
    );
    expect(readToolCalls('anthropic', body, true, 200)).toEqual([
      { name: 'search_products', arguments: '{"max":500}' },
      { name: 'cheapest_shown', arguments: '{}' },
    ]);
  });

  it('gives null for a stream with no event it can read', () => {
    expect(readToolCalls('openai-compatible', 'data: {broken\n\n', true, 200)).toBeNull();
    expect(readToolCalls('anthropic', '', true, 200)).toBeNull();
  });
});
