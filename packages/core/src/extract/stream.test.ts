import { describe, expect, it } from 'vitest';
import type { MessageStream, ResponseStream } from '../schema/profile.ts';
import {
  eventName,
  messageEvents,
  parseStream,
  readEvents,
  readStream,
  type StreamChunk,
} from './stream.ts';

const at = (atMs: number, text: string): StreamChunk => ({ atMs, text });
const one = (text: string): StreamChunk[] => [at(5, text)];

describe('parseStream for server-sent events', () => {
  it('reads named events, JSON data, and joins data lines with line breaks', () => {
    const body = [
      ': a comment',
      'event: text_delta',
      'data: {"text":"Mer"}',
      '',
      'id: 7',
      'retry: 100',
      'data:first',
      'data:  second ',
      '',
      'event: done',
      'data',
      '',
      '',
    ].join('\n');
    expect(parseStream(one(body), 'sse')).toEqual([
      { field: 'text_delta', data: { text: 'Mer' }, atMs: 5 },
      // Only the one space after the colon goes.
      { field: undefined, data: 'first\n second ', atMs: 5 },
      { field: 'done', data: '', atMs: 5 },
    ]);
  });

  it('skips an event without data, and resets the event name after each event', () => {
    const body = 'event: ping\n\ndata: 1\n\n';
    expect(parseStream(one(body), 'sse')).toEqual([{ field: undefined, data: 1, atMs: 5 }]);
  });

  it('reads CRLF and CR line ends, also when a chunk splits them', () => {
    expect(
      parseStream(one('data: 1\r\n\r\ndata: 2\r\rdata: 3\n\n'), 'sse').map((e) => e.data),
    ).toEqual([1, 2, 3]);
    const split = [at(1, 'data: {"a"'), at(2, ':1}\r'), at(3, '\n\r'), at(4, '\ndata: 2\n\n')];
    expect(parseStream(split, 'sse')).toEqual([
      { field: undefined, data: { a: 1 }, atMs: 4 },
      { field: undefined, data: 2, atMs: 4 },
    ]);
  });

  it('keeps a CR that ends a chunk, so a CR line end there still counts', () => {
    const chunks = [at(1, 'data: 1\r'), at(2, '\rdata: 2\r'), at(3, '\n\n')];
    expect(parseStream(chunks, 'sse')).toEqual([
      { field: undefined, data: 1, atMs: 2 },
      { field: undefined, data: 2, atMs: 3 },
    ]);
  });

  it('dates each event by the chunk that completed it, and drops one cut off', () => {
    const chunks = [at(10, 'data: 1\n'), at(20, '\ndata: 2\n\n'), at(30, 'data: 3\n')];
    expect(parseStream(chunks, 'sse')).toEqual([
      { field: undefined, data: 1, atMs: 20 },
      { field: undefined, data: 2, atMs: 20 },
    ]);
  });
});

describe('parseStream for newline-delimited JSON', () => {
  it('reads one value per line, a last line without a line break too', () => {
    const chunks = [at(1, '{"type":"a"}\r\n\n{"ty'), at(2, 'pe":"b"}\nnot json\r\n'), at(3, '[1]')];
    expect(parseStream(chunks, 'ndjson')).toEqual([
      { field: undefined, data: { type: 'a' }, atMs: 1 },
      { field: undefined, data: { type: 'b' }, atMs: 2 },
      { field: undefined, data: 'not json', atMs: 2 },
      { field: undefined, data: [1], atMs: 3 },
    ]);
    expect(parseStream([], 'ndjson')).toEqual([]);
  });
});

const SPEC: ResponseStream = {
  format: 'sse',
  text: { event: 'text_delta', from: '$.text' },
};

const sse = (...events: [string | undefined, unknown][]) =>
  events
    .map(
      ([event, data]) =>
        `${event === undefined ? '' : `event: ${event}\n`}data: ${JSON.stringify(data)}\n\n`,
    )
    .join('');

