// What yokla init reads from one probe answer (ADR-0018): where the answer
// text is, in a JSON body or an event stream, and a route and a session id
// when the answer has them. The rules are narrow and deterministic. Every
// choice names the rule that made it, the runners-up are kept, and the
// mapping is replayed on the probe before it is offered. Pure: no I/O.

import { toJson, extractResponse, type JsonValue } from '../extract/response.ts';
import { parseStream, readStream } from '../extract/stream.ts';
import type { ProfileTarget, ResponseStream } from '../schema/profile.ts';

/** The probe's answer, and the values yokla sent, which an answer may echo. */
export interface Probe {
  readonly status: number;
  readonly contentType: string | undefined;
  readonly body: string;
  /** The probe message and any session id yokla sent. */
  readonly sent: readonly string[];
}

export interface Candidate {
  /** A JSONPath into the body, or into the stream document for a stream. */
  readonly path: string;
  readonly sample: string;
  readonly rule: string;
}

export interface Inference {
  /** The profile's target.response, ready to write. */
  readonly response: ProfileTarget['response'];
  readonly text: Candidate;
  /** The next best text candidates, best first, at most three. */
  readonly alternatives: readonly Candidate[];
  readonly route: Candidate | undefined;
  readonly carry: readonly {
    readonly name: string;
    readonly from: string;
    readonly sample: string;
  }[];
  /** The text the inferred mapping reads from the probe, as yokla run would. */
  readonly replayed: string;
}

export type InferOutcome =
  | { readonly ok: true; readonly inference: Inference }
  | { readonly ok: false; readonly problem: string; readonly shape: string };

/** Keys whose string is most likely the answer. */
const TEXT_KEYS = new Set([
  'answer',
  'reply',
  'response',
  'text',
  'content',
  'message',
  'output',
  'completion',
]);
/** Keys and event names that carry a stream's text pieces. */
const PIECE_KEYS = new Set(['text', 'delta', 'content', 'token', 'chunk', 'message', 'answer']);
const PIECE_EVENT = /delta|text|token|content|chunk|message/iu;
const ROUTE_KEYS = new Set(['route', 'intent', 'handler', 'agent']);
const SESSION_KEY = /^(?:conversation|session|thread|chat)[-_]?id$/iu;
const SAFE_KEY = /^[A-Za-z_][\w-]*$/u;

interface Leaf {
  readonly path: string;
  readonly key: string | undefined;
  readonly value: string | number | boolean | null;
}

