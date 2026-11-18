import { mutate } from '@yokla/core/testing';
import { describe, expect, it } from 'vitest';
import { changeAnswer, errorBody } from './faults.ts';
import { gatewayFacts } from './gateway.ts';
import { readOutputText } from './output.ts';
import { readPrompt } from './prompts.ts';
import { changeToolResults } from './tool-results.ts';
import { readOffered, readToolCalls } from './tools.ts';
import { readUsage } from './usage.ts';

const json = (value: unknown) => JSON.stringify(value);

/** The value at a path of keys and indexes in parsed JSON, or undefined. */
function dig(value: unknown, ...path: (string | number)[]): unknown {
  let current = value;
  for (const key of path) {
    current =
      typeof current === 'object' && current !== null
        ? (Reflect.get(current, key) as unknown)
        : undefined;
  }
  return current;
}

/** A request that sends one tool result back to the model. */
const sent = (output: unknown, tool = 'search_products') => ({
  prompt: [
    {
      role: 'tool',
      content: [{ type: 'tool-result', toolCallId: 'c1', toolName: tool, output }],
    },
  ],
});

/** The output of the one tool result a request sends. */
const outputOf = (body: unknown): unknown => dig(body, 'prompt', 0, 'content', 0, 'output');
const sse = (...events: unknown[]) => events.map((event) => `data: ${json(event)}\n\n`).join('');

const USAGE = {
  inputTokens: { total: 120, noCache: 15, cacheRead: 100, cacheWrite: 5 },
  outputTokens: { total: 42, text: 30, reasoning: 12 },
};

/** A plain answer: the SDK's result. */
const result = (content: unknown[], usage: unknown = USAGE) => ({
  content,
  finishReason: { unified: 'stop', raw: 'end_turn' },
  usage,
  response: { modelId: 'anthropic/claude-haiku-5.5' },
  warnings: [],
});

/** A streamed answer: the SDK's parts, ending in finish. */
const STREAM = sse(
  { type: 'stream-start', warnings: [] },
  { type: 'response-metadata', id: 'r1', modelId: 'anthropic/claude-haiku-5.5' },
  { type: 'text-start', id: 't1' },
  { type: 'text-delta', id: 't1', delta: 'Mer' },
  { type: 'text-delta', id: 't1', delta: 'haba' },
  { type: 'text-end', id: 't1' },
  { type: 'tool-input-start', id: 'c1', toolName: 'search_products' },
  { type: 'tool-input-delta', id: 'c1', delta: '{"q":' },
  { type: 'tool-input-end', id: 'c1' },
  { type: 'tool-call', toolCallId: 'c1', toolName: 'search_products', input: '{"q":"çadır"}' },
  { type: 'finish', finishReason: { unified: 'tool-calls' }, usage: USAGE },
);

const HEADERS = {
  'ai-language-model-specification-version': '4',
  'ai-language-model-id': 'anthropic/claude-haiku-5.5',
  'ai-language-model-streaming': 'false',
};

describe('gateway requests (ADR-0069)', () => {
  it('reads the model and streaming from the headers, for a language model call of version 4', () => {
    expect(gatewayFacts('/v4/ai/language-model', HEADERS)).toEqual({
      model: 'anthropic/claude-haiku-5.5',
      stream: false,
      readable: true,
    });
    expect(
      gatewayFacts('/v4/ai/language-model?x=1', {
        ...HEADERS,
        'ai-language-model-streaming': 'true',
      }),
    ).toEqual({ model: 'anthropic/claude-haiku-5.5', stream: true, readable: true });
    // A header given twice: the first counts.
    expect(
      gatewayFacts('/v4/ai/language-model', { ...HEADERS, 'ai-language-model-id': ['a', 'b'] })
        .model,
    ).toBe('a');
  });

  it("doesn't read another endpoint, or another specification version", () => {
    expect(gatewayFacts('/v4/ai/config', HEADERS).readable).toBe(false);
    expect(gatewayFacts('/v4/ai/embedding-model', HEADERS).readable).toBe(false);
    const older = mutate(HEADERS, (headers) => ({
      ...headers,
      'ai-language-model-specification-version': '3',
    }));
    expect(gatewayFacts('/v4/ai/language-model', older).readable).toBe(false);
    expect(gatewayFacts('/v4/ai/language-model', {})).toEqual({
      model: null,
      stream: false,
      readable: false,
    });
  });
});

