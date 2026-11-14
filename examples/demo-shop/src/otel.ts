// The demo-shop's own OpenTelemetry export (ADR-0029): a span for each model
// call over HTTP, by the GenAI conventions, sent to an OTLP/HTTP endpoint as
// JSON or protobuf. A span continues the trace of the request that caused the
// call, from its W3C traceparent; without one it starts a trace of its own.
// Spans go out in batches, as SDK exporters send them, and a batch that can't
// be sent is dropped, as theirs are. It needs no dependency, and it is written
// apart from yokla's reader, so each checks the other.

import { randomBytes } from 'node:crypto';

export type OtelProtocol = 'json' | 'protobuf';

export function parseOtelProtocol(value: string): OtelProtocol | undefined {
  return value === 'json' || value === 'protobuf' ? value : undefined;
}

/** String attributes, and integer ones, such as token counts. */
export type AttributeValue = string | number;

export interface FinishedSpan {
  /** Hex, as W3C trace context writes it. */
  readonly traceId: string;
  readonly spanId: string;
  /** The span of the request that caused this one, from its traceparent. */
  readonly parentSpanId: string | undefined;
  readonly name: string;
  /** Nanoseconds since the epoch. */
  readonly startNs: bigint;
  readonly endNs: bigint;
  readonly attributes: Readonly<Record<string, AttributeValue>>;
  /** Set when the call failed: the span's status is then ERROR. */
  readonly error: string | undefined;
}

/** Token counts as the provider reported them; a count it didn't give is undefined. */
export interface TokenUsage {
  readonly input: number | undefined;
  readonly output: number | undefined;
  readonly cacheRead: number | undefined;
}

/** How a chat call ended: what the provider answered, or why it failed. */
export type ChatEnd =
  { readonly model: string | undefined; readonly usage: TokenUsage } | { readonly error: string };

/** Starts a span for a chat call; the function it returns ends it. */
export interface ChatSpans {
  chat(model: string, traceparent: string | undefined): (end: ChatEnd) => void;
}

const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/u;
const SPAN_KIND_CLIENT = 3;
const STATUS_ERROR = 2;

/** The trace and span a W3C traceparent names; undefined when it isn't a valid one. */
export function parentOf(
  traceparent: string | undefined,
): { readonly traceId: string; readonly spanId: string } | undefined {
  const match = TRACEPARENT.exec(traceparent ?? '');
  const [, traceId, spanId] = match ?? [];
  if (traceId === undefined || spanId === undefined) return undefined;
  // All-zero ids are invalid in W3C trace context.
  if (/^0+$/u.test(traceId) || /^0+$/u.test(spanId)) return undefined;
  return { traceId, spanId };
}

/** Now, in nanoseconds since the epoch, finer than Date.now(). */
function nowNs(): bigint {
  return (
    BigInt(Math.round(performance.timeOrigin * 1_000)) * 1_000n +
    BigInt(Math.round(performance.now() * 1_000_000))
  );
}

const SERVICE = 'demo-shop';

function jsonValue(value: AttributeValue): Record<string, string> {
  // OTLP JSON writes 64-bit integers as strings.
  return typeof value === 'string' ? { stringValue: value } : { intValue: String(value) };
}

/** An OTLP/HTTP JSON export of the spans. */
export function otlpJson(spans: readonly FinishedSpan[]): unknown {
  return {
    resourceSpans: [
      {
        resource: { attributes: [{ key: 'service.name', value: { stringValue: SERVICE } }] },
        scopeSpans: [
          {
            scope: { name: SERVICE },
            spans: spans.map((span) => ({
              traceId: span.traceId,
              spanId: span.spanId,
              ...(span.parentSpanId === undefined ? {} : { parentSpanId: span.parentSpanId }),
              name: span.name,
              kind: SPAN_KIND_CLIENT,
              startTimeUnixNano: String(span.startNs),
              endTimeUnixNano: String(span.endNs),
              attributes: Object.entries(span.attributes).map(([key, value]) => ({
                key,
                value: jsonValue(value),
              })),
              status: span.error === undefined ? {} : { code: STATUS_ERROR, message: span.error },
            })),
          },
        ],
      },
    ],
  };
}

/** The protobuf wire format, as far as an OTLP trace export needs it. */
class ProtoWriter {
  readonly #parts: Buffer[] = [];

  #varint(value: bigint): void {
    const bytes: number[] = [];
    let rest = BigInt.asUintN(64, value);
    do {
      const low = Number(rest & 0x7fn);
      rest >>= 7n;
      bytes.push(rest === 0n ? low : low | 0x80);
    } while (rest !== 0n);
    this.#parts.push(Buffer.from(bytes));
  }

  #tag(field: number, type: number): void {
    this.#varint(BigInt((field << 3) | type));
  }

  int(field: number, value: number): this {
    this.#tag(field, 0);
    this.#varint(BigInt(value));
    return this;
  }

  fixed64(field: number, value: bigint): this {
    this.#tag(field, 1);
    const bytes = Buffer.alloc(8);
    bytes.writeBigUInt64LE(value);
    this.#parts.push(bytes);
    return this;
  }

  bytes(field: number, value: Uint8Array): this {
    this.#tag(field, 2);
    this.#varint(BigInt(value.length));
    this.#parts.push(Buffer.from(value));
    return this;
  }

  string(field: number, value: string): this {
    return this.bytes(field, Buffer.from(value, 'utf8'));
  }

  message(field: number, write: (inner: ProtoWriter) => void): this {
    const inner = new ProtoWriter();
    write(inner);
    return this.bytes(field, inner.finish());
  }

  finish(): Buffer {
    return Buffer.concat(this.#parts);
  }
}

