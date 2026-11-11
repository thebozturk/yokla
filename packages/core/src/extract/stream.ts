// Streamed answers (ADR-0016): server-sent events or newline-delimited JSON,
// turned into one document that the profile's paths read as they read a JSON
// body: {text, events, all, last}. The text pieces are joined in order. A
// declared `done` event that never came, or an `error` event, makes the
// answer incomplete: that is reported, never hidden.

import type { ResponseStream } from '../schema/profile.ts';
import { queryJsonPath } from './jsonpath.ts';
import { toJson, type JsonValue } from './response.ts';

/** A piece of the body as it arrived, `atMs` after the request started. */
export interface StreamChunk {
  readonly atMs: number;
  readonly text: string;
}

export interface StreamEvent {
  /** The SSE event field; undefined for NDJSON and for SSE events without one. */
  readonly field: string | undefined;
  readonly data: JsonValue;
  /** When the chunk that completed the event arrived. */
  readonly atMs: number;
}

function parsed(data: string): JsonValue {
  try {
    return toJson(JSON.parse(data));
  } catch {
    return data;
  }
}

/**
 * Server-sent events, as the standard reads them: an event ends at a blank
 * line, its data lines are joined by line breaks, and other fields and comment
 * lines (which start with a colon) are ignored. An event the stream cut off
 * before its blank line is dropped.
 */
function sse(chunks: readonly StreamChunk[]): StreamEvent[] {
  const events: StreamEvent[] = [];
  let pending = '';
  let field: string | undefined;
  let data: string[] = [];
  for (const chunk of chunks) {
    pending += chunk.text;
    // A CR at the end may be half of a CRLF that the next chunk completes.
    const held = pending.endsWith('\r') ? '\r' : '';
    const lines = pending.slice(0, pending.length - held.length).split(/\r\n|\r|\n/u);
    // The last piece may be an unfinished line: keep it for the next chunk.
    pending = (lines.pop() ?? '') + held;
    for (const line of lines) {
      if (line === '') {
        if (data.length > 0)
          events.push({ field, data: parsed(data.join('\n')), atMs: chunk.atMs });
        field = undefined;
        data = [];
        continue;
      }
      const colon = line.indexOf(':');
      const name = colon === -1 ? line : line.slice(0, colon);
      const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /u, '');
      if (name === 'event') field = value;
      else if (name === 'data') data.push(value);
    }
  }
  return events;
}

/** Newline-delimited JSON: one value per line; a last line without a line break counts. */
function ndjson(chunks: readonly StreamChunk[]): StreamEvent[] {
  const events: StreamEvent[] = [];
  let pending = '';
  const push = (line: string, atMs: number) => {
    if (line.trim() !== '') events.push({ field: undefined, data: parsed(line), atMs });
  };
  for (const chunk of chunks) {
    pending += chunk.text;
    const lines = pending.split(/\r?\n/u);
    pending = lines.pop() ?? '';
    for (const line of lines) push(line, chunk.atMs);
  }
  push(pending, chunks.at(-1)?.atMs ?? 0);
  return events;
}

export function parseStream(
  chunks: readonly StreamChunk[],
  format: ResponseStream['format'],
): StreamEvent[] {
  return format === 'sse' ? sse(chunks) : ndjson(chunks);
}

export interface ReadStream {
  /** {text, events, all, last}, for the profile's paths. */
  readonly document: JsonValue;
  /** When the first text piece arrived; undefined when none did. */
  readonly firstTextMs: number | undefined;
  /** Why the answer is incomplete, when it is. */
  readonly problem: string | undefined;
}

function first(data: JsonValue, path: string): unknown {
  return queryJsonPath(data, path)[0];
}

export function readStream(chunks: readonly StreamChunk[], spec: ResponseStream): ReadStream {
  const named = parseStream(chunks, spec.format).map((event) => {
    const fromData = spec.event === undefined ? undefined : first(event.data, spec.event);
    const name =
      spec.event === undefined
        ? (event.field ?? 'message')
        : typeof fromData === 'string'
          ? fromData
          : 'message';
    return { ...event, event: name };
  });

  const pieces: string[] = [];
  let firstTextMs: number | undefined;
  // Maps, so an event named like an object's own keys (__proto__) stays plain data.
  const all = new Map<string, JsonValue[]>();
  const last = new Map<string, JsonValue>();
  for (const { event, data, atMs } of named) {
    all.set(event, [...(all.get(event) ?? []), data]);
    last.set(event, data);
    if (event !== spec.text.event) continue;
    const piece = first(data, spec.text.from);
    if (typeof piece !== 'string' || piece === '') continue;
    pieces.push(piece);
    firstTextMs ??= atMs;
  }

  let problem: string | undefined;
  const failure = spec.error === undefined ? undefined : last.get(spec.error.event);
  if (spec.error !== undefined && failure !== undefined) {
    const message = spec.error.from === undefined ? undefined : first(failure, spec.error.from);
    problem = `the stream reported an error: ${typeof message === 'string' ? message : JSON.stringify(failure)}`;
  } else if (spec.done !== undefined && !last.has(spec.done)) {
    problem = `the stream ended before its "${spec.done}" event`;
  }

  return {
    document: {
      text: pieces.join(''),
      events: named.map(({ event, data }) => ({ event, data })),
      all: Object.fromEntries(all),
      last: Object.fromEntries(last),
    },
    firstTextMs,
    problem,
  };
}