describe('readStream', () => {
  it('joins the text pieces in order, and keeps every event, all and last per name', () => {
    const chunks = [
      // An empty piece is no text yet: the first text comes at 7, not 3.
      at(3, sse(['ui', { products: [1] }], ['text_delta', { text: '' }])),
      at(7, sse(['text_delta', { text: 'Mer' }])),
      at(
        9,
        sse(
          ['text_delta', { text: 7 }],
          ['text_delta', { text: 'haba' }],
          ['ui', { products: [2] }],
        ),
      ),
    ];
    expect(readStream(chunks, SPEC)).toEqual({
      document: {
        text: 'Merhaba',
        events: [
          { event: 'ui', data: { products: [1] } },
          { event: 'text_delta', data: { text: '' } },
          { event: 'text_delta', data: { text: 'Mer' } },
          { event: 'text_delta', data: { text: 7 } },
          { event: 'text_delta', data: { text: 'haba' } },
          { event: 'ui', data: { products: [2] } },
        ],
        all: {
          ui: [{ products: [1] }, { products: [2] }],
          text_delta: [{ text: '' }, { text: 'Mer' }, { text: 7 }, { text: 'haba' }],
        },
        last: { ui: { products: [2] }, text_delta: { text: 'haba' } },
      },
      firstTextMs: 7,
      problem: undefined,
    });
  });

  it('names events by a path in their data when asked, else by the SSE field, else message', () => {
    const typed: ResponseStream = {
      format: 'ndjson',
      event: '$.type',
      text: { event: 'content', from: '$.payload' },
    };
    const lines = ['{"type":"content","payload":"Hi"}', '{"type":3}', '{"payload":"x"}'].join('\n');
    const read = readStream(one(lines), typed);
    expect(read.document).toMatchObject({
      text: 'Hi',
      last: { content: { payload: 'Hi' }, message: { payload: 'x' } },
    });
    // With a path, the path names the event, even over an SSE event field.
    const typedSse = { ...typed, format: 'sse' as const };
    expect(readStream(one(sse(['foo', { x: 1 }])), typedSse).document).toMatchObject({
      last: { message: { x: 1 } },
    });
    expect(readStream(one(sse([undefined, { text: 'x' }])), SPEC).document).toMatchObject({
      text: '',
      last: { message: { text: 'x' } },
    });
    const plain = { ...SPEC, text: { event: 'message', from: '$.choices[0].delta.content' } };
    const chat = sse(
      [undefined, { choices: [{ delta: { content: 'Sel' } }] }],
      [undefined, { choices: [{ delta: { content: 'am' } }] }],
    );
    expect(readStream(one(`${chat}data: [DONE]\n\n`), plain)).toMatchObject({
      document: { text: 'Selam', last: { message: '[DONE]' } },
      firstTextMs: 5,
    });
  });

  it('calls an answer without its done event incomplete', () => {
    const done = { ...SPEC, done: 'turn_complete' };
    expect(readStream(one(sse(['text_delta', { text: 'a' }])), done).problem).toBe(
      'the stream ended before its "turn_complete" event',
    );
    expect(readStream(one(sse(['turn_complete', {}])), done).problem).toBeUndefined();
    expect(readStream([], SPEC)).toEqual({
      document: { text: '', events: [], all: {}, last: {} },
      firstTextMs: undefined,
      problem: undefined,
    });
  });

  it('reports an error event with its message, before a missing done event', () => {
    const spec = { ...SPEC, done: 'turn_complete', error: { event: 'error', from: '$.message' } };
    const failed = one(
      sse(['text_delta', { text: 'a' }], ['error', { message: 'model overloaded' }]),
    );
    expect(readStream(failed, spec).problem).toBe('the stream reported an error: model overloaded');
    expect(readStream(one(sse(['error', { code: 5 }])), spec).problem).toBe(
      'the stream reported an error: {"code":5}',
    );
    const pathless = { ...SPEC, error: { event: 'error' } };
    expect(readStream(one(sse(['error', 'boom'])), pathless).problem).toBe(
      'the stream reported an error: "boom"',
    );
    expect(readStream(one(sse(['text_delta', { text: 'a' }])), pathless).problem).toBeUndefined();
  });

  it('keeps an event named like an object key as plain data', () => {
    const read = readStream(one(sse(['__proto__', { polluted: true }])), SPEC);
    const document = read.document;
    const last =
      typeof document === 'object' && document !== null && !Array.isArray(document)
        ? document['last']
        : undefined;
    expect(
      typeof last === 'object' && last !== null && !Array.isArray(last) ? Object.keys(last) : [],
    ).toEqual(['__proto__']);
    expect(Reflect.get({}, 'polluted')).toBeUndefined();
  });
});

describe('WebSocket messages (ADR-0024)', () => {
  const spec: MessageStream = {
    event: '$.type',
    text: { event: 'delta', from: '$.text' },
    done: 'end',
    error: { event: 'error', from: '$.message' },
  };

  it('reads each message as one event, JSON or text, multi-line or not', () => {
    const messages = [
      at(3, '{"type":"delta","text":"Mer"}'),
      at(4, '{\n  "type": "delta",\n  "text": "haba"\n}'),
      at(9, 'not json\nat all'),
      at(12, '{"type":"end"}'),
    ];
    expect(messageEvents(messages)).toEqual([
      { field: undefined, data: { type: 'delta', text: 'Mer' }, atMs: 3 },
      { field: undefined, data: { type: 'delta', text: 'haba' }, atMs: 4 },
      { field: undefined, data: 'not json\nat all', atMs: 9 },
      { field: undefined, data: { type: 'end' }, atMs: 12 },
    ]);
    const read = readEvents(messageEvents(messages), spec);
    expect(read.firstTextMs).toBe(3);
    expect(read.problem).toBeUndefined();
    expect(read.document).toMatchObject({
      text: 'Merhaba',
      last: { end: { type: 'end' }, message: 'not json\nat all' },
    });
  });

  it('names events by the path, or message without one', () => {
    expect(eventName({ field: undefined, data: { type: 'end' } }, spec)).toBe('end');
    expect(eventName({ field: undefined, data: { kind: 'end' } }, spec)).toBe('message');
    expect(eventName({ field: undefined, data: 'end' }, spec)).toBe('message');
    const unnamed = { ...spec, event: undefined };
    expect(eventName({ field: undefined, data: { type: 'end' } }, unnamed)).toBe('message');
    // An answer in one message: its event is done.
    const single = { text: { event: 'message', from: '$.text' }, done: 'message' };
    const read = readEvents(messageEvents([at(7, '{"text":"Selam"}')]), single);
    expect(read.document).toMatchObject({ text: 'Selam' });
    expect(read.problem).toBeUndefined();
  });

  it('reports a missing done event and an error event as it does for a stream', () => {
    const cut = readEvents(messageEvents([at(1, '{"type":"delta","text":"a"}')]), spec);
    expect(cut.problem).toBe('the stream ended before its "end" event');
    const failed = readEvents(messageEvents([at(1, '{"type":"error","message":"busy"}')]), spec);
    expect(failed.problem).toBe('the stream reported an error: busy');
  });
});