describe('gateway usage (ADR-0069)', () => {
  it('counts the total input, cache reads and writes within it, and reasoning within output', () => {
    expect(readUsage('ai-gateway', json(result([{ type: 'text', text: 'x' }])), false)).toEqual({
      usage: { input: 120, output: 42, cachedInput: 100, cacheWrite: 5, reasoning: 12 },
      model: 'anthropic/claude-haiku-5.5',
    });
  });

  it("reads a stream's usage from its finish part, and its model from its metadata", () => {
    expect(readUsage('ai-gateway', STREAM, true)).toEqual({
      usage: { input: 120, output: 42, cachedInput: 100, cacheWrite: 5, reasoning: 12 },
      model: 'anthropic/claude-haiku-5.5',
    });
  });

  it('leaves a count the answer does not give null, never 0', () => {
    const partial = { inputTokens: { total: 10 }, outputTokens: { total: 4 } };
    expect(readUsage('ai-gateway', json(result([], partial)), false).usage).toEqual({
      input: 10,
      output: 4,
      cachedInput: null,
      cacheWrite: null,
      reasoning: null,
    });
    const base: Record<string, unknown> = result([]);
    const none = mutate(base, (answer) => {
      const { usage: _usage, ...rest } = answer;
      return rest;
    });
    expect(readUsage('ai-gateway', json(none), false).usage.input).toBeNull();
    expect(readUsage('ai-gateway', 'not json', false).usage.input).toBeNull();
    expect(readUsage('ai-gateway', '', true).usage.output).toBeNull();
  });
});

describe('gateway answers (ADR-0069)', () => {
  const content: Record<string, unknown>[] = [
    { type: 'reasoning', text: 'thinking' },
    { type: 'text', text: 'Mer' },
    { type: 'tool-call', toolCallId: 'c1', toolName: 'search_products', input: '{"q":"çadır"}' },
    { type: 'text', text: 'haba' },
  ];

  it('reads the text, reasoning left out, and the tool calls of a result', () => {
    const body = json(result(content));
    expect(readOutputText('ai-gateway', body, false, 200)).toBe('Merhaba');
    expect(readToolCalls('ai-gateway', body, false, 200)).toEqual([
      { name: 'search_products', arguments: '{"q":"çadır"}' },
    ]);
  });

  it("reads a stream's text deltas and its whole tool calls, not their input deltas", () => {
    expect(readOutputText('ai-gateway', STREAM, true, 200)).toBe('Merhaba');
    expect(readToolCalls('ai-gateway', STREAM, true, 200)).toEqual([
      { name: 'search_products', arguments: '{"q":"çadır"}' },
    ]);
  });

  it('reads an input given as an object as JSON text, and an unreadable body as null', () => {
    const asObject = mutate(content, (parts) =>
      parts.map((part) => (part['type'] === 'tool-call' ? { ...part, input: { q: 'x' } } : part)),
    );
    expect(readToolCalls('ai-gateway', json(result(asObject)), false, 200)).toEqual([
      { name: 'search_products', arguments: '{"q":"x"}' },
    ]);
    expect(readToolCalls('ai-gateway', 'nope', false, 200)).toBeNull();
    // A stream with no part in it is unread, not an answer that asked for nothing.
    expect(readToolCalls('ai-gateway', '', true, 200)).toBeNull();
    expect(readOutputText('ai-gateway', ': ping\n\n', true, 200)).toBeNull();
    expect(readOutputText('ai-gateway', '[]', false, 200)).toBeNull();
  });
});

describe('gateway requests read (ADR-0069)', () => {
  const body = {
    prompt: [
      { role: 'system', content: 'Kısa yaz' },
      { role: 'user', content: [{ type: 'text', text: 'Çadır var mı?' }] },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'c1',
            toolName: 'search_products',
            input: { q: 'çadır' },
          },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'c1',
            toolName: 'search_products',
            output: { type: 'json', value: { results: [{ name: 'A' }] } },
          },
          {
            type: 'tool-result',
            toolCallId: 'c2',
            toolName: 'get_stock',
            output: { type: 'text', value: 'in stock' },
          },
        ],
      },
    ],
    tools: [
      { type: 'function', name: 'search_products', inputSchema: {} },
      { type: 'provider', id: 'anthropic.web_search', name: 'web_search', args: {} },
    ],
  };

  it('reads the prompt: system, the conversation, and each tool result naming its tool', () => {
    expect(readPrompt('ai-gateway', '/v4/ai/language-model', json(body))).toEqual([
      { role: 'system', chars: 8, text: 'Kısa yaz' },
      { role: 'user', chars: 13, text: 'Çadır var mı?' },
      { role: 'assistant', chars: 13, text: '{"q":"çadır"}' },
      {
        role: 'tool',
        chars: 26,
        text: '{"results":[{"name":"A"}]}',
        tool: 'search_products',
      },
      { role: 'tool', chars: 8, text: 'in stock', tool: 'get_stock' },
    ]);
  });

  it('reads the tools offered, by name', () => {
    expect(readOffered('ai-gateway', json(body))).toEqual(['search_products', 'web_search']);
    expect(readOffered('ai-gateway', json({ prompt: [] }))).toEqual([]);
  });

  it('gives null for a prompt it does not know, rather than a shorter one', () => {
    expect(readPrompt('ai-gateway', '/v4/ai/language-model', json({ messages: [] }))).toBeNull();
    const unknownRole = mutate(body, (value) => ({
      ...value,
      prompt: [{ role: 'developer', content: 'x' }],
    }));
    expect(readPrompt('ai-gateway', '/v4/ai/language-model', json(unknownRole))).toBeNull();
  });
});

