import { describe, expect, it } from 'vitest';
import { buildSchemas } from '../schema/build.ts';
import { modelCallOf } from './genai.ts';
import { readOtlpJson, readOtlpProtobuf, type OtlpSpan } from './otlp.ts';

const TRACE = '0af7651916cd43dd8448eb211c80319c';
const SPAN = 'b7ad6b7169203331';

/** A protobuf writer for the tests, written apart from the reader. */
const pb = {
  varint(value: bigint | number): number[] {
    let rest = BigInt(value);
    const out: number[] = [];
    do {
      let byte = Number(rest & 0x7fn);
      rest >>= 7n;
      if (rest > 0n) byte |= 0x80;
      out.push(byte);
    } while (rest > 0n);
    return out;
  },
  key: (field: number, type: number) => pb.varint((field << 3) | type),
  len: (field: number, bytes: number[]) => [
    ...pb.key(field, 2),
    ...pb.varint(bytes.length),
    ...bytes,
  ],
  str: (field: number, value: string) => pb.len(field, pb.utf8(value)),
  /** UTF-8 bytes, written out: core's tests have no TextEncoder either. */
  utf8(value: string): number[] {
    const out: number[] = [];
    for (const char of value) {
      const code = char.codePointAt(0) ?? 0;
      if (code < 0x80) out.push(code);
      else if (code < 0x800) out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
      else if (code < 0x10000)
        out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
      else
        out.push(
          0xf0 | (code >> 18),
          0x80 | ((code >> 12) & 0x3f),
          0x80 | ((code >> 6) & 0x3f),
          0x80 | (code & 0x3f),
        );
    }
    return out;
  },
  hex: (field: number, value: string) =>
    pb.len(field, value.match(/../gu)?.map((pair) => Number.parseInt(pair, 16)) ?? []),
  fixed64(field: number, value: bigint): number[] {
    const out = [...pb.key(field, 1)];
    for (let i = 0n; i < 8n; i += 1n) out.push(Number((value >> (8n * i)) & 0xffn));
    return out;
  },
  double(field: number, value: number): number[] {
    const view = new DataView(new ArrayBuffer(8));
    view.setFloat64(0, value, true);
    return [...pb.key(field, 1), ...new Uint8Array(view.buffer)];
  },
  attr(key: string, value: string | number | boolean): number[] {
    const any =
      typeof value === 'string'
        ? pb.str(1, value)
        : typeof value === 'boolean'
          ? [...pb.key(2, 0), ...pb.varint(value ? 1 : 0)]
          : Number.isInteger(value)
            ? [...pb.key(3, 0), ...pb.varint(BigInt.asUintN(64, BigInt(value)))]
            : pb.double(4, value);
    return pb.len(9, [...pb.str(1, key), ...pb.len(2, any)]);
  },
};

const ATTRS = {
  'gen_ai.operation.name': 'chat',
  'gen_ai.provider.name': 'openai',
  'gen_ai.request.model': 'gpt-x',
  'gen_ai.response.model': 'gpt-x-2026',
  'gen_ai.usage.input_tokens': 1200,
  'gen_ai.usage.output_tokens': 80,
  'gen_ai.usage.cache_read.input_tokens': 1000,
  'gen_ai.request.temperature': 0.25,
  'gen_ai.input.messages': 'SECRET PROMPT',
  stream: true,
};

/** An export with one span with these attributes, in protobuf; unknown fields mixed in. */
function protobufExport(
  attributes: Record<string, string | number | boolean>,
  error = false,
): Uint8Array {
  const span = [
    ...pb.hex(1, TRACE),
    ...pb.hex(2, SPAN),
    ...pb.str(3, 'trace state, ignored'),
    ...pb.str(5, 'chat gpt-x'),
    ...pb.key(6, 0),
    ...pb.varint(3),
    ...pb.fixed64(7, 1_763_000_000_000_000_000n),
    ...pb.fixed64(8, 1_763_000_000_812_400_000n),
    ...Object.entries(attributes).flatMap(([key, value]) => pb.attr(key, value)),
    ...(error ? pb.len(15, [...pb.str(2, 'boom'), ...pb.key(3, 0), ...pb.varint(2)]) : []),
    ...pb.key(16, 5),
    1,
    0,
    0,
    0,
  ];
  const scope = [...pb.len(1, pb.str(1, 'openai-instrumentation')), ...pb.len(2, span)];
  const resource = [...pb.len(1, pb.attr('service.name', 'shop')), ...pb.len(2, scope)];
  return new Uint8Array(pb.len(1, resource));
}

