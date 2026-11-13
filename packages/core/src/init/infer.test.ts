import { describe, expect, it } from 'vitest';
import { inferResponse, inferSessionId, shapeOf, type InferOutcome, type Probe } from './infer.ts';

const MESSAGE = 'Hello! What can you help me with?';
const json = (body: unknown, change: Partial<Probe> = {}): Probe => ({
  status: 200,
  contentType: 'application/json',
  body: JSON.stringify(body),
  sent: [MESSAGE],
  ...change,
});
const sse = (
  events: [string | undefined, unknown][],
  contentType = 'text/event-stream',
): Probe => ({
  status: 200,
  contentType,
  body: events
    .map(
      ([name, data]) =>
        `${name === undefined ? '' : `event: ${name}\n`}data: ${JSON.stringify(data)}\n\n`,
    )
    .join(''),
  sent: [MESSAGE],
});

function inferred(outcome: InferOutcome) {
  if (!outcome.ok) throw new Error(`expected an inference, got: ${outcome.problem}`);
  return outcome.inference;
}

describe('inferResponse, JSON', () => {
  it('finds the answer, the route and the runners-up in a shop answer', () => {
    const result = inferred(
      inferResponse(
        json({
          data: {
            answer: 'Hi! I can help you find outdoor gear and answer questions about returns.',
            products: [{ id: 'HLP-001', name: 'Headlamp 200 lm', price: { amount: 349.9 } }],
            metadata: { route: 'greeting', language: 'en' },
          },
        }),
      ),
    );
    expect(result.response).toEqual({ text: '$.data.answer', route: '$.data.metadata.route' });
    expect(result.text).toEqual({
      path: '$.data.answer',
      sample: 'Hi! I can help you find outdoor gear and answer questions about returns.',
      rule: 'the longest text under a key named like an answer',
    });
    expect(result.alternatives).toEqual([
      { path: '$.data.products[0].name', sample: 'Headlamp 200 lm', rule: 'the longest text' },
    ]);
    expect(result.route).toEqual({
      path: '$.data.metadata.route',
      sample: 'greeting',
      rule: 'a key named like a route',
    });
    expect(result.replayed).toBe(result.text.sample);
  });

  it('prefers a key named like an answer to a longer string under another key', () => {
    const result = inferred(
      inferResponse(
        json({
          note: 'A much longer string that sits under some other key entirely',
          reply: 'Hi there, friend',
        }),
      ),
    );
    expect(result.text.path).toBe('$.reply');
    expect(result.alternatives.map((a) => a.path)).toEqual(['$.note']);
  });

  it('takes the longest text when no key is named like an answer, first in order on a tie', () => {
    expect(
      inferred(inferResponse(json({ a: 'short one', b: 'a longer piece of prose' }))).text,
    ).toEqual({
      path: '$.b',
      sample: 'a longer piece of prose',
      rule: 'the longest text',
    });
    expect(inferred(inferResponse(json({ a: 'same size', b: 'same size' }))).text.path).toBe('$.a');
  });

  it('leaves out the probe echoed back, ids, URLs, timestamps and single words', () => {
    const result = inferred(
      inferResponse(
        json({
          message: MESSAGE,
          id: '3f2a9c1e-0b7d-4e55-9a51-8c3f2e1d0a7b',
          link: 'https://example.test/help and more',
          at: '2026-11-13 10:00:00 UTC',
          status: 'answered',
          code: '1234 5678 9012 3456 7890 1234 5678',
          output: 'Hi there, how can I help today?',
        }),
      ),
    );
    expect(result.text.path).toBe('$.output');
    expect(result.alternatives).toEqual([]);
  });

  it('writes array indexes, and quotes keys that are not plain names', () => {
    expect(
      inferred(inferResponse(json({ choices: [{ message: { content: 'Hello from the model' } }] })))
        .text.path,
    ).toBe('$.choices[0].message.content');
    expect(inferred(inferResponse(json({ 'my reply': 'Hello there friend' }))).text.path).toBe(
      "$['my reply']",
    );
  });

  it('carries a session id the answer issues, but not one yokla sent', () => {
    const result = inferred(
      inferResponse(
        json(
          {
            reply: 'Hi there, how can I help?',
            conversation_id: 'c-123',
            sessionId: 'sent-by-yokla',
            meta: { threadId: 42 },
          },
          { sent: [MESSAGE, 'sent-by-yokla'] },
        ),
      ),
    );
    expect(result.carry).toEqual([
      { name: 'conversationId', from: '$.conversation_id', sample: 'c-123' },
      { name: 'threadId', from: '$.meta.threadId', sample: '42' },
    ]);
  });

  it('takes as a route only a single word under a route key', () => {
    expect(inferred(inferResponse(json({ reply: 'Hi there you', route: 'two words' }))).route).toBe(
      undefined,
    );
    expect(
      inferred(inferResponse(json({ reply: 'Hi there you', intent: 'greet' }))).route?.path,
    ).toBe('$.intent');
  });

  it('stops on a failed answer, saying what it saw but no values', () => {
    expect(inferResponse(json({ error: 'bad request' }, { status: 400 }))).toEqual({
      ok: false,
      problem: 'the target answered 400',
      shape: 'application/json',
    });
    expect(inferResponse(json({ ok: true, code: 'X1', items: [{ id: 'secret-id' }] }))).toEqual({
      ok: false,
      problem: 'no string in the answer reads like an answer',
      shape: '{ ok: boolean, code: string, items: [{ id: string }] }',
    });
    expect(inferResponse({ ...json({}), body: 'plain text' }).ok).toBe(false);
  });
});

