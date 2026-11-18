// Reads what a provider call sends to the model (ADR-0015): its messages, as
// role and text, for OpenAI-compatible chat completions, the Responses API and
// embeddings, and for Anthropic Messages. Only text is kept; images and other
// parts are left out. A body the proxy can't read gives null, never a shorter
// prompt, so a check that needs it says it couldn't measure. A tool result
// names the tool it answers, found by its call's id in the same request
// (ADR-0026).

import type { PromptMessage, PromptRole } from '@yokla/core';
import { gatewayPrompt } from './gateway.ts';
import { geminiPrompt } from './gemini.ts';
import type { UpstreamKind } from './usage.ts';

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

const TEXT_PARTS: ReadonlySet<unknown> = new Set(['text', 'input_text', 'output_text']);

/** The text of a content field: a string, or the text parts of a list, one per line. */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  const texts: string[] = [];
  for (const part of list(content)) {
    if (isObject(part) && TEXT_PARTS.has(part['type']) && typeof part['text'] === 'string') {
      texts.push(part['text']);
    }
  }
  return texts.join('\n');
}

function roleOf(role: unknown): PromptRole | undefined {
  switch (role) {
    case 'system':
    case 'developer':
      return 'system';
    case 'user':
      return 'user';
    case 'assistant':
      return 'assistant';
    case 'tool':
    case 'function':
      return 'tool';
    default:
      return undefined;
  }
}

function message(role: PromptRole | undefined, text: string, tool?: string): PromptMessage {
  if (role === undefined) throw new Error('a message with an unknown role');
  return { role, chars: text.length, text, ...(tool === undefined ? {} : { tool }) };
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function lines(...parts: readonly string[]): string {
  return parts.filter((part) => part !== '').join('\n');
}

/** Chat completions: `messages`, with tool-call arguments as the assistant's text. */
function chat(messages: readonly unknown[]): PromptMessage[] {
  // Tool call ids to tool names, from the assistant messages, for the results that follow.
  const tools = new Map<string, string>();
  return messages.map((entry) => {
    if (!isObject(entry)) throw new Error('a message that is not an object');
    const args: string[] = [];
    for (const call of [...list(entry['tool_calls']), { function: entry['function_call'] }]) {
      const fn = isObject(call) ? call['function'] : undefined;
      if (isObject(fn) && typeof fn['arguments'] === 'string') args.push(fn['arguments']);
      const id = isObject(call) ? str(call['id']) : undefined;
      const name = isObject(fn) ? str(fn['name']) : undefined;
      if (id !== undefined && name !== undefined) tools.set(id, name);
    }
    const role = roleOf(entry['role']);
    const callId = str(entry['tool_call_id']);
    // A legacy function message names its function itself.
    const tool =
      role !== 'tool' ? undefined : callId === undefined ? str(entry['name']) : tools.get(callId);
    return message(role, lines(textOf(entry['content']), ...args), tool);
  });
}

/** The Responses API: `instructions`, then `input` as a string or a list of items. */
function responses(body: Record<string, unknown>): PromptMessage[] {
  const out: PromptMessage[] = [];
  if (typeof body['instructions'] === 'string') out.push(message('system', body['instructions']));
  const input = body['input'];
  if (typeof input === 'string') return [...out, message('user', input)];
  if (input === undefined) return out;
  if (!Array.isArray(input)) throw new Error('an input that is neither text nor a list');
  const tools = new Map<string, string>();
  for (const item of input) {
    if (!isObject(item)) throw new Error('an input item that is not an object');
    if (item['role'] !== undefined) {
      out.push(message(roleOf(item['role']), textOf(item['content'])));
    } else if (item['type'] === 'function_call') {
      const id = str(item['call_id']);
      const name = str(item['name']);
      if (id !== undefined && name !== undefined) tools.set(id, name);
      out.push(
        message('assistant', typeof item['arguments'] === 'string' ? item['arguments'] : ''),
      );
    } else if (item['type'] === 'function_call_output') {
      const id = str(item['call_id']);
      out.push(
        message('tool', textOf(item['output']), id === undefined ? undefined : tools.get(id)),
      );
    }
  }
  return out;
}

/** Embeddings: each input text; token ids can't be read as text. */
function embeddings(input: unknown): PromptMessage[] {
  return (Array.isArray(input) ? list(input) : [input]).map((value) => {
    if (typeof value !== 'string') throw new Error('an embedding input that is not text');
    return message('input', value);
  });
}

/** Anthropic Messages: `system`, then each message; tool results are the tool's. */
function anthropic(body: Record<string, unknown>, messages: readonly unknown[]): PromptMessage[] {
  const out: PromptMessage[] = [];
  if (body['system'] !== undefined) out.push(message('system', textOf(body['system'])));
  const tools = new Map<string, string>();
  for (const entry of messages) {
    if (!isObject(entry)) throw new Error('a message that is not an object');
    const role =
      entry['role'] === 'user' || entry['role'] === 'assistant' ? entry['role'] : undefined;
    const content = entry['content'];
    if (!Array.isArray(content)) {
      out.push(message(role, textOf(content)));
      continue;
    }
    const own: string[] = [];
    const results: PromptMessage[] = [];
    for (const block of content) {
      if (!isObject(block)) throw new Error('a content block that is not an object');
      if (block['type'] === 'text' && typeof block['text'] === 'string') own.push(block['text']);
      else if (block['type'] === 'tool_use') {
        own.push(JSON.stringify(block['input'] ?? null));
        const id = str(block['id']);
        const name = str(block['name']);
        if (id !== undefined && name !== undefined) tools.set(id, name);
      } else if (block['type'] === 'tool_result') {
        const id = str(block['tool_use_id']);
        results.push(
          message('tool', textOf(block['content']), id === undefined ? undefined : tools.get(id)),
        );
      }
    }
    if (own.length > 0 || results.length === 0) out.push(message(role, own.join('\n')));
    out.push(...results);
  }
  return out;
}

/**
 * The messages a call sends, from its decoded request body; null when the body
 * can't be read or has a shape the proxy doesn't know. An empty body sends none.
 */
export function readPrompt(
  kind: UpstreamKind,
  path: string,
  body: string | undefined,
): PromptMessage[] | null {
  if (body === undefined) return null;
  if (body.trim() === '') return [];
  try {
    const value: unknown = JSON.parse(body);
    if (!isObject(value)) return null;
    if (kind === 'gemini') return geminiPrompt(value);
    if (kind === 'ai-gateway') return gatewayPrompt(value);
    const messages = value['messages'];
    if (kind === 'anthropic') return Array.isArray(messages) ? anthropic(value, messages) : null;
    if (Array.isArray(messages)) return chat(messages);
    if (path.endsWith('/embeddings')) return embeddings(value['input']);
    if ('input' in value || 'instructions' in value) return responses(value);
    return null;
  } catch {
    // Not JSON, or a shape the readers don't know: say so, rather than send a shorter prompt.
    return null;
  }
}