const jsonExport = (attributes: Record<string, unknown>[], status?: unknown) => ({
  resourceSpans: [
    {
      resource: { attributes: [{ key: 'service.name', value: { stringValue: 'shop' } }] },
      scopeSpans: [
        {
          scope: { name: 'x' },
          spans: [
            {
              traceId: TRACE.toUpperCase(),
              spanId: SPAN,
              name: 'chat gpt-x',
              startTimeUnixNano: '1763000000000000000',
              // OTLP JSON writes 64-bit integers as text: a JSON number would lose digits.
              endTimeUnixNano: '1763000000812400000',
              attributes,
              ...(status === undefined ? {} : { status }),
            },
          ],
        },
      ],
    },
  ],
});

describe('readOtlpJson (ADR-0029)', () => {
  it('reads ids, name, times, status and scalar attributes', () => {
    const [span] =
      readOtlpJson(
        jsonExport(
          [
            { key: 'gen_ai.operation.name', value: { stringValue: 'chat' } },
            { key: 'gen_ai.usage.input_tokens', value: { intValue: '1200' } },
            { key: 'gen_ai.usage.output_tokens', value: { intValue: 80 } },
            { key: 'gen_ai.request.temperature', value: { doubleValue: 0.25 } },
            { key: 'stream', value: { boolValue: true } },
            { key: 'list', value: { arrayValue: { values: [] } } },
          ],
          { code: 'STATUS_CODE_ERROR' },
        ),
      ) ?? [];
    expect(span).toMatchObject({ traceId: TRACE, spanId: SPAN, name: 'chat gpt-x', error: true });
    expect(span?.endNs).toBe(1_763_000_000_812_400_000n);
    expect(Object.fromEntries(span?.attributes ?? [])).toEqual({
      'gen_ai.operation.name': 'chat',
      'gen_ai.usage.input_tokens': 1200,
      'gen_ai.usage.output_tokens': 80,
      'gen_ai.request.temperature': 0.25,
      stream: true,
    });
    expect(readOtlpJson(jsonExport([], { code: 2 }))?.[0]?.error).toBe(true);
    expect(readOtlpJson(jsonExport([], { code: 1 }))?.[0]?.error).toBe(false);
  });

  it('gives undefined for anything else', () => {
    expect(readOtlpJson({ resourceLogs: [] })).toBeUndefined();
    expect(readOtlpJson('x')).toBeUndefined();
    expect(readOtlpJson({ resourceSpans: [] })).toEqual([]);
  });
});

describe('readOtlpProtobuf (ADR-0029)', () => {
  it('reads the same span from protobuf, skipping fields it needs not', () => {
    const [span] = readOtlpProtobuf(protobufExport(ATTRS, true)) ?? [];
    expect(span).toMatchObject({
      traceId: TRACE,
      spanId: SPAN,
      name: 'chat gpt-x',
      startNs: 1_763_000_000_000_000_000n,
      endNs: 1_763_000_000_812_400_000n,
      error: true,
    });
    expect(Object.fromEntries(span?.attributes ?? [])).toEqual(ATTRS);
    expect(readOtlpProtobuf(protobufExport(ATTRS))?.[0]?.error).toBe(false);
  });

  it('decodes UTF-8 text, and a broken sequence as a replacement', () => {
    const [span] = readOtlpProtobuf(protobufExport({ 'gen_ai.operation.name': 'çay ☕ 𝄞' })) ?? [];
    expect(span?.attributes.get('gen_ai.operation.name')).toBe('çay ☕ 𝄞');
    const broken = new Uint8Array(pb.len(1, pb.len(2, pb.len(2, pb.len(5, [0x61, 0xff, 0x62])))));
    expect(readOtlpProtobuf(broken)?.[0]?.name).toBe('a�b');
  });

  it('gives undefined for bytes that are not a whole message', () => {
    const whole = protobufExport(ATTRS);
    expect(readOtlpProtobuf(whole.subarray(0, whole.length - 3))).toBeUndefined();
    expect(readOtlpProtobuf(new Uint8Array([0xff, 0xff, 0xff]))).toBeUndefined();
    expect(readOtlpProtobuf(new Uint8Array())).toEqual([]);
  });
});

