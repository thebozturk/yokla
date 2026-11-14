// Reads tool use from provider calls (ADR-0025): the tools a request offers,
// and the tool calls the model's answer asks for, in order, for
// OpenAI-compatible chat completions, the Responses API and Anthropic
// Messages, from a JSON answer or an event stream. Arguments are kept as the
// text the model sent; a streamed call's pieces are joined. A body the proxy
// can't read gives null, never an empty list, so a check that needs it says it
// couldn't measure. A call that got no answer asked for nothing.

import { sseEvents, type UpstreamKind } from './usage.ts';

export interface AskedTool {
  readonly name: string;
  readonly arguments: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function at(value: unknown, ...path: (string | number)[]): unknown {
  let current = value;
  for (const key of path) {
    if (typeof key === 'number') current = Array.isArray(current) ? current[key] : undefined;
    else current = isObject(current) ? current[key] : undefined;
  }
  return current;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** A tool's name: its function's name, its own, or for a built-in tool its type. */
function toolName(tool: unknown): string | undefined {
  return str(at(tool, 'function', 'name')) ?? str(at(tool, 'name')) ?? str(at(tool, 'type'));
}

/**
 * The names of the tools a request offers; [] when it offers none, null when
 * the body can't be read.
 */
export function readOffered(body: string | undefined): string[] | null {
  if (body === undefined) return null;
  if (body.trim() === '') return [];
  try {
    const value: unknown = JSON.parse(body);
    if (!isObject(value)) return null;
    const tools = [...list(value['tools']), ...list(value['functions'])];
    return tools.map(toolName).filter((name): name is string => name !== undefined);
  } catch {
    return null;
  }
}

/** Chat completions: the message's tool_calls, and a legacy function_call. */
function chatMessage(message: unknown): AskedTool[] {
  const calls = [...list(at(message, 'tool_calls')), { function: at(message, 'function_call') }];
  return calls.flatMap((call) => {
    const name = str(at(call, 'function', 'name'));
    return name === undefined
      ? []
      : [{ name, arguments: str(at(call, 'function', 'arguments')) ?? '' }];
  });
}

/** The Responses API: its function_call output items. */
function responseOutput(output: unknown): AskedTool[] {
  return list(output).flatMap((item) => {
    const name = str(at(item, 'name'));
    return at(item, 'type') === 'function_call' && name !== undefined
      ? [{ name, arguments: str(at(item, 'arguments')) ?? '' }]
      : [];
  });
}

/** Anthropic: the tool_use blocks, their input as JSON text. */
function anthropicContent(content: unknown): AskedTool[] {
  return list(content).flatMap((block) => {
    const name = str(at(block, 'name'));
    return at(block, 'type') === 'tool_use' && name !== undefined
      ? [{ name, arguments: JSON.stringify(at(block, 'input') ?? {}) }]
      : [];
  });
}

function fromJson(kind: UpstreamKind, body: unknown): AskedTool[] | null {
  if (!isObject(body)) return null;
  if (kind === 'anthropic') return 'content' in body ? anthropicContent(body['content']) : null;
  if ('choices' in body) return chatMessage(at(body, 'choices', 0, 'message'));
  if ('output' in body) return responseOutput(body['output']);
  // Embeddings ask for no tools.
  if (at(body, 'object') === 'list') return [];
  return null;
}

/**
 * Pieces of streamed calls, by their index, joined in index order. A call
 * with no argument pieces keeps the arguments it started with, if any.
 */
class Pieces {
  readonly #calls = new Map<number, { name: string; args: string[]; start: string }>();

  add(index: number, name: string | undefined, args: string | undefined, start = ''): void {
    const call = this.#calls.get(index) ?? { name: '', args: [], start };
    if (name !== undefined && name !== '') call.name = name;
    if (args !== undefined) call.args.push(args);
    this.#calls.set(index, call);
  }

  done(): AskedTool[] {
    return [...this.#calls.entries()]
      .toSorted(([a], [b]) => a - b)
      .filter(([, call]) => call.name !== '')
      .map(([, call]) => ({
        name: call.name,
        arguments: call.args.length === 0 ? call.start : call.args.join(''),
      }));
  }
}

function openAiStream(events: readonly unknown[]): AskedTool[] {
  const pieces = new Pieces();
  let responses: AskedTool[] | undefined;
  for (const event of events) {
    const type = str(at(event, 'type'));
    if (type === 'response.completed') {
      responses = responseOutput(at(event, 'response', 'output'));
      continue;
    }
    const delta = at(event, 'choices', 0, 'delta');
    for (const call of list(at(delta, 'tool_calls'))) {
      const index = at(call, 'index');
      pieces.add(
        typeof index === 'number' ? index : 0,
        str(at(call, 'function', 'name')),
        str(at(call, 'function', 'arguments')),
      );
    }
    const legacy = at(delta, 'function_call');
    if (isObject(legacy)) pieces.add(-1, str(legacy['name']), str(legacy['arguments']));
  }
  return responses ?? pieces.done();
}

function anthropicStream(events: readonly unknown[]): AskedTool[] {
  const pieces = new Pieces();
  for (const event of events) {
    const type = at(event, 'type');
    const index = at(event, 'index');
    if (typeof index !== 'number') continue;
    if (type === 'content_block_start' && at(event, 'content_block', 'type') === 'tool_use') {
      const input = at(event, 'content_block', 'input');
      pieces.add(
        index,
        str(at(event, 'content_block', 'name')),
        undefined,
        JSON.stringify(input ?? {}),
      );
    } else if (
      type === 'content_block_delta' &&
      at(event, 'delta', 'type') === 'input_json_delta'
    ) {
      pieces.add(index, undefined, str(at(event, 'delta', 'partial_json')));
    }
  }
  return pieces.done();
}

/**
 * The tool calls an answer asks for, in order; null when the answer can't be
 * read. A call that got no answer, or an error, asked for none.
 */
export function readToolCalls(
  kind: UpstreamKind,
  body: string | undefined,
  stream: boolean,
  status: number | null,
): AskedTool[] | null {
  if (status === null || status < 200 || status > 299) return [];
  if (body === undefined) return null;
  if (stream) {
    const events = sseEvents(body);
    if (events.length === 0) return null;
    return kind === 'anthropic' ? anthropicStream(events) : openAiStream(events);
  }
  try {
    return fromJson(kind, JSON.parse(body));
  } catch {
    return null;
  }
}
