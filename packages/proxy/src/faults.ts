// How the model proxy makes the faults of ADR-0013: which call of an armed
// turn gets a fault, deterministic jitter, provider-shaped error bodies, and
// the changes to a real answer that empty it, break it or cut it short.

import {
  seededFraction,
  type DescriptionInjection,
  type Fault,
  type FaultPlan,
  type ToolInjection,
} from '@yokla/core';
import { gatewayBreakToolCalls, gatewayError, gatewayTextSlots } from './gateway.ts';
import { geminiBreakToolCalls, geminiEmptyText, geminiError } from './gemini.ts';
import type { UpstreamKind } from './usage.ts';

export type ChangingFault = Extract<
  Fault,
  {
    kind: 'malformed-json' | 'empty-content' | 'truncated-stream' | 'invalid-tool-call' | 'answer';
  }
>;

export function isChanging(fault: Fault): fault is ChangingFault {
  return (
    fault.kind === 'malformed-json' ||
    fault.kind === 'empty-content' ||
    fault.kind === 'truncated-stream' ||
    fault.kind === 'invalid-tool-call' ||
    fault.kind === 'answer'
  );
}

/**
 * A turn the runner armed: its plans, how many calls each plan has matched so
 * far, and the seed of its jitter (ADR-0017).
 */
export interface ArmedTurn {
  readonly plans: readonly FaultPlan[];
  readonly matched: number[];
  readonly seed: string | undefined;
  /** Text to inject into the turn's tool results (ADR-0043). */
  readonly injections: readonly ToolInjection[];
  /** Text to append to the descriptions of the tools the turn's calls offer (ADR-0085). */
  readonly descriptions: readonly DescriptionInjection[];
}

export function armTurn(
  plans: readonly FaultPlan[],
  seed?: string,
  injections: readonly ToolInjection[] = [],
  descriptions: readonly DescriptionInjection[] = [],
): ArmedTurn {
  return { plans, matched: plans.map(() => 0), seed, injections, descriptions };
}

/**
 * The jitter seed of a call (ADR-0017): the seed the runner armed the turn
 * with, made of what identifies the turn across runs, or else the turn id;
 * then the upstream and how many calls each plan has matched, so every call
 * draws its own delay.
 */
export function jitterSeed(
  turn: ArmedTurn | undefined,
  turnId: string | null,
  upstream: string,
): string {
  return `${turn?.seed ?? turnId ?? ''}|${upstream}|${(turn?.matched ?? []).join(',')}`;
}

/** The fault for the turn's next call to `upstream`: the first plan whose filters match. */
export function nextFault(turn: ArmedTurn, upstream: string): Fault | undefined {
  let chosen: Fault | undefined;
  for (const [index, plan] of turn.plans.entries()) {
    if (plan.upstream !== undefined && plan.upstream !== upstream) continue;
    const call = (turn.matched[index] ?? 0) + 1;
    turn.matched[index] = call;
    if (chosen === undefined && (plan.calls === undefined || plan.calls.includes(call))) {
      chosen = plan.fault;
    }
  }
  return chosen;
}

/** A number from 0 to max, the same for the same seed, so a faulted run repeats. */
export function jitter(seed: string, max: number): number {
  if (max <= 0) return 0;
  return Math.round(seededFraction(seed) * max);
}