const spanWith = (
  attributes: Record<string, string | number | boolean>,
  error = false,
): OtlpSpan => ({
  traceId: TRACE,
  spanId: SPAN,
  name: 'x',
  startNs: 1_763_000_000_000_000_000n,
  endNs: 1_763_000_000_812_400_000n,
  error,
  attributes: new Map(Object.entries(attributes)),
});

describe('modelCallOf (ADR-0029)', () => {
  it('reads a GenAI span as a model call, never its message contents', () => {
    const call = modelCallOf(spanWith(ATTRS));
    expect(call).toEqual({
      traceId: TRACE,
      spanId: SPAN,
      provider: 'openai',
      model: 'gpt-x-2026',
      startedAt: '2025-11-13T02:13:20.000Z',
      durationMs: 812.4,
      usage: { input: 1200, output: 80, cachedInput: 1000, cacheWrite: null, reasoning: null },
      error: false,
    });
    expect(JSON.stringify(call)).not.toContain('SECRET');
  });

  it('reads older names where newer ones are absent, and counts it gives not as null', () => {
    const call = modelCallOf(
      spanWith({
        'gen_ai.operation.name': 'chat',
        'gen_ai.system': 'anthropic',
        'gen_ai.request.model': 'claude-x',
        'gen_ai.usage.prompt_tokens': 10,
        'gen_ai.usage.completion_tokens': 2,
        'gen_ai.usage.cache_read_input_tokens': 4,
        'gen_ai.usage.cache_creation_input_tokens': 3,
      }),
    );
    expect(call).toMatchObject({
      provider: 'anthropic',
      model: 'claude-x',
      usage: { input: 10, output: 2, cachedInput: 4, cacheWrite: 3, reasoning: null },
    });
    expect(
      modelCallOf(spanWith({ 'gen_ai.operation.name': 'chat', 'gen_ai.usage.input_tokens': -1 }))
        ?.usage.input,
    ).toBeNull();
    expect(
      modelCallOf(spanWith({ 'gen_ai.operation.name': 'chat', 'gen_ai.usage.input_tokens': 1.5 }))
        ?.usage.input,
    ).toBeNull();
  });

  it('marks a failed call, and is no model call without gen_ai.operation.name', () => {
    expect(modelCallOf(spanWith({ 'gen_ai.operation.name': 'chat' }, true))?.error).toBe(true);
    expect(
      modelCallOf(spanWith({ 'gen_ai.operation.name': 'chat', 'error.type': 'timeout' }))?.error,
    ).toBe(true);
    expect(
      modelCallOf(spanWith({ 'http.method': 'POST', 'gen_ai.request.model': 'm' })),
    ).toBeUndefined();
  });
});

describe('modelProxy.spans (ADR-0029)', () => {
  const { profile } = buildSchemas({ languages: ['tr'], domainPacks: [{ id: 'shop' }] });
  const base = {
    version: 1,
    languages: ['tr'],
    domain: 'shop',
    target: {
      name: 't',
      request: { url: 'http://127.0.0.1:3000/chat', body: { message: '{{message}}' } },
      response: { text: '$.answer' },
    },
  };
  const issues = (modelProxy: unknown, target: Record<string, unknown> = {}) =>
    profile
      .safeParse({ ...base, target: { ...base.target, ...target }, modelProxy })
      .error?.issues.map((issue) => [issue.path.join('.'), issue.message]);

  it('lets spans stand alone, with defaults, and needs an upstream without them', () => {
    const parsed = profile.parse({ ...base, modelProxy: { upstreams: [], spans: {} } });
    expect(parsed.modelProxy?.spans).toEqual({ quietMs: 6_000, maxWaitMs: 20_000 });
    expect(issues({ upstreams: [] })).toEqual([
      [
        'modelProxy.upstreams',
        'the model proxy needs an upstream, or spans to read model calls from',
      ],
    ]);
  });

  it('refuses spans on a WebSocket target, which sends headers once', () => {
    const socket = {
      adapter: 'websocket',
      request: { url: 'ws://127.0.0.1:3000/ws', body: { text: '{{message}}' } },
      response: {
        stream: { text: { event: 'delta', from: '$.text' }, done: 'end' },
        text: '$.text',
      },
    };
    expect(issues({ upstreams: [], spans: {} }, socket)?.[0]?.[0]).toBe('modelProxy.spans');
  });
});
