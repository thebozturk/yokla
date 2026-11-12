// Reads the model and token usage from a provider response body, JSON or a
// server-sent event stream, for OpenAI-compatible and Anthropic APIs
// (ADR-0012). A token kind the provider didn't report is null, never 0.

import type { ProxyUsage } from '@yokla/core';

export type UpstreamKind = 'openai-compatible' | 'anthropic';

export const UNMEASURED: ProxyUsage = {
  input: null,
  output: null,
  cachedInput: null,
  cacheWrite: null,
  reasoning: null,
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function at(value: unknown, ...path: string[]): unknown {
  let current = value;
  for (const key of path) {
    if (!isObject(current)) return undefined;
    current = current[key];
  }
  return current;
}

function tokens(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/** Chat completions and embeddings (prompt_tokens), or the Responses API (input_tokens). */
function openAiUsage(usage: unknown, embeddings: boolean): ProxyUsage | undefined {
  if (!isObject(usage)) return undefined;
  if ('prompt_tokens' in usage) {
    return {
      input: tokens(usage['prompt_tokens']),
      // An embedding has no output tokens: zero is a measurement, not a guess.
      output: embeddings ? 0 : tokens(usage['completion_tokens']),
      cachedInput: tokens(at(usage, 'prompt_tokens_details', 'cached_tokens')),
      cacheWrite: null,
      reasoning: embeddings
        ? 0
        : tokens(at(usage, 'completion_tokens_details', 'reasoning_tokens')),
    };
  }
  if ('input_tokens' in usage) {
    return {
      input: tokens(usage['input_tokens']),
      output: tokens(usage['output_tokens']),
      cachedInput: tokens(at(usage, 'input_tokens_details', 'cached_tokens')),
      cacheWrite: null,
      reasoning: tokens(at(usage, 'output_tokens_details', 'reasoning_tokens')),
    };
  }
  return undefined;
}

/** Anthropic counts cache reads and writes apart from input_tokens; input here is their sum. */
function anthropicUsage(usage: unknown): ProxyUsage | undefined {
  if (!isObject(usage)) return undefined;
  const plain = tokens(usage['input_tokens']);
  const read = tokens(usage['cache_read_input_tokens']);
  const write = tokens(usage['cache_creation_input_tokens']);
  return {
    input: plain === null ? null : plain + (read ?? 0) + (write ?? 0),
    output: tokens(usage['output_tokens']),
    cachedInput: read,
    cacheWrite: write,
    reasoning: null,
  };
}

function isEmbeddings(body: unknown): boolean {
  const data = at(body, 'data');
  return (
    at(body, 'object') === 'list' &&
    Array.isArray(data) &&
    data.every((item) => at(item, 'object') === 'embedding')
  );
}

/** The JSON payloads of a server-sent event stream, in order; [DONE] and broken events skipped. */
export function sseEvents(body: string): unknown[] {
  const events: unknown[] = [];
  for (const block of body.split(/\r?\n\r?\n/u)) {
    const data = block
      .split(/\r?\n/u)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /u, ''))
      .join('\n');
    if (data === '' || data === '[DONE]') continue;
    try {
      events.push(JSON.parse(data));
    } catch {
      // Not JSON: nothing to read from this event.
    }
  }
  return events;
}

export interface ReadUsage {
  readonly usage: ProxyUsage;
  readonly model: string | null;
}

function fromJson(kind: UpstreamKind, body: unknown): ReadUsage {
  const usage =
    kind === 'anthropic'
      ? anthropicUsage(at(body, 'usage'))
      : openAiUsage(at(body, 'usage'), isEmbeddings(body));
  return { usage: usage ?? UNMEASURED, model: text(at(body, 'model')) };
}

const ANTHROPIC_COUNTS = [
  'input_tokens',
  'output_tokens',
  'cache_read_input_tokens',
  'cache_creation_input_tokens',
] as const;

/**
 * The counts of an Anthropic stream are cumulative totals. A count in a later event
 * replaces the earlier one, and a count the later event leaves out keeps its earlier
 * value. message_start may report zero input and message_delta the real input and cache
 * counts, so reading only the delta's output would undercount.
 */
function anthropicStream(events: readonly unknown[]): ReadUsage {
  let model: string | null = null;
  let counts: Record<string, number> | undefined;
  for (const event of events) {
    const type = at(event, 'type');
    let usage: unknown;
    if (type === 'message_start') {
      model = text(at(event, 'message', 'model')) ?? model;
      usage = at(event, 'message', 'usage');
    } else if (type === 'message_delta') {
      usage = at(event, 'usage');
    }
    if (!isObject(usage)) continue;
    counts = { ...counts };
    for (const key of ANTHROPIC_COUNTS) {
      const count = tokens(usage[key]);
      if (count !== null) counts[key] = count;
    }
  }
  return { usage: anthropicUsage(counts) ?? UNMEASURED, model };
}

function fromStream(kind: UpstreamKind, events: readonly unknown[]): ReadUsage {
  if (kind === 'anthropic') return anthropicStream(events);
  let model: string | null = null;
  let usage: ProxyUsage | undefined;
  for (const event of events) {
    const type = at(event, 'type');
    if (typeof type === 'string' && type.startsWith('response.')) {
      model = text(at(event, 'response', 'model')) ?? model;
      usage = openAiUsage(at(event, 'response', 'usage'), false) ?? usage;
      continue;
    }
    model = text(at(event, 'model')) ?? model;
    usage = openAiUsage(at(event, 'usage'), false) ?? usage;
  }
  return { usage: usage ?? UNMEASURED, model };
}

/** Usage and model from a response body; unmeasured when the body doesn't say. */
export function readUsage(kind: UpstreamKind, body: string, stream: boolean): ReadUsage {
  if (stream) return fromStream(kind, sseEvents(body));
  try {
    return fromJson(kind, JSON.parse(body));
  } catch {
    return { usage: UNMEASURED, model: null };
  }
}
