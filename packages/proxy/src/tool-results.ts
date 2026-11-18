// Changes to the tool results a call sends, before the model sees them
// (ADR-0043): text injected into a tool's results, or the arrays a path
// selects in them reversed. A result is found where ADR-0026 reads it, and
// named by its call's id in the same request, in every protocol the proxy
// speaks. A text result is read as JSON as ADR-0026 reads it: its whole text,
// or else the text from its first `{` to its last `}`.

import { updateJsonPath, type ToolResultChange } from '@yokla/core';
import { gatewayResults } from './gateway.ts';
import type { UpstreamKind } from './usage.ts';

export type ToolChange =
  | {
      readonly kind: 'inject';
      readonly tool: string;
      readonly at?: string | undefined;
      readonly inject: string;
    }
  | { readonly kind: 'reverse'; readonly tool: string; readonly at: string };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * A tool result where it sits in the request: as text, as a Gemini object,
 * or as the JSON value of a gateway output (ADR-0069).
 */
type Holder =
  | { readonly tool: string; readonly get: () => string; readonly set: (text: string) => void }
  | { readonly tool: string; readonly object: Record<string, unknown> }
  | { readonly tool: string; readonly json: Record<string, unknown> };

/**
 * A content field as one text: a string, or a list with one text part. Any
 * other shape can't be changed as one text, and is left out.
 */
function textHolder(tool: string, owner: Record<string, unknown>, key: string): Holder[] {
  const content = owner[key];
  if (typeof content === 'string') {
    return [{ tool, get: () => content, set: (text) => (owner[key] = text) }];
  }
  const texts = list(content).filter(
    (part): part is Record<string, unknown> => isObject(part) && typeof part['text'] === 'string',
  );
  const [only] = texts;
  if (texts.length !== 1 || only === undefined) return [];
  return [{ tool, get: () => String(only['text']), set: (text) => (only['text'] = text) }];
}

/** Every tool result of a request body, with the tool it answers. */
function holders(kind: UpstreamKind, body: Record<string, unknown>): Holder[] {
  const found: Holder[] = [];
  const tools = new Map<string, string>();
  if (kind === 'gemini') {
    for (const content of list(body['contents'])) {
      for (const part of list(isObject(content) ? content['parts'] : undefined)) {
        const response = isObject(part) ? part['functionResponse'] : undefined;
        if (isObject(response) && isObject(response['response'])) {
          const name = str(response['name']);
          if (name !== undefined) found.push({ tool: name, object: response['response'] });
        }
      }
    }
    return found;
  }
  if (kind === 'ai-gateway') {
    // A text output changes as text; a JSON one only by a path; any other is left.
    for (const { tool, output } of gatewayResults(body)) {
      if (output['type'] === 'text') found.push(...textHolder(tool, output, 'value'));
      else if (output['type'] === 'json') found.push({ tool, json: output });
    }
    return found;
  }
  if (kind === 'anthropic') {
    for (const message of list(body['messages'])) {
      for (const block of list(isObject(message) ? message['content'] : undefined)) {
        if (!isObject(block)) continue;
        if (block['type'] === 'tool_use') {
          const id = str(block['id']);
          const name = str(block['name']);
          if (id !== undefined && name !== undefined) tools.set(id, name);
        } else if (block['type'] === 'tool_result') {
          const name = tools.get(str(block['tool_use_id']) ?? '');
          if (name !== undefined) found.push(...textHolder(name, block, 'content'));
        }
      }
    }
    return found;
  }
  // Chat completions: messages; the Responses API: input items.
  for (const message of list(body['messages'])) {
    if (!isObject(message)) continue;
    for (const call of list(message['tool_calls'])) {
      const fn = isObject(call) ? call['function'] : undefined;
      const id = isObject(call) ? str(call['id']) : undefined;
      const name = isObject(fn) ? str(fn['name']) : undefined;
      if (id !== undefined && name !== undefined) tools.set(id, name);
    }
    const name =
      message['role'] === 'tool'
        ? tools.get(str(message['tool_call_id']) ?? '')
        : message['role'] === 'function'
          ? str(message['name'])
          : undefined;
    if (name !== undefined) found.push(...textHolder(name, message, 'content'));
  }
  for (const item of list(body['input'])) {
    if (!isObject(item)) continue;
    if (item['type'] === 'function_call') {
      const id = str(item['call_id']);
      const name = str(item['name']);
      if (id !== undefined && name !== undefined) tools.set(id, name);
    } else if (item['type'] === 'function_call_output') {
      const name = tools.get(str(item['call_id']) ?? '');
      if (name !== undefined) found.push(...textHolder(name, item, 'output'));
    }
  }
  return found;
}

/** What a change makes of a value the path selects; undefined leaves it. */
function updateOf(change: ToolChange): (value: unknown) => unknown {
  return change.kind === 'inject'
    ? (value) => (typeof value === 'string' ? `${value}${change.inject}` : undefined)
    : (value) => (Array.isArray(value) ? value.toReversed() : undefined);
}

/** Applies a path change to a JSON value; the root itself only when it is reversed. */
function changeValue(change: ToolChange, at: string, value: unknown): unknown {
  if (at === '$') return updateOf(change)(value);
  return updateJsonPath(value, at, updateOf(change)) > 0 ? value : undefined;
}

/** A text result changed by a path, or undefined when it isn't JSON or nothing changed. */
function changeText(change: ToolChange, at: string, text: string): string | undefined {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  const readings: [string, string, string][] = [['', text, '']];
  if (start !== -1 && end > start) {
    readings.push([text.slice(0, start), text.slice(start, end + 1), text.slice(end + 1)]);
  }
  for (const [before, json, after] of readings) {
    let value: unknown;
    try {
      value = JSON.parse(json);
    } catch {
      continue;
    }
    const next = changeValue(change, at, value);
    return next === undefined ? undefined : `${before}${JSON.stringify(next)}${after}`;
  }
  return undefined;
}

/** Applies one change to one tool result; whether it changed anything. */
function apply(change: ToolChange, holder: Holder): boolean {
  if ('json' in holder) {
    if (change.at === undefined) return false;
    const next = changeValue(change, change.at, holder.json['value']);
    if (next === undefined) return false;
    holder.json['value'] = next;
    return true;
  }
  if ('object' in holder) {
    // A Gemini result is an object: only a path into it can change it, never its root.
    if (change.at === undefined) return false;
    return updateJsonPath(holder.object, change.at, updateOf(change)) > 0;
  }
  const text = holder.get();
  const next =
    change.kind === 'inject' && change.at === undefined
      ? `${text}\n${change.inject}`
      : changeText(change, change.at ?? '$', text);
  if (next === undefined) return false;
  holder.set(next);
  return true;
}

/**
 * Applies the changes to the tool results of a parsed request body, in place,
 * and says what each did to each result of its tool: applied, or not. A
 * change whose tool the call sends no result of leaves no entry.
 */
export function changeToolResults(
  kind: UpstreamKind,
  body: unknown,
  changes: readonly ToolChange[],
): ToolResultChange[] {
  if (!isObject(body) || changes.length === 0) return [];
  const results = holders(kind, body);
  return changes.flatMap((change) =>
    results
      .filter((holder) => holder.tool === change.tool)
      .map((holder) => ({ kind: change.kind, tool: change.tool, applied: apply(change, holder) })),
  );
}
