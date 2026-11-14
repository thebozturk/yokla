import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { Assistant } from './assistant.ts';
import { loadShopData } from './catalog.ts';
import { createFakeProvider, type UsageEntry } from './fake-provider.ts';
import { ScriptedModel, type ChatModel, type ModelCall } from './model.ts';
import {
  otlpJson,
  otlpProtobuf,
  parentOf,
  parseOtelProtocol,
  SpanExporter,
  type ChatEnd,
  type ChatSpans,
  type FinishedSpan,
} from './otel.ts';
import { RemoteModel } from './remote-model.ts';
import { createDemoShopServer } from './server.ts';

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => {
            resolve();
          });
        }),
    ),
  );
});

async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (typeof address !== 'object' || address === null) throw new Error('no address');
  return `http://127.0.0.1:${String(address.port)}`;
}

const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
const PARENT = '00f067aa0ba902b7';
const TRACEPARENT = `00-${TRACE}-${PARENT}-01`;

const SPAN: FinishedSpan = {
  traceId: TRACE,
  spanId: 'a1b2c3d4e5f60718',
  parentSpanId: PARENT,
  name: 'chat demo-writer-1',
  startNs: 1_763_000_000_123_456_789n,
  endNs: 1_763_000_000_223_456_789n,
  attributes: {
    'gen_ai.operation.name': 'chat',
    'gen_ai.usage.input_tokens': 300,
  },
  error: undefined,
};

describe('trace context', () => {
  it('reads the trace and parent span of a W3C traceparent', () => {
    expect(parentOf(TRACEPARENT)).toEqual({ traceId: TRACE, spanId: PARENT });
    expect(parentOf(`00-${TRACE}-${PARENT}-00`)).toEqual({ traceId: TRACE, spanId: PARENT });
  });

  it.each([
    ['no header', undefined],
    ['another version', `01-${TRACE}-${PARENT}-01`],
    ['upper case', `00-${TRACE.toUpperCase()}-${PARENT}-01`],
    ['a short trace id', `00-${TRACE.slice(1)}-${PARENT}-01`],
    ['an all-zero trace id', `00-${'0'.repeat(32)}-${PARENT}-01`],
    ['an all-zero span id', `00-${TRACE}-${'0'.repeat(16)}-01`],
    ['trailing text', `${TRACEPARENT}-x`],
  ])('refuses %s', (_name, header) => {
    expect(parentOf(header)).toBeUndefined();
  });

  it('knows the two protocols', () => {
    expect(parseOtelProtocol('json')).toBe('json');
    expect(parseOtelProtocol('protobuf')).toBe('protobuf');
    expect(parseOtelProtocol('grpc')).toBeUndefined();
  });
});

describe('OTLP JSON', () => {
  it('writes a span with hex ids, nanoseconds and 64-bit integers as strings', () => {
    expect(otlpJson([SPAN, { ...SPAN, parentSpanId: undefined, error: '503' }])).toEqual({
      resourceSpans: [
        {
          resource: { attributes: [{ key: 'service.name', value: { stringValue: 'demo-shop' } }] },
          scopeSpans: [
            {
              scope: { name: 'demo-shop' },
              spans: [
                {
                  traceId: TRACE,
                  spanId: 'a1b2c3d4e5f60718',
                  parentSpanId: PARENT,
                  name: 'chat demo-writer-1',
                  kind: 3,
                  startTimeUnixNano: '1763000000123456789',
                  endTimeUnixNano: '1763000000223456789',
                  attributes: [
                    { key: 'gen_ai.operation.name', value: { stringValue: 'chat' } },
                    { key: 'gen_ai.usage.input_tokens', value: { intValue: '300' } },
                  ],
                  status: {},
                },
                {
                  traceId: TRACE,
                  spanId: 'a1b2c3d4e5f60718',
                  name: 'chat demo-writer-1',
                  kind: 3,
                  startTimeUnixNano: '1763000000123456789',
                  endTimeUnixNano: '1763000000223456789',
                  attributes: [
                    { key: 'gen_ai.operation.name', value: { stringValue: 'chat' } },
                    { key: 'gen_ai.usage.input_tokens', value: { intValue: '300' } },
                  ],
                  status: { code: 2, message: '503' },
                },
              ],
            },
          ],
        },
      ],
    });
  });
});

