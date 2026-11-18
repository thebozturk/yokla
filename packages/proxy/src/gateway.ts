// The AI SDK gateway protocol (ADR-0069): one endpoint for every model,
// `POST <base>/language-model`, the model in the `ai-language-model-id`
// header and streaming in `ai-language-model-streaming`. The body is the
// SDK's own call: `prompt` messages with system, user, assistant and tool
// roles, and `tools`. A plain answer is the SDK's result, with `content`
// parts and `usage`; a streamed one is server-sent events of its stream
// parts, ending in a `finish` part with the usage. Only specification
// version 4 is read. A count the answer doesn't give is null.

import type { PromptMessage, ProxyUsage } from '@yokla/core';

/** The specification version the proxy reads; a call of another is recorded unmeasured. */
export const GATEWAY_SPECIFICATION = '4';

/** The header that names the model, which a swap rewrites (ADR-0042). */
export const GATEWAY_MODEL_HEADER = 'ai-language-model-id';

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function at(value: unknown, ...path: string[]): unknown {
  let current = value;
  for (const key of path) current = isObject(current) ? current[key] : undefined;
  return current;
}

function tokens(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function header(headers: Readonly<Record<string, unknown>>, name: string): string | undefined {
  const value = headers[name];
  return typeof value === 'string' ? value : Array.isArray(value) ? str(value[0]) : undefined;
}

/**
 * What a call's path and headers say: the model, whether it streams, and
 * whether the proxy reads it at all: a language model call of the version it
 * knows.
 */
export function gatewayFacts(
  path: string,
  headers: Readonly<Record<string, unknown>>,
): { model: string | null; stream: boolean; readable: boolean } {
  return {
    model: header(headers, GATEWAY_MODEL_HEADER) ?? null,
    stream: header(headers, 'ai-language-model-streaming') === 'true',
    readable:
      (path.split('?')[0] ?? '').endsWith('/language-model') &&
      header(headers, 'ai-language-model-specification-version') === GATEWAY_SPECIFICATION,
  };
}

/** The answers in a body: the one JSON result, or a stream's parts. Undefined when unreadable. */
export function gatewayAnswers(
  body: string,
  stream: boolean,
  sse: (text: string) => unknown[],
): unknown[] | undefined {
  if (stream) {
    const parts = sse(body);
    return parts.length === 0 ? undefined : parts;
  }
  try {
    const value: unknown = JSON.parse(body);
    return isObject(value) ? [value] : undefined;
  } catch {
    return undefined;
  }
}

/** The SDK's usage as yokla counts it: input is the total, cache reads and writes within it. */
function usageOf(usage: unknown): ProxyUsage | undefined {
  if (!isObject(usage)) return undefined;
  return {
    input: tokens(at(usage, 'inputTokens', 'total')),
    output: tokens(at(usage, 'outputTokens', 'total')),
    cachedInput: tokens(at(usage, 'inputTokens', 'cacheRead')),
    cacheWrite: tokens(at(usage, 'inputTokens', 'cacheWrite')),
    reasoning: tokens(at(usage, 'outputTokens', 'reasoning')),
  };
}

/** The usage and model of the answers: a result's, or a stream's finish and metadata parts. */
export function gatewayUsage(answers: readonly unknown[]): {
  usage: ProxyUsage | undefined;
  model: string | null;
} {
  let usage: ProxyUsage | undefined;
  let model: string | null = null;
  for (const answer of answers) {
    // Only a result and a stream's finish part carry usage.
    const type = at(answer, 'type');
    usage = usageOf(at(answer, 'usage')) ?? usage;
    const named =
      type === 'response-metadata' ? at(answer, 'modelId') : at(answer, 'response', 'modelId');
    if (typeof named === 'string' && named !== '') model = named;
  }
  return { usage, model };
}

/** The parts of the answers: a result's content, or a stream's parts as they came. */
function answerParts(answers: readonly unknown[]): unknown[] {
  return answers.flatMap((answer) =>
    at(answer, 'type') === undefined ? list(at(answer, 'content')) : [answer],
  );
}

/** The tool calls the answers ask for: their tool-call parts, input as JSON text. */
export function gatewayToolCalls(
  answers: readonly unknown[],
): { name: string; arguments: string }[] {
  return answerParts(answers).flatMap((part) => {
    const name = str(at(part, 'toolName'));
    if (at(part, 'type') !== 'tool-call' || name === undefined) return [];
    const input = at(part, 'input');
    return [{ name, arguments: typeof input === 'string' ? input : JSON.stringify(input ?? {}) }];
  });
}

/** The text the answers give: a result's text parts, or a stream's text deltas. */
export function gatewayText(answers: readonly unknown[]): string {
  return answerParts(answers)
    .flatMap((part) => {
      const type = at(part, 'type');
      const text =
        type === 'text'
          ? str(at(part, 'text'))
          : type === 'text-delta'
            ? str(at(part, 'delta'))
            : undefined;
      return text === undefined ? [] : [text];
    })
    .join('');
}

/** The names of the tools a request offers: a function's name, a provider tool's name or id. */
export function gatewayOffered(tools: unknown): string[] {
  return list(tools).flatMap((tool) => {
    const name = str(at(tool, 'name')) ?? str(at(tool, 'id'));
    return name === undefined ? [] : [name];
  });
}

function message(role: PromptMessage['role'], text: string, tool?: string): PromptMessage {
  return { role, chars: text.length, text, ...(tool === undefined ? {} : { tool }) };
}

/** A tool result's output as text: its text, or its JSON as JSON text. */
function outputText(output: unknown): string {
  const value = at(output, 'value');
  if (typeof value === 'string') return value;
  if (value !== undefined) return JSON.stringify(value);
  return str(at(output, 'reason')) ?? '';
}

/**
 * The messages a request sends: each of `prompt`. A system message is the
 * system prompt; an assistant's tool call is its message's text; a
 * tool-result part is a tool message that names its tool (ADR-0026). Null
 * for a shape it doesn't know.
 */
export function gatewayPrompt(body: Record<string, unknown>): PromptMessage[] | null {
  const prompt = body['prompt'];
  if (!Array.isArray(prompt)) return null;
  const out: PromptMessage[] = [];
  for (const entry of prompt) {
    if (!isObject(entry)) throw new Error('a message that is not an object');
    const role = entry['role'];
    if (role === 'system') {
      out.push(message('system', str(entry['content']) ?? ''));
      continue;
    }
    if (role !== 'user' && role !== 'assistant' && role !== 'tool') {
      throw new Error('a message of an unknown role');
    }
    const own: string[] = [];
    const results: PromptMessage[] = [];
    for (const part of list(entry['content'])) {
      if (!isObject(part)) throw new Error('a part that is not an object');
      if (part['type'] === 'text' && typeof part['text'] === 'string') own.push(part['text']);
      else if (part['type'] === 'tool-call') {
        const input = part['input'];
        own.push(typeof input === 'string' ? input : JSON.stringify(input ?? {}));
      } else if (part['type'] === 'tool-result') {
        results.push(message('tool', outputText(part['output']), str(part['toolName'])));
      }
    }
    if (own.length > 0 || results.length === 0) {
      out.push(message(role === 'tool' ? 'tool' : role, own.join('\n')));
    }
    out.push(...results);
  }
  return out;
}

/** The gateway's error body, as it answers a failed call. */
export function gatewayError(status: 429 | 500 | 503, said: string): string {
  const type =
    status === 429
      ? 'rate_limit_exceeded'
      : status === 503
        ? 'service_unavailable'
        : 'internal_server_error';
  return JSON.stringify({ error: { message: said, type } });
}

/** The text holders of one result or stream part: text parts' text, text deltas' delta. */
export function gatewayTextSlots(value: unknown): [Record<string, unknown>, string][] {
  if (!isObject(value)) return [];
  if (value['type'] === 'text-delta' && typeof value['delta'] === 'string')
    return [[value, 'delta']];
  if (value['type'] !== undefined) return [];
  return list(value['content']).flatMap((part): [Record<string, unknown>, string][] =>
    isObject(part) && part['type'] === 'text' && typeof part['text'] === 'string'
      ? [[part, 'text']]
      : [],
  );
}

/** Turns each tool call's input into text that isn't a JSON object; true when there was one. */
export function gatewayBreakToolCalls(answer: unknown, broken: string): boolean {
  let changed = false;
  for (const part of list(at(answer, 'content'))) {
    if (isObject(part) && part['type'] === 'tool-call') {
      part['input'] = broken;
      changed = true;
    }
  }
  return changed;
}

/** A tool result of a request: its tool and its output, text or JSON (ADR-0043). */
export interface GatewayResult {
  readonly tool: string;
  readonly output: Record<string, unknown>;
}

/** Every tool-result part a request sends, in any message, with the tool it names. */
export function gatewayResults(body: Record<string, unknown>): GatewayResult[] {
  return list(body['prompt']).flatMap((entry) =>
    list(at(entry, 'content')).flatMap((part): GatewayResult[] => {
      const tool = str(at(part, 'toolName'));
      const output = at(part, 'output');
      return at(part, 'type') === 'tool-result' && tool !== undefined && isObject(output)
        ? [{ tool, output }]
        : [];
    }),
  );
}