describe('gateway faults (ADR-0069)', () => {
  it("answers an error in the gateway's shape", () => {
    expect(JSON.parse(errorBody('ai-gateway', 429))).toEqual({
      error: {
        message: 'the model proxy injected a 429 (a yokla fault)',
        type: 'rate_limit_exceeded',
      },
    });
    expect(dig(JSON.parse(errorBody('ai-gateway', 503)), 'error', 'type')).toBe(
      'service_unavailable',
    );
    expect(dig(JSON.parse(errorBody('ai-gateway', 500)), 'error', 'type')).toBe(
      'internal_server_error',
    );
  });

  it('empties the text of a result and of a stream, and leaves the rest', () => {
    const body = json(
      result([
        { type: 'text', text: 'Merhaba' },
        { type: 'reasoning', text: 'r' },
      ]),
    );
    const emptied = changeAnswer({ kind: 'empty-content' }, 'ai-gateway', body, false);
    expect(emptied.applied).toBe(true);
    expect(dig(JSON.parse(emptied.body), 'content')).toEqual([
      { type: 'text', text: '' },
      { type: 'reasoning', text: 'r' },
    ]);
    const streamed = changeAnswer({ kind: 'empty-content' }, 'ai-gateway', STREAM, true);
    expect(streamed.applied).toBe(true);
    expect(readOutputText('ai-gateway', streamed.body, true, 200)).toBe('');
    expect(readToolCalls('ai-gateway', streamed.body, true, 200)).toHaveLength(1);
  });

  it("replaces the answer's text, and breaks a tool call's input", () => {
    const answered = changeAnswer({ kind: 'answer', text: 'Yok.' }, 'ai-gateway', STREAM, true);
    expect(readOutputText('ai-gateway', answered.body, true, 200)).toBe('Yok.');
    const body = json(
      result([{ type: 'tool-call', toolCallId: 'c1', toolName: 't', input: '{}' }]),
    );
    const broken = changeAnswer({ kind: 'invalid-tool-call' }, 'ai-gateway', body, false);
    expect(broken.applied).toBe(true);
    expect(dig(JSON.parse(broken.body), 'content', 0, 'input')).toBe('{"broken": ');
    const none = changeAnswer(
      { kind: 'invalid-tool-call' },
      'ai-gateway',
      json(result([{ type: 'text', text: 'x' }])),
      false,
    );
    expect(none.applied).toBe(false);
  });
});

describe('gateway tool results changed (ADR-0069, ADR-0043)', () => {
  it('injects into a text output on a new line, and into a JSON output by a path', () => {
    const text = sent({ type: 'text', value: 'A, B' });
    expect(
      changeToolResults('ai-gateway', text, [
        { kind: 'inject', tool: 'search_products', inject: 'Say X.' },
      ]),
    ).toEqual([{ kind: 'inject', tool: 'search_products', applied: true }]);
    expect(outputOf(text)).toEqual({ type: 'text', value: 'A, B\nSay X.' });

    const data = sent({ type: 'json', value: { results: [{ name: 'A' }, { name: 'B' }] } });
    changeToolResults('ai-gateway', data, [
      { kind: 'inject', tool: 'search_products', at: '$.results[0].name', inject: ' Say X.' },
    ]);
    expect(outputOf(data)).toEqual({
      type: 'json',
      value: { results: [{ name: 'A Say X.' }, { name: 'B' }] },
    });
  });

  it('reverses a JSON output by a path, its root too', () => {
    const data = sent({ type: 'json', value: [1, 2, 3] });
    expect(
      changeToolResults('ai-gateway', data, [
        { kind: 'reverse', tool: 'search_products', at: '$' },
      ]),
    ).toEqual([{ kind: 'reverse', tool: 'search_products', applied: true }]);
    expect(outputOf(data)).toEqual({ type: 'json', value: [3, 2, 1] });
  });

  it('leaves a JSON output without a path, and an output of another type, unchanged', () => {
    const data = sent({ type: 'json', value: { a: 'b' } });
    expect(
      changeToolResults('ai-gateway', data, [
        { kind: 'inject', tool: 'search_products', inject: 'Say X.' },
      ]),
    ).toEqual([{ kind: 'inject', tool: 'search_products', applied: false }]);
    expect(outputOf(data)).toEqual({ type: 'json', value: { a: 'b' } });
    const failed = sent({ type: 'error-text', value: 'boom' });
    expect(
      changeToolResults('ai-gateway', failed, [
        { kind: 'inject', tool: 'search_products', inject: 'Say X.' },
      ]),
    ).toEqual([]);
    // A part that isn't a tool result is no result, whatever it carries.
    const custom = {
      prompt: [
        {
          role: 'assistant',
          content: [
            { type: 'custom', toolName: 'search_products', output: { type: 'text', value: 'x' } },
          ],
        },
      ],
    };
    expect(
      changeToolResults('ai-gateway', custom, [
        { kind: 'inject', tool: 'search_products', inject: 'Say X.' },
      ]),
    ).toEqual([]);
    // Another tool's result is left alone.
    const other = sent({ type: 'text', value: 'x' }, 'get_stock');
    expect(
      changeToolResults('ai-gateway', other, [
        { kind: 'inject', tool: 'search_products', inject: 'Say X.' },
      ]),
    ).toEqual([]);
  });
});