/** A protobuf message, field by field: varints as bigints, everything else as bytes. */
type Fields = Map<number, (bigint | Buffer)[]>;

/** Reads protobuf wire format, with no knowledge of the messages: a check apart from the writer. */
function decode(bytes: Buffer): Fields {
  const fields: Fields = new Map();
  let at = 0;
  const varint = (): bigint => {
    let result = 0n;
    for (let shift = 0n; ; shift += 7n) {
      const byte = bytes[at];
      if (byte === undefined) throw new Error('a varint runs past the end');
      at += 1;
      result |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return result;
    }
  };
  while (at < bytes.length) {
    const key = Number(varint());
    const type = key & 7;
    let value: bigint | Buffer;
    if (type === 0) value = varint();
    else if (type === 1) {
      value = bytes.subarray(at, at + 8);
      at += 8;
    } else if (type === 2) {
      const length = Number(varint());
      value = bytes.subarray(at, at + length);
      at += length;
    } else throw new Error(`unexpected wire type ${String(type)}`);
    if (at > bytes.length) throw new Error('a field runs past the end');
    const list = fields.get(key >> 3) ?? [];
    list.push(value);
    fields.set(key >> 3, list);
  }
  return fields;
}

function bytesOf(fields: Fields, field: number, index = 0): Buffer {
  const value = fields.get(field)?.[index];
  if (!Buffer.isBuffer(value)) throw new Error(`field ${String(field)} is not bytes`);
  return value;
}

function message(fields: Fields, field: number, index = 0): Fields {
  return decode(bytesOf(fields, field, index));
}

describe('OTLP protobuf', () => {
  it('writes an ExportTraceServiceRequest field by field', () => {
    const request = decode(
      otlpProtobuf([SPAN, { ...SPAN, parentSpanId: undefined, error: '503' }]),
    );
    expect([...request.keys()]).toEqual([1]);
    const resourceSpans = message(request, 1);
    const resource = message(resourceSpans, 1);
    const serviceName = message(resource, 1);
    expect(bytesOf(serviceName, 1).toString()).toBe('service.name');
    expect(bytesOf(message(serviceName, 2), 1).toString()).toBe('demo-shop');
    const scopeSpans = message(resourceSpans, 2);
    expect(bytesOf(message(scopeSpans, 1), 1).toString()).toBe('demo-shop');
    expect(scopeSpans.get(2)).toHaveLength(2);

    const span = message(scopeSpans, 2);
    expect([...span.keys()]).toEqual([1, 2, 4, 5, 6, 7, 8, 9]);
    expect(bytesOf(span, 1).toString('hex')).toBe(TRACE);
    expect(bytesOf(span, 2).toString('hex')).toBe('a1b2c3d4e5f60718');
    expect(bytesOf(span, 4).toString('hex')).toBe(PARENT);
    expect(bytesOf(span, 5).toString()).toBe('chat demo-writer-1');
    expect(span.get(6)).toEqual([3n]);
    expect(bytesOf(span, 7).readBigUInt64LE()).toBe(SPAN.startNs);
    expect(bytesOf(span, 8).readBigUInt64LE()).toBe(SPAN.endNs);
    const operation = message(span, 9, 0);
    expect(bytesOf(operation, 1).toString()).toBe('gen_ai.operation.name');
    expect(bytesOf(message(operation, 2), 1).toString()).toBe('chat');
    const tokens = message(span, 9, 1);
    expect(bytesOf(tokens, 1).toString()).toBe('gen_ai.usage.input_tokens');
    // An integer is AnyValue's int_value, field 3: 300 as the varint ac 02.
    expect(bytesOf(tokens, 2).toString('hex')).toBe('18ac02');

    const failed = message(scopeSpans, 2, 1);
    expect(failed.has(4)).toBe(false);
    const status = message(failed, 15);
    expect(bytesOf(status, 2).toString()).toBe('503');
    expect(status.get(3)).toEqual([2n]);
  });
});