describe('inferResponse, event streams', () => {
  it('finds the text pieces, the done event and a route in server-sent events', () => {
    const result = inferred(
      inferResponse(
        sse([
          ['products', { products: [{ id: 'HLP-001', name: 'Headlamp 200 lm' }] }],
          ['delta', { text: 'Hi! I can help you ' }],
          ['delta', { text: 'find outdoor gear.' }],
          ['done', { route: 'greeting', language: 'en' }],
        ]),
      ),
    );
    expect(result.response).toEqual({
      stream: { format: 'sse', text: { event: 'delta', from: '$.text' }, done: 'done' },
      text: '$.text',
      route: '$.last.done.route',
    });
    expect(result.text).toEqual({
      path: '$.text',
      sample: 'Hi! I can help you find outdoor gear.',
      rule: 'the longest text under a key named like an answer',
    });
    expect(result.replayed).toBe('Hi! I can help you find outdoor gear.');
  });

  it('prefers the pieces of a text event to a longer label of another event', () => {
    const result = inferred(
      inferResponse(
        sse([
          [
            'tool_call',
            { tool: 'search', label: 'Looking through the whole catalog for travel adapters now' },
          ],
          ['text_delta', { text: 'I found one ' }],
          ['text_delta', { text: 'that fits.' }],
          ['ui', { component: 'products', payload: { items: [] } }],
          ['turn_complete', { stop_reason: 'end_turn' }],
        ]),
      ),
    );
    expect(result.response.stream).toEqual({
      format: 'sse',
      text: { event: 'text_delta', from: '$.text' },
      done: 'turn_complete',
    });
    expect(result.alternatives[0]?.path).toBe('tool_call $.label');
  });

  it('takes an event named like a text piece even when its key is not', () => {
    const result = inferred(
      inferResponse(
        sse([
          ['status', { note: 'Looking for the best answer to your question right now' }],
          ['delta', { v: 'Hello there, ' }],
          ['delta', { v: 'how can I help?' }],
        ]),
      ),
    );
    expect(result.response.stream?.text).toEqual({ event: 'delta', from: '$.v' });
  });

  it('names events by a type key most of them carry, for NDJSON and for SSE without names', () => {
    const lines = [
      { type: 'token', content: 'Hello there, ' },
      { type: 'token', content: 'how can I help?' },
      { type: 'end', usage: { tokens: 9 } },
    ];
    const ndjson: Probe = {
      status: 200,
      contentType: 'application/x-ndjson',
      body: `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`,
      sent: [MESSAGE],
    };
    expect(inferred(inferResponse(ndjson)).response.stream).toEqual({
      format: 'ndjson',
      event: '$.type',
      text: { event: 'token', from: '$.content' },
      done: 'end',
    });
    const unnamed = sse(lines.map((line) => [undefined, line]));
    expect(inferred(inferResponse(unnamed)).response.stream).toMatchObject({
      format: 'sse',
      event: '$.type',
      text: { event: 'token', from: '$.content' },
    });
  });

  it('declares no done event when the stream ends on a text piece or a repeated event', () => {
    const endsOnText = sse([
      ['delta', { text: 'Hello there, ' }],
      ['delta', { text: 'how can I help?' }],
    ]);
    expect(inferred(inferResponse(endsOnText)).response.stream?.done).toBe(undefined);
    const repeated = sse([
      ['ping', {}],
      ['delta', { text: 'Hello there, how can I help?' }],
      ['ping', {}],
    ]);
    expect(inferred(inferResponse(repeated)).response.stream?.done).toBe(undefined);
  });

  it('declares no done event when the last event is the text event itself', () => {
    const probe = sse([
      ['meta', { model: 'm' }],
      ['delta', { text: 'Hello there, how can I help?' }],
    ]);
    expect(inferred(inferResponse(probe)).response.stream?.done).toBe(undefined);
  });

  it('recognises a stream by its body when the content type is missing', () => {
    const probe = {
      ...sse([['delta', { text: 'Hello there, how can I help?' }]]),
      contentType: undefined,
    };
    expect(inferred(inferResponse(probe)).response.stream?.format).toBe('sse');
  });

  it('stops when no event carries prose, naming the events it saw', () => {
    expect(
      inferResponse(
        sse([
          ['ping', {}],
          ['done', { ok: true }],
        ]),
      ),
    ).toEqual({
      ok: false,
      problem: 'no event of the stream carries text that reads like an answer',
      shape: 'ping, done',
    });
  });
});

describe('inferSessionId', () => {
  it('finds a session id by the name of its key', () => {
    expect(inferSessionId(JSON.stringify({ session_id: 'abc' }))).toEqual({
      from: '$.session_id',
      sample: 'abc',
    });
    expect(inferSessionId(JSON.stringify({ data: { sessionId: 7 } }))).toEqual({
      from: '$.data.sessionId',
      sample: '7',
    });
    expect(inferSessionId(JSON.stringify({ id: 'x' }))).toBe(undefined);
    expect(inferSessionId('not json')).toBe(undefined);
  });
});

describe('shapeOf', () => {
  it('shows keys and types, never values, to a limited depth', () => {
    expect(shapeOf({ a: 'secret', b: [1, 2], c: { d: { e: { f: 1 } } } })).toBe(
      '{ a: string, b: [number, …], c: { d: { e: {…} } } }',
    );
    expect(shapeOf([])).toBe('[]');
    expect(shapeOf(null)).toBe('null');
  });
});
