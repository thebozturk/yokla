import { describe, expect, it } from 'vitest';
import { readUsage, sseEvents, UNMEASURED } from './usage.ts';

const json = (value: unknown) => JSON.stringify(value);
const sse = (...events: unknown[]) =>
  `${events.map((event) => `data: ${typeof event === 'string' ? event : json(event)}`).join('\n\n')}\n\n`;

describe('readUsage, OpenAI-compatible', () => {
  it('reads chat completions with cached and reasoning tokens', () => {
    const body = json({
      model: 'gpt-x-2026',
      usage: {
        prompt_tokens: 120,
        completion_tokens: 40,
        prompt_tokens_details: { cached_tokens: 100 },
        completion_tokens_details: { reasoning_tokens: 12 },
      },
    });
    expect(readUsage('openai-compatible', body, false)).toEqual({
      model: 'gpt-x-2026',
      usage: { input: 120, output: 40, cachedInput: 100, cacheWrite: null, reasoning: 12 },
    });
  });

  it('keeps what a provider leaves out as null, never 0', () => {
    const body = json({ model: 'm', usage: { prompt_tokens: 5, completion_tokens: 2 } });
    expect(readUsage('openai-compatible', body, false).usage).toEqual({
      input: 5,
      output: 2,
      cachedInput: null,
      cacheWrite: null,
      reasoning: null,
    });
    expect(readUsage('openai-compatible', json({ model: 'm' }), false)).toEqual({
      model: 'm',
      usage: UNMEASURED,
    });
    const odd = json({ usage: { prompt_tokens: -1, completion_tokens: 2.5 } });
    expect(readUsage('openai-compatible', odd, false).usage).toMatchObject({
      input: null,
      output: null,
    });
  });

  it('reads the Responses API', () => {
    const body = json({
      model: 'm',
      usage: {
        input_tokens: 50,
        output_tokens: 9,
        input_tokens_details: { cached_tokens: 10 },
        output_tokens_details: { reasoning_tokens: 3 },
      },
    });
    expect(readUsage('openai-compatible', body, false).usage).toEqual({
      input: 50,
      output: 9,
      cachedInput: 10,
      cacheWrite: null,
      reasoning: 3,
    });
  });

  it('counts no output tokens for embeddings, as a measurement', () => {
    const body = json({
      object: 'list',
      data: [{ object: 'embedding', embedding: [0.1] }],
      model: 'embed-1',
      usage: { prompt_tokens: 7, total_tokens: 7 },
    });
    expect(readUsage('openai-compatible', body, false).usage).toEqual({
      input: 7,
      output: 0,
      cachedInput: null,
      cacheWrite: null,
      reasoning: 0,
    });
  });

  it('reads a chat stream with a usage chunk, and leaves a stream without one unmeasured', () => {
    const chunk = { model: 'm', choices: [{ delta: { content: 'hi' } }] };
    const withUsage = sse(
      chunk,
      { ...chunk, choices: [], usage: { prompt_tokens: 8, completion_tokens: 3 } },
      '[DONE]',
    );
    expect(readUsage('openai-compatible', withUsage, true)).toEqual({
      model: 'm',
      usage: { input: 8, output: 3, cachedInput: null, cacheWrite: null, reasoning: null },
    });
    expect(readUsage('openai-compatible', sse(chunk, chunk, '[DONE]'), true)).toEqual({
      model: 'm',
      usage: UNMEASURED,
    });
  });

  it('reads a Responses API stream from its completed event', () => {
    const body = sse(
      { type: 'response.created', response: { model: 'm' } },
      { type: 'response.output_text.delta', delta: 'x' },
      {
        type: 'response.completed',
        response: { model: 'm-2', usage: { input_tokens: 4, output_tokens: 1 } },
      },
    );
    expect(readUsage('openai-compatible', body, true)).toEqual({
      model: 'm-2',
      usage: { input: 4, output: 1, cachedInput: null, cacheWrite: null, reasoning: null },
    });
  });
});

describe('readUsage, Responses API stream ends', () => {
  it('reads the usage of an incomplete response too', () => {
    const body = sse({
      type: 'response.incomplete',
      response: { model: 'm', usage: { input_tokens: 6, output_tokens: 64 } },
    });
    expect(readUsage('openai-compatible', body, true).usage).toMatchObject({
      input: 6,
      output: 64,
    });
  });
});

describe('readUsage, Anthropic', () => {
  it('adds cache reads and writes to the input and keeps them apart', () => {
    const body = json({
      model: 'claude-x',
      usage: {
        input_tokens: 10,
        output_tokens: 20,
        cache_read_input_tokens: 300,
        cache_creation_input_tokens: 50,
      },
    });
    expect(readUsage('anthropic', body, false)).toEqual({
      model: 'claude-x',
      usage: { input: 360, output: 20, cachedInput: 300, cacheWrite: 50, reasoning: null },
    });
    const plain = json({ usage: { input_tokens: 10, output_tokens: 2 } });
    expect(readUsage('anthropic', plain, false).usage).toEqual({
      input: 10,
      output: 2,
      cachedInput: null,
      cacheWrite: null,
      reasoning: null,
    });
  });

  it('reads a stream: input from message_start, the final output from message_delta', () => {
    const body = [
      'event: message_start',
      `data: ${json({ type: 'message_start', message: { model: 'claude-x', usage: { input_tokens: 25, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } })}`,
      '',
      'event: content_block_delta',
      `data: ${json({ type: 'content_block_delta', delta: { text: 'Hi' } })}`,
      '',
      'event: message_delta',
      `data: ${json({ type: 'message_delta', usage: { output_tokens: 15 } })}`,
      '',
    ].join('\n');
    expect(readUsage('anthropic', body, true)).toEqual({
      model: 'claude-x',
      usage: { input: 25, output: 15, cachedInput: 0, cacheWrite: 0, reasoning: null },
    });
  });

  it('is unmeasured for a body that is not JSON', () => {
    expect(readUsage('anthropic', '<html>bad gateway</html>', false)).toEqual({
      model: null,
      usage: UNMEASURED,
    });
  });
});

describe('sseEvents', () => {
  it('joins multi-line data, accepts CRLF, and skips comments, [DONE] and broken events', () => {
    const body =
      ': keep-alive\r\n\r\ndata: {"a":\r\ndata: 1}\r\n\r\ndata: not json\n\ndata: [DONE]\n\n';
    expect(sseEvents(body)).toEqual([{ a: 1 }]);
    // Data lines of one event join with a newline, as the SSE format says.
    expect(sseEvents('data: 1\ndata: 2\n\n')).toEqual([]);
    expect(sseEvents('data: [1,\ndata: 2]\n\n')).toEqual([[1, 2]]);
  });
});