function isObject(value: JsonValue): value is { readonly [key: string]: JsonValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Every scalar in a JSON value, with its JSONPath and the key it sits under. */
function leaves(value: JsonValue, path = '$', key?: string): Leaf[] {
  if (value === null || typeof value !== 'object') return [{ path, key, value }];
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => leaves(item, `${path}[${String(index)}]`, key));
  }
  return Object.entries(value).flatMap(([name, item]) => {
    if (!SAFE_KEY.test(name) && /['\\]/u.test(name)) return [];
    const next = SAFE_KEY.test(name) ? `${path}.${name}` : `${path}['${name}']`;
    return leaves(item, next, name);
  });
}

/** Prose: words with letters, not the probe echoed, an id, a URL or a timestamp. */
function isProse(text: string, sent: readonly string[]): boolean {
  const trimmed = text.trim();
  return (
    /\p{L}/u.test(trimmed) &&
    /\s/u.test(trimmed) &&
    !sent.some((value) => value.trim() === trimmed) &&
    !/^https?:\/\//iu.test(trimmed) &&
    !/^\d{4}-\d{2}-\d{2}[T ]/u.test(trimmed)
  );
}

/** Keys of the right name first, then the longest text, then document order. */
function best<T extends { readonly named: boolean; readonly sample: string }>(
  candidates: readonly T[],
): T[] {
  return candidates
    .map((candidate, order) => ({ candidate, order }))
    .toSorted(
      (a, b) =>
        Number(b.candidate.named) - Number(a.candidate.named) ||
        b.candidate.sample.length - a.candidate.sample.length ||
        a.order - b.order,
    )
    .map(({ candidate }) => candidate);
}

function camel(key: string): string {
  return key.replaceAll(/[-_](\p{L})/gu, (_m, letter: string) => letter.toUpperCase());
}

/** A route and session ids anywhere in a document, by the names of their keys. */
function routeAndCarry(
  document: JsonValue,
  sent: readonly string[],
): Pick<Inference, 'route' | 'carry'> {
  const all = leaves(document);
  const routeLeaf = all.find(
    (leaf) =>
      leaf.key !== undefined &&
      ROUTE_KEYS.has(leaf.key.toLowerCase()) &&
      typeof leaf.value === 'string' &&
      /^\S{1,64}$/u.test(leaf.value),
  );
  const carry = all
    .filter(
      (leaf) =>
        leaf.key !== undefined &&
        SESSION_KEY.test(leaf.key) &&
        (typeof leaf.value === 'string' || typeof leaf.value === 'number') &&
        !sent.includes(String(leaf.value)),
    )
    .map((leaf) => ({ name: camel(leaf.key ?? ''), from: leaf.path, sample: String(leaf.value) }))
    .filter((entry, index, list) => list.findIndex((e) => e.name === entry.name) === index);
  return {
    route:
      routeLeaf === undefined
        ? undefined
        : {
            path: routeLeaf.path,
            sample: String(routeLeaf.value),
            rule: 'a key named like a route',
          },
    carry,
  };
}

/** Keys and types of a JSON value, without its values, for a person to read. */
export function shapeOf(value: JsonValue, depth = 3): string {
  if (Array.isArray(value)) {
    const first = value[0];
    return `[${first === undefined || depth === 0 ? '' : shapeOf(first, depth - 1)}${value.length > 1 ? ', …' : ''}]`;
  }
  if (isObject(value)) {
    if (depth === 0) return '{…}';
    const entries = Object.entries(value).map(
      ([key, item]) => `${key}: ${shapeOf(item, depth - 1)}`,
    );
    return `{ ${entries.join(', ')} }`;
  }
  return value === null ? 'null' : typeof value;
}

function streamFormat(probe: Probe): ResponseStream['format'] | undefined {
  const type = (probe.contentType ?? '').toLowerCase();
  if (type.includes('text/event-stream')) return 'sse';
  if (type.includes('ndjson') || type.includes('jsonl')) return 'ndjson';
  if (/^(?:data|event):/mu.test(probe.body)) return 'sse';
  return undefined;
}

function inferJson(probe: Probe): InferOutcome {
  let body: JsonValue;
  try {
    body = toJson(JSON.parse(probe.body));
  } catch {
    return { ok: false, problem: 'the answer is neither JSON nor an event stream', shape: 'text' };
  }
  const candidates = best(
    leaves(body)
      .filter((leaf) => typeof leaf.value === 'string' && isProse(leaf.value, probe.sent))
      .map((leaf) => ({
        path: leaf.path,
        sample: String(leaf.value),
        named: leaf.key !== undefined && TEXT_KEYS.has(leaf.key.toLowerCase()),
      })),
  );
  const [chosen, ...rest] = candidates;
  if (chosen === undefined) {
    return {
      ok: false,
      problem: 'no string in the answer reads like an answer',
      shape: shapeOf(body),
    };
  }
  const found = routeAndCarry(body, probe.sent);
  const response: ProfileTarget['response'] = {
    text: chosen.path,
    ...(found.route === undefined ? {} : { route: found.route.path }),
  };
  return finish(response, body, chosen, rest, found);
}

function inferStream(probe: Probe, format: ResponseStream['format']): InferOutcome {
  const events = parseStream([{ atMs: 0, text: probe.body }], format);
  if (events.length === 0)
    return { ok: false, problem: 'the stream has no events', shape: 'stream' };
  // Events are named by their SSE field, or else by a type or event key most of them carry.
  const unnamed = events.every((event) => event.field === undefined);
  const nameKey = unnamed
    ? ['type', 'event'].find(
        (key) =>
          events.filter((event) => isObject(event.data) && typeof event.data[key] === 'string')
            .length *
            2 >=
          events.length,
      )
    : undefined;
  const named = events.map((event) => {
    const fromData =
      nameKey !== undefined && isObject(event.data) ? event.data[nameKey] : undefined;
    return {
      name: typeof fromData === 'string' ? fromData : (event.field ?? 'message'),
      data: event.data,
    };
  });

  // Each event name and string path is a candidate: its pieces, joined in order.
  const joined = new Map<
    string,
    { event: string; from: string; key: string | undefined; pieces: string[] }
  >();
  for (const { name, data } of named) {
    for (const leaf of leaves(data)) {
      if (typeof leaf.value !== 'string') continue;
      const id = `${name}\u0000${leaf.path}`;
      const entry = joined.get(id) ?? { event: name, from: leaf.path, key: leaf.key, pieces: [] };
      entry.pieces.push(leaf.value);
      joined.set(id, entry);
    }
  }
  const candidates = best(
    [...joined.values()]
      .map((entry) => ({ ...entry, sample: entry.pieces.join('') }))
      .filter((entry) => isProse(entry.sample, probe.sent))
      .map((entry) => ({
        ...entry,
        path: `${entry.event} ${entry.from}`,
        named:
          (entry.key !== undefined && PIECE_KEYS.has(entry.key.toLowerCase())) ||
          PIECE_EVENT.test(entry.event),
      })),
  );
  const [chosen, ...rest] = candidates;
  if (chosen === undefined) {
    return {
      ok: false,
      problem: 'no event of the stream carries text that reads like an answer',
      shape: [...new Set(named.map((event) => event.name))].join(', '),
    };
  }
  const lastName = named.at(-1)?.name;
  const done =
    lastName !== undefined &&
    lastName !== chosen.event &&
    named.filter((event) => event.name === lastName).length === 1
      ? lastName
      : undefined;
  const stream: ResponseStream = {
    format,
    ...(nameKey === undefined ? {} : { event: `$.${nameKey}` }),
    text: { event: chosen.event, from: chosen.from },
    ...(done === undefined ? {} : { done }),
  };
  const document = readStream([{ atMs: 0, text: probe.body }], stream).document;
  // Route and session ids are read from the last event of each name.
  const lastOnly = isObject(document) ? { last: document['last'] ?? null } : null;
  const found = routeAndCarry(toJson(lastOnly), probe.sent);
  const response: ProfileTarget['response'] = {
    stream,
    text: '$.text',
    ...(found.route === undefined ? {} : { route: found.route.path }),
  };
  return finish(response, document, { ...chosen, path: '$.text' }, rest, found);
}

/** The rule that chose a text candidate, for the person reading the profile. */
function ruleOf(named: boolean): string {
  return named ? 'the longest text under a key named like an answer' : 'the longest text';
}

function finish(
  response: ProfileTarget['response'],
  document: JsonValue,
  chosen: { path: string; sample: string; named: boolean },
  rest: readonly { path: string; sample: string; named: boolean }[],
  found: Pick<Inference, 'route' | 'carry'>,
): InferOutcome {
  const replayed = extractResponse(document, response).text;
  if (replayed === undefined || replayed !== chosen.sample) {
    return {
      ok: false,
      problem: 'the inferred mapping does not read the probe back',
      shape: shapeOf(document),
    };
  }
  return {
    ok: true,
    inference: {
      response,
      text: { path: chosen.path, sample: chosen.sample, rule: ruleOf(chosen.named) },
      alternatives: rest
        .slice(0, 3)
        .map((c) => ({ path: c.path, sample: c.sample, rule: ruleOf(c.named) })),
      route: found.route,
      carry: found.carry,
      replayed,
    },
  };
}

/** Where the answer is in a probe's response (ADR-0018). */
export function inferResponse(probe: Probe): InferOutcome {
  if (probe.status < 200 || probe.status > 299) {
    return {
      ok: false,
      problem: `the target answered ${String(probe.status)}`,
      shape: probe.contentType ?? 'no content type',
    };
  }
  const format = streamFormat(probe);
  return format === undefined ? inferJson(probe) : inferStream(probe, format);
}

/** The session id in the answer of a session-opening request (ADR-0016, ADR-0018). */
export function inferSessionId(
  body: string,
): { readonly from: string; readonly sample: string } | undefined {
  let value: JsonValue;
  try {
    value = toJson(JSON.parse(body));
  } catch {
    return undefined;
  }
  const leaf = leaves(value).find(
    (item) =>
      item.key !== undefined &&
      SESSION_KEY.test(item.key) &&
      (typeof item.value === 'string' || typeof item.value === 'number'),
  );
  return leaf === undefined ? undefined : { from: leaf.path, sample: String(leaf.value) };
}