/** An error body in the shape the provider uses, so the app parses it as it would a real one. */
export function errorBody(kind: UpstreamKind, status: 429 | 500 | 503): string {
  const message = `the model proxy injected a ${String(status)} (a yokla fault)`;
  if (kind === 'gemini') return geminiError(status, message);
  if (kind === 'ai-gateway') return gatewayError(status, message);
  if (kind === 'anthropic') {
    const type =
      status === 429 ? 'rate_limit_error' : status === 503 ? 'overloaded_error' : 'api_error';
    return JSON.stringify({ type: 'error', error: { type, message } });
  }
  const type = status === 429 ? 'rate_limit_exceeded' : 'server_error';
  return JSON.stringify({ error: { message, type, code: null } });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

const BROKEN_ARGUMENTS = '{"broken": ';

/** Empties every text part of one JSON answer or stream event; true when it changed one. */
function emptyText(kind: UpstreamKind, value: unknown): boolean {
  let changed = false;
  const clear = (holder: unknown, key: string) => {
    if (isObject(holder) && typeof holder[key] === 'string' && holder[key] !== '') {
      holder[key] = '';
      changed = true;
    }
  };
  if (!isObject(value)) return false;
  if (kind === 'gemini') return geminiEmptyText(value);
  if (kind === 'ai-gateway') {
    for (const [holder, key] of gatewayTextSlots(value)) clear(holder, key);
    return changed;
  }
  if (kind === 'anthropic') {
    for (const part of list(value['content']))
      if (isObject(part) && part['type'] === 'text') clear(part, 'text');
    if (value['type'] === 'content_block_delta') clear(value['delta'], 'text');
    return changed;
  }
  for (const choice of list(value['choices'])) {
    if (!isObject(choice)) continue;
    clear(choice['message'], 'content');
    clear(choice['delta'], 'content');
  }
  for (const item of list(value['output'])) {
    if (isObject(item)) for (const part of list(item['content'])) clear(part, 'text');
  }
  if (value['type'] === 'response.output_text.delta') clear(value, 'delta');
  return changed;
}

/** Breaks the arguments of every tool call in one JSON answer; true when there was one. */
function breakToolCalls(kind: UpstreamKind, value: unknown): boolean {
  let changed = false;
  if (!isObject(value)) return false;
  if (kind === 'gemini') return geminiBreakToolCalls(value, BROKEN_ARGUMENTS);
  if (kind === 'ai-gateway') return gatewayBreakToolCalls(value, BROKEN_ARGUMENTS);
  if (kind === 'anthropic') {
    for (const part of list(value['content'])) {
      if (isObject(part) && part['type'] === 'tool_use') {
        part['input'] = BROKEN_ARGUMENTS;
        changed = true;
      }
    }
    return changed;
  }
  for (const choice of list(value['choices'])) {
    const message = isObject(choice) ? choice['message'] : undefined;
    for (const call of list(isObject(message) ? message['tool_calls'] : undefined)) {
      if (isObject(call) && isObject(call['function'])) {
        call['function']['arguments'] = BROKEN_ARGUMENTS;
        changed = true;
      }
    }
  }
  for (const item of list(value['output'])) {
    if (isObject(item) && item['type'] === 'function_call') {
      item['arguments'] = BROKEN_ARGUMENTS;
      changed = true;
    }
  }
  return changed;
}

/**
 * A text slot of an answer: its holder and key, and the copy of the answer
 * it belongs to. The pieces of a stream join into one copy; a Responses API
 * stream also repeats the whole text in its `done` and `completed` events,
 * each event type a copy of its own.
 */
type TextSlot = readonly [holder: Record<string, unknown>, key: string, copy: string];

/**
 * The text slots of one JSON answer or stream event, in order: message
 * content, text blocks and parts, and text deltas. A Gemini thought summary
 * isn't the answer's text.
 */
function textSlots(kind: UpstreamKind, value: unknown): TextSlot[] {
  const slots: TextSlot[] = [];
  const add = (holder: unknown, key: string, copy = 'pieces') => {
    if (isObject(holder) && typeof holder[key] === 'string') slots.push([holder, key, copy]);
  };
  if (!isObject(value)) return slots;
  if (kind === 'gemini') {
    for (const candidate of list(value['candidates'])) {
      const content = isObject(candidate) ? candidate['content'] : undefined;
      for (const part of list(isObject(content) ? content['parts'] : undefined)) {
        if (isObject(part) && part['thought'] !== true) add(part, 'text');
      }
    }
    return slots;
  }
  if (kind === 'ai-gateway') {
    for (const [holder, key] of gatewayTextSlots(value)) add(holder, key);
    return slots;
  }
  if (kind === 'anthropic') {
    for (const part of list(value['content']))
      if (isObject(part) && part['type'] === 'text') add(part, 'text');
    if (value['type'] === 'content_block_delta') {
      const delta = value['delta'];
      if (isObject(delta) && delta['type'] === 'text_delta') add(delta, 'text');
    }
    return slots;
  }
  for (const choice of list(value['choices'])) {
    if (!isObject(choice)) continue;
    add(choice['message'], 'content');
    add(choice['delta'], 'content');
  }
  const messageParts = (output: unknown, copy: string) => {
    for (const item of list(output)) {
      if (isObject(item) && item['type'] === 'message') {
        for (const part of list(item['content'])) add(part, 'text', copy);
      }
    }
  };
  messageParts(value['output'], 'pieces');
  // A Responses API stream: the pieces, then the whole text again in each done event.
  const type = value['type'];
  if (type === 'response.output_text.delta') add(value, 'delta');
  if (type === 'response.output_text.done') add(value, 'text', type);
  if (type === 'response.content_part.done') add(value['part'], 'text', type);
  if (type === 'response.output_item.done') messageParts([value['item']], type);
  if (type === 'response.completed') {
    const response = value['response'];
    messageParts(isObject(response) ? response['output'] : undefined, type);
  }
  return slots;
}

/**
 * A replacer for the answer fault (ADR-0040): in each copy of the answer, the
 * first text slot gets the text and every later one is emptied, so a stream's
 * pieces join to the text, and so does each full copy a stream repeats.
 */
function replacer(kind: UpstreamKind, text: string): (value: unknown) => boolean {
  const placed = new Set<string>();
  return (value) => {
    const slots = textSlots(kind, value);
    for (const [holder, key, copy] of slots) {
      holder[key] = placed.has(copy) ? '' : text;
      placed.add(copy);
    }
    return slots.length > 0;
  };
}

function blocks(body: string): string[] {
  return body.split(/\r?\n\r?\n/u).filter((block) => block.trim() !== '');
}

/** Rewrites the JSON data line of each event; other lines, such as `event:`, stay. */
function rewriteEvents(
  body: string,
  change: (value: unknown) => boolean,
): { body: string; changed: boolean } {
  let changed = false;
  const out = blocks(body).map((block) =>
    block
      .split(/\r?\n/u)
      .map((line) => {
        if (!line.startsWith('data:')) return line;
        try {
          const value: unknown = JSON.parse(line.slice(5));
          if (!change(value)) return line;
          changed = true;
          return `data: ${JSON.stringify(value)}`;
        } catch {
          return line;
        }
      })
      .join('\n'),
  );
  return { body: `${out.join('\n\n')}\n\n`, changed };
}

/** The answer the app receives under a changing fault, and whether the fault could apply. */
export function changeAnswer(
  fault: ChangingFault,
  kind: UpstreamKind,
  body: string,
  stream: boolean,
): { body: string; applied: boolean } {
  const unchanged = { body, applied: false };
  switch (fault.kind) {
    case 'answer': {
      const replace = replacer(kind, fault.text);
      // A Gemini stream may be a JSON array of answers rather than events.
      if (stream && kind === 'gemini' && body.trim().startsWith('[')) {
        try {
          const answers: unknown = JSON.parse(body);
          const changed = Array.isArray(answers) && answers.map(replace).some(Boolean);
          return changed ? { body: JSON.stringify(answers), applied: true } : unchanged;
        } catch {
          return unchanged;
        }
      }
      if (stream) {
        const rewritten = rewriteEvents(body, replace);
        return { body: rewritten.body, applied: rewritten.changed };
      }
      try {
        const value: unknown = JSON.parse(body);
        return replace(value) ? { body: JSON.stringify(value), applied: true } : unchanged;
      } catch {
        return unchanged;
      }
    }
    case 'malformed-json':
      return stream || body.length < 2
        ? unchanged
        : { body: body.slice(0, Math.floor(body.length / 2)), applied: true };
    case 'truncated-stream': {
      const events = blocks(body);
      if (!stream || events.length < 2) return unchanged;
      return {
        body: `${events.slice(0, Math.floor(events.length / 2)).join('\n\n')}\n\n`,
        applied: true,
      };
    }
    case 'empty-content': {
      // A Gemini stream may be a JSON array of answers rather than events.
      if (stream && kind === 'gemini' && body.trim().startsWith('[')) {
        try {
          const answers: unknown = JSON.parse(body);
          const changed = Array.isArray(answers)
            ? answers.map((answer: unknown) => geminiEmptyText(answer)).some(Boolean)
            : false;
          return changed ? { body: JSON.stringify(answers), applied: true } : unchanged;
        } catch {
          return unchanged;
        }
      }
      if (stream) {
        const rewritten = rewriteEvents(body, (value) => emptyText(kind, value));
        return { body: rewritten.body, applied: rewritten.changed };
      }
      try {
        const value: unknown = JSON.parse(body);
        return emptyText(kind, value) ? { body: JSON.stringify(value), applied: true } : unchanged;
      } catch {
        return unchanged;
      }
    }
    case 'invalid-tool-call': {
      if (stream) return unchanged;
      try {
        const value: unknown = JSON.parse(body);
        return breakToolCalls(kind, value)
          ? { body: JSON.stringify(value), applied: true }
          : unchanged;
      } catch {
        return unchanged;
      }
    }
  }
}