interface Export {
  readonly headers: IncomingHttpHeaders;
  readonly body: Buffer;
}

/** An OTLP endpoint that keeps what it receives. */
async function collector(): Promise<{ url: string; exports: Export[] }> {
  const exports: Export[] = [];
  const url = await listen(
    createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        exports.push({ headers: request.headers, body: Buffer.concat(chunks) });
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{}');
      });
    }),
  );
  return { url: `${url}/v1/traces`, exports };
}

/** The value at a path of keys and indexes, or undefined. */
function valueAt(value: unknown, ...path: (string | number)[]): unknown {
  let current = value;
  for (const key of path) {
    if (typeof current !== 'object' || current === null) return undefined;
    current = Reflect.get(current, key);
  }
  return current;
}

/** The spans of an OTLP JSON export. */
function jsonSpans(body: Buffer): Record<string, unknown>[] {
  const value: unknown = JSON.parse(body.toString('utf8'));
  const spans = valueAt(value, 'resourceSpans', 0, 'scopeSpans', 0, 'spans');
  const list: unknown[] = Array.isArray(spans) ? spans : [];
  return list.map((span) =>
    Object.fromEntries(typeof span === 'object' && span !== null ? Object.entries(span) : []),
  );
}

const USAGE = { input: 120, output: 30, cacheRead: undefined };