function protoAttribute(writer: ProtoWriter, field: number, key: string, value: AttributeValue) {
  writer.message(field, (pair) => {
    pair.string(1, key).message(2, (any) => {
      if (typeof value === 'string') any.string(1, value);
      else any.int(3, value);
    });
  });
}

/** An OTLP/HTTP protobuf export of the spans: an ExportTraceServiceRequest. */
export function otlpProtobuf(spans: readonly FinishedSpan[]): Buffer {
  return new ProtoWriter()
    .message(1, (resourceSpans) => {
      resourceSpans.message(1, (resource) => {
        protoAttribute(resource, 1, 'service.name', SERVICE);
      });
      resourceSpans.message(2, (scopeSpans) => {
        scopeSpans.message(1, (scope) => scope.string(1, SERVICE));
        for (const span of spans) {
          scopeSpans.message(2, (out) => {
            out
              .bytes(1, Buffer.from(span.traceId, 'hex'))
              .bytes(2, Buffer.from(span.spanId, 'hex'));
            if (span.parentSpanId !== undefined) {
              out.bytes(4, Buffer.from(span.parentSpanId, 'hex'));
            }
            out
              .string(5, span.name)
              .int(6, SPAN_KIND_CLIENT)
              .fixed64(7, span.startNs)
              .fixed64(8, span.endNs);
            for (const [key, value] of Object.entries(span.attributes)) {
              protoAttribute(out, 9, key, value);
            }
            const { error } = span;
            if (error !== undefined) {
              out.message(15, (status) => status.string(2, error).int(3, STATUS_ERROR));
            }
          });
        }
      });
    })
    .finish();
}

export interface SpanExporterOptions {
  /** The OTLP/HTTP traces endpoint, e.g. http://127.0.0.1:8787/_yokla/otlp/v1/traces. */
  readonly url: string;
  readonly protocol: OtelProtocol;
  /** How long a span waits before its batch goes out, as OTEL_BSP_SCHEDULE_DELAY sets it. */
  readonly delayMs: number;
}

/** GenAI spans for the demo-shop's model calls, exported in batches. */
export class SpanExporter implements ChatSpans {
  readonly #options: SpanExporterOptions;
  readonly #pending: FinishedSpan[] = [];
  #timer: NodeJS.Timeout | undefined;
  readonly #sending = new Set<Promise<void>>();

  constructor(options: SpanExporterOptions) {
    this.#options = options;
  }

  chat(model: string, traceparent: string | undefined): (end: ChatEnd) => void {
    const parent = parentOf(traceparent);
    const traceId = parent?.traceId ?? randomBytes(16).toString('hex');
    const spanId = randomBytes(8).toString('hex');
    const startNs = nowNs();
    return (end) => {
      const attributes: Record<string, AttributeValue> = {
        'gen_ai.operation.name': 'chat',
        // An OpenAI-compatible API, as the instrumentation of its client names it.
        'gen_ai.provider.name': 'openai',
        'gen_ai.request.model': model,
      };
      if ('error' in end) {
        attributes['error.type'] = end.error;
      } else {
        if (end.model !== undefined) attributes['gen_ai.response.model'] = end.model;
        const { input, output, cacheRead } = end.usage;
        if (input !== undefined) attributes['gen_ai.usage.input_tokens'] = input;
        if (output !== undefined) attributes['gen_ai.usage.output_tokens'] = output;
        if (cacheRead !== undefined) attributes['gen_ai.usage.cache_read.input_tokens'] = cacheRead;
      }
      this.#add({
        traceId,
        spanId,
        parentSpanId: parent?.spanId,
        name: `chat ${model}`,
        startNs,
        endNs: nowNs(),
        attributes,
        error: 'error' in end ? end.error : undefined,
      });
    };
  }

  #add(span: FinishedSpan): void {
    this.#pending.push(span);
    if (this.#timer !== undefined) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.flush();
    }, this.#options.delayMs);
    // A waiting batch doesn't keep the process alive; shutting down flushes it.
    this.#timer.unref();
  }

  /** Sends the spans not yet sent, and waits for every batch on its way. */
  async flush(): Promise<void> {
    clearTimeout(this.#timer);
    this.#timer = undefined;
    const batch = this.#pending.splice(0);
    if (batch.length > 0) {
      const sent = this.#send(batch).finally(() => this.#sending.delete(sent));
      this.#sending.add(sent);
    }
    await Promise.all(this.#sending);
  }

  async #send(batch: readonly FinishedSpan[]): Promise<void> {
    const json = this.#options.protocol === 'json';
    try {
      const response = await fetch(this.#options.url, {
        method: 'POST',
        headers: { 'content-type': json ? 'application/json' : 'application/x-protobuf' },
        body: json ? JSON.stringify(otlpJson(batch)) : otlpProtobuf(batch),
        signal: AbortSignal.timeout(5_000),
      });
      await response.body?.cancel();
    } catch {
      // Dropped, as an SDK exporter drops a batch it can't send.
    }
  }
}
