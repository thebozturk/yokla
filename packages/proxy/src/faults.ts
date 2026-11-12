// How the model proxy makes the faults of ADR-0013: which call of an armed
// turn gets a fault, deterministic jitter, provider-shaped error bodies, and
// the changes to a real answer that empty it, break it or cut it short.

import type { Fault, FaultPlan } from '@yokla/core';
import type { UpstreamKind } from './usage.ts';

export type ChangingFault = Extract<
  Fault['kind'],
  'malformed-json' | 'empty-content' | 'truncated-stream' | 'invalid-tool-call'
>;

export function isChanging(kind: Fault['kind']): kind is ChangingFault {
  return (
    kind === 'malformed-json' ||
    kind === 'empty-content' ||
    kind === 'truncated-stream' ||
    kind === 'invalid-tool-call'
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
}

export function armTurn(plans: readonly FaultPlan[], seed?: string): ArmedTurn {
  return { plans, matched: plans.map(() => 0), seed };
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
  let hash = 0x81_1c_9d_c5;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x01_00_01_93) >>> 0;
  }
  // One step of mulberry32 turns the hash into a uniform fraction.
  let t = (hash + 0x6d_2b_79_f5) >>> 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  const fraction = ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  return Math.round(fraction * max);
}

/** An error body in the shape the provider uses, so the app parses it as it would a real one. */
export function errorBody(kind: UpstreamKind, status: 429 | 500 | 503): string {
  const message = `the model proxy injected a ${String(status)} (a yokla fault)`;
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
  switch (fault) {
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