describe('the span exporter', () => {
  it('sends the spans of a batch together, each continuing the trace it was given', async () => {
    const { url, exports } = await collector();
    const exporter = new SpanExporter({ url, protocol: 'json', delayMs: 60_000 });
    exporter.chat('demo-writer-1', TRACEPARENT)({ model: 'demo-writer-1b', usage: USAGE });
    exporter.chat('demo-writer-1', undefined)({ error: '429' });
    expect(exports).toEqual([]);
    await exporter.flush();
    expect(exports).toHaveLength(1);
    expect(exports[0]?.headers['content-type']).toBe('application/json');
    const [first, second] = jsonSpans(exports[0]?.body ?? Buffer.alloc(0));
    expect(first).toMatchObject({
      traceId: TRACE,
      parentSpanId: PARENT,
      name: 'chat demo-writer-1',
      kind: 3,
      status: {},
      attributes: [
        { key: 'gen_ai.operation.name', value: { stringValue: 'chat' } },
        { key: 'gen_ai.provider.name', value: { stringValue: 'openai' } },
        { key: 'gen_ai.request.model', value: { stringValue: 'demo-writer-1' } },
        { key: 'gen_ai.response.model', value: { stringValue: 'demo-writer-1b' } },
        { key: 'gen_ai.usage.input_tokens', value: { intValue: '120' } },
        { key: 'gen_ai.usage.output_tokens', value: { intValue: '30' } },
      ],
    });
    expect(first?.['spanId']).toMatch(/^[0-9a-f]{16}$/u);
    expect(BigInt(String(first?.['endTimeUnixNano']))).toBeGreaterThanOrEqual(
      BigInt(String(first?.['startTimeUnixNano'])),
    );
    // Without a traceparent, a trace of its own, with no parent.
    expect(second?.['traceId']).toMatch(/^[0-9a-f]{32}$/u);
    expect(second?.['traceId']).not.toBe(TRACE);
    expect(second).not.toHaveProperty('parentSpanId');
    expect(second).toMatchObject({
      status: { code: 2, message: '429' },
      attributes: [
        { key: 'gen_ai.operation.name', value: { stringValue: 'chat' } },
        { key: 'gen_ai.provider.name', value: { stringValue: 'openai' } },
        { key: 'gen_ai.request.model', value: { stringValue: 'demo-writer-1' } },
        { key: 'error.type', value: { stringValue: '429' } },
      ],
    });
    // Nothing left to send: no empty export.
    await exporter.flush();
    expect(exports).toHaveLength(1);
  });

  it('sends a batch once its delay has passed, in protobuf when asked', async () => {
    const { url, exports } = await collector();
    const exporter = new SpanExporter({ url, protocol: 'protobuf', delayMs: 20 });
    exporter.chat(
      'm',
      TRACEPARENT,
    )({
      model: undefined,
      usage: { input: 1, output: undefined, cacheRead: 7 },
    });
    exporter.chat('m', TRACEPARENT)({ model: undefined, usage: USAGE });
    for (let i = 0; i < 100 && exports.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(exports).toHaveLength(1);
    expect(exports[0]?.headers['content-type']).toBe('application/x-protobuf');
    const scopeSpans = message(message(decode(exports[0]?.body ?? Buffer.alloc(0)), 1), 2);
    expect(scopeSpans.get(2)).toHaveLength(2);
    const keys = (scopeSpans.get(9) ?? []).length;
    expect(keys).toBe(0);
    const span = message(scopeSpans, 2);
    const names = (span.get(9) ?? []).map((pair) =>
      Buffer.isBuffer(pair) ? bytesOf(decode(pair), 1).toString() : '',
    );
    // A count the provider didn't report is left out, never written as 0.
    expect(names).toEqual([
      'gen_ai.operation.name',
      'gen_ai.provider.name',
      'gen_ai.request.model',
      'gen_ai.usage.input_tokens',
      'gen_ai.usage.cache_read.input_tokens',
    ]);
  });

  it('sends on its schedule while spans keep coming, rather than waiting for a pause', async () => {
    const { url, exports } = await collector();
    const exporter = new SpanExporter({ url, protocol: 'json', delayMs: 50 });
    for (let i = 0; i < 12; i += 1) {
      exporter.chat('m', TRACEPARENT)({ model: undefined, usage: USAGE });
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(exports.length).toBeGreaterThan(0);
    await exporter.flush();
    expect(exports.flatMap((sent) => jsonSpans(sent.body))).toHaveLength(12);
  });

  it('drops a batch it cannot send', async () => {
    const exporter = new SpanExporter({
      url: 'http://127.0.0.1:9/v1/traces',
      protocol: 'json',
      delayMs: 60_000,
    });
    exporter.chat('m', undefined)({ error: 'x' });
    await expect(exporter.flush()).resolves.toBeUndefined();
  });
});

/** Spans as the model's requests end them, kept in order, and the providers they name. */
function recordSpans(): {
  spans: ChatSpans;
  ended: { model: string; traceparent: string | undefined; end: ChatEnd }[];
  providers: (string | undefined)[];
} {
  const ended: { model: string; traceparent: string | undefined; end: ChatEnd }[] = [];
  const providers: (string | undefined)[] = [];
  return {
    ended,
    providers,
    spans: {
      chat: (model, traceparent, provider) => (end) => {
        ended.push({ model, traceparent, end });
        providers.push(provider);
      },
    },
  };
}

const FALLBACK = { kind: 'fallback', language: 'tr' } as const;

describe('the demo-shop model over HTTP, with spans', () => {
  it.each([false, true])(
    'ends a span per request with the usage the provider reported (stream: %s)',
    async (stream) => {
      const usage: UsageEntry[] = [];
      const url = await listen(
        createFakeProvider({ key: 'k', onUsage: (entry) => usage.push(entry) }),
      );
      const { spans, ended } = recordSpans();
      const model = new RemoteModel({ url: `${url}/v1`, key: 'k', stream, spans });
      await model.write(FALLBACK, { traceparent: TRACEPARENT });
      await model.summarize('Bir\nİki');
      expect(ended).toEqual(
        usage.map((entry, index) => ({
          model: 'demo-writer-1',
          traceparent: index === 0 ? TRACEPARENT : undefined,
          end: {
            model: entry.model,
            usage: {
              input: entry.promptTokens,
              output: entry.completionTokens,
              cacheRead: undefined,
            },
          },
        })),
      );
      expect(ended).toHaveLength(2);
    },
  );

  it('names Gemini as the provider, and counts its thinking as output (ADR-0032)', async () => {
    const usage: UsageEntry[] = [];
    const url = await listen(
      createFakeProvider({ key: 'k', onUsage: (entry) => usage.push(entry) }),
    );
    const { spans, ended, providers } = recordSpans();
    const model = new RemoteModel({
      url: `${url}/v1beta`,
      key: 'k',
      protocol: 'gemini',
      model: 'gemini-demo-1',
      spans,
    });
    await model.write(FALLBACK);
    const [entry] = usage;
    expect(ended.map((span) => span.end)).toEqual([
      {
        model: 'gemini-demo-1',
        usage: {
          input: entry?.promptTokens,
          output: entry?.completionTokens,
          cacheRead: undefined,
        },
      },
    ]);
    expect(entry?.completionTokens).toBeGreaterThan(entry?.thoughtsTokens ?? 0);
    expect(providers).toEqual(['gcp.gemini']);
  });

  it('ends a span for a refused request and for its retry', async () => {
    let calls = 0;
    const url = await listen(
      createServer((request, response) => {
        calls += 1;
        request.resume();
        request.on('end', () => {
          if (calls === 1) {
            response.writeHead(429, { 'retry-after': '0' });
            response.end();
            return;
          }
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(
            JSON.stringify({
              model: 'm-1',
              choices: [{ message: { content: 'Merhaba' } }],
              usage: {
                prompt_tokens: 5,
                completion_tokens: 2,
                prompt_tokens_details: { cached_tokens: 4 },
              },
            }),
          );
        });
      }),
    );
    const { spans, ended } = recordSpans();
    expect(await new RemoteModel({ url, key: 'k', spans }).write(FALLBACK)).toBe('Merhaba');
    expect(ended.map((span) => span.end)).toEqual([
      { error: '429' },
      { model: 'm-1', usage: { input: 5, output: 2, cacheRead: 4 } },
    ]);
  });

  it('keeps the usage of an answer it cannot use, and names a failed request', async () => {
    let reply: unknown = { model: 'm-1', choices: [{ message: {} }], usage: { prompt_tokens: 5 } };
    const url = await listen(
      createServer((request, response) => {
        request.resume();
        request.on('end', () => {
          if (reply === undefined) return;
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify(reply));
        });
      }),
    );
    const { spans, ended } = recordSpans();
    const model = new RemoteModel({ url, key: 'k', spans, timeoutMs: 50 });
    await expect(model.write(FALLBACK)).rejects.toThrow('the model answered without content');
    reply = undefined;
    await expect(model.write(FALLBACK)).rejects.toThrow('aborted due to timeout');
    expect(ended.map((span) => span.end)).toEqual([
      { model: 'm-1', usage: { input: 5, output: undefined, cacheRead: undefined } },
      { error: 'TimeoutError' },
    ]);
  });
});

describe('the demo-shop server, with spans', () => {
  it('passes an incoming traceparent on to the model calls of the turn and its summary', async () => {
    const calls: { role: string; call: ModelCall | undefined }[] = [];
    const scripted = new ScriptedModel();
    const model: ChatModel = {
      interpret: (text, context, call) => {
        calls.push({ role: 'interpret', call });
        return scripted.interpret(text, context);
      },
      write: (draft, call) => {
        calls.push({ role: 'write', call });
        return scripted.write(draft);
      },
      summarize: (answer, call) => {
        calls.push({ role: 'summarize', call });
        return scripted.summarize(answer);
      },
    };
    const url = await listen(
      createDemoShopServer({
        assistant: new Assistant({ data: loadShopData(), model, defect: null }),
        rateLimit: false,
        summarizeAfterAnswer: true,
      }),
    );
    const response = await fetch(`${url}/v1/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', traceparent: TRACEPARENT },
      body: JSON.stringify({ message: 'Merhaba', sessionId: 's-1' }),
    });
    expect(response.status).toBe(200);
    for (let i = 0; i < 100 && calls.length < 3; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(calls.map(({ role, call }) => [role, call?.traceparent, call?.trace])).toEqual([
      ['interpret', TRACEPARENT, undefined],
      ['write', TRACEPARENT, undefined],
      ['summarize', TRACEPARENT, undefined],
    ]);
  });
});
