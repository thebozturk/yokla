// A model call from an OpenTelemetry span (ADR-0029): a span with
// gen_ai.operation.name, read by the GenAI conventions. Only the provider, the
// model, the token counts, the duration and whether it failed are read; message
// contents, in attributes or events, never are. The conventions are still
// being settled, so older names are read where newer ones are absent. A count
// the span doesn't give is null, never 0.

import type { SpanCall } from '../schema/proxy.ts';
import type { AttributeValue, OtlpSpan } from './otlp.ts';

function text(value: AttributeValue | undefined): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function count(value: AttributeValue | undefined): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

/** The first of these attributes the span has. */
function first<T>(
  span: OtlpSpan,
  names: readonly string[],
  read: (value: AttributeValue | undefined) => T | null,
): T | null {
  for (const name of names) {
    const value = read(span.attributes.get(name));
    if (value !== null) return value;
  }
  return null;
}

export function modelCallOf(span: OtlpSpan): SpanCall | undefined {
  if (!span.attributes.has('gen_ai.operation.name')) return undefined;
  const durationNs = span.endNs > span.startNs ? span.endNs - span.startNs : 0n;
  return {
    traceId: span.traceId,
    spanId: span.spanId,
    provider: first(span, ['gen_ai.provider.name', 'gen_ai.system'], text),
    model: first(span, ['gen_ai.response.model', 'gen_ai.request.model'], text),
    startedAt: new Date(Number(span.startNs / 1_000_000n)).toISOString(),
    durationMs: Math.round(Number(durationNs) / 10_000) / 100,
    usage: {
      input: first(span, ['gen_ai.usage.input_tokens', 'gen_ai.usage.prompt_tokens'], count),
      output: first(span, ['gen_ai.usage.output_tokens', 'gen_ai.usage.completion_tokens'], count),
      cachedInput: first(
        span,
        ['gen_ai.usage.cache_read.input_tokens', 'gen_ai.usage.cache_read_input_tokens'],
        count,
      ),
      cacheWrite: first(
        span,
        ['gen_ai.usage.cache_creation.input_tokens', 'gen_ai.usage.cache_creation_input_tokens'],
        count,
      ),
      reasoning: first(span, ['gen_ai.usage.reasoning.output_tokens'], count),
    },
    error: span.error || span.attributes.has('error.type'),
  };
}
