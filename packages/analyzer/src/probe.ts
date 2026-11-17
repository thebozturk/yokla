// The probes (ADR-0047): a greeting, read by yokla init's rules (ADR-0018),
// then, with a catalog, the pack's type question and cart request in the same
// session. Where the products are in each answer is found by their values
// (core's matchRows). Three messages at most; the target may make its own
// model calls, yokla makes none.

import { randomUUID } from 'node:crypto';
import {
  buildRequest,
  inferResponse,
  inferSessionId,
  matchRows,
  queryJsonPath,
  readStream,
  sessionMode,
  shapeOf,
  TemplateError,
  toJson,
  type DataRow,
  type HttpProfileTarget,
  type Inference,
  type JsonValue,
  type MatchedCollection,
  type ProbedRows,
} from '@yokla/core';
import { HttpClient, HttpError } from '@yokla/runtime';

export class ProbeError extends Error {}

export interface ProbeTarget {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: JsonValue;
  readonly sessionUrl?: string;
  /** The first message: a greeting in the first language. */
  readonly greeting: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly timeoutMs: number;
}

export interface SentProbe {
  readonly message: string;
  readonly status: number;
  readonly latencyMs: number;
  /** The answer's keys and types, without its values. */
  readonly shape: string;
}

export interface FoundCollection {
  /** The evidence collection's name, such as products or cart. */
  readonly name: string;
  /** Which probe showed it, from 1. */
  readonly probe: number;
  readonly match: MatchedCollection;
}

export interface Probed {
  readonly inference: Inference;
  readonly sessionOpen: { readonly url: string; readonly from: string } | undefined;
  readonly probes: readonly SentProbe[];
  readonly collections: readonly FoundCollection[];
  /** The 2xx answers as yokla run reads them, kept in memory to check a contract (ADR-0057). */
  readonly answers: readonly JsonValue[];
}

/** The messages that will be sent, so they can be shown before any is. */
export function plannedMessages(target: ProbeTarget, probed: ProbedRows | undefined): string[] {
  return [
    target.greeting,
    ...(probed === undefined ? [] : [probed.probe.message, '(the cart request, by the answer)']),
  ];
}

function documentOf(text: string, inference: Inference): JsonValue | undefined {
  const stream = inference.response.stream;
  if (stream !== undefined) return readStream([{ atMs: 0, text }], stream).document;
  try {
    return toJson(JSON.parse(text));
  } catch {
    return undefined;
  }
}

/** Sends the probes and reads what they show. */
export async function probeTarget(
  target: ProbeTarget,
  probed: ProbedRows | undefined,
): Promise<Probed> {
  const url = new URL(target.url);
  const sessionUrl =
    target.sessionUrl === undefined
      ? undefined
      : target.sessionUrl.startsWith('/')
        ? new URL(target.sessionUrl, url)
        : new URL(target.sessionUrl);
  const client = new HttpClient({
    allowedOrigins: [url.origin, ...(sessionUrl === undefined ? [] : [sessionUrl.origin])],
    timeoutMs: target.timeoutMs,
  });
  const request: HttpProfileTarget['request'] = {
    url: target.url,
    method: 'POST',
    headers: { ...target.headers },
    body: target.body,
    timeoutMs: target.timeoutMs,
  };
  const session =
    sessionMode({ url: target.url, headers: target.headers, body: target.body }) === 'client'
      ? randomUUID()
      : undefined;
  const carry: Record<string, JsonValue> = {};
  const send = async (req: HttpProfileTarget['request'], message: string) => {
    try {
      return await client.send(
        buildRequest(req, undefined, {
          message,
          session,
          requestId: undefined,
          carry,
          env: target.env,
        }),
      );
    } catch (error) {
      if (error instanceof HttpError) {
        throw new ProbeError(`the probe got no answer: ${error.message}`);
      }
      if (error instanceof TemplateError) {
        throw new ProbeError(`the request can't be sent: ${error.message}`);
      }
      throw error;
    }
  };

  let sessionOpen: Probed['sessionOpen'];
  if (sessionUrl !== undefined) {
    const opened = await send({ ...request, url: sessionUrl.href, body: {} }, '');
    const id =
      opened.status >= 200 && opened.status <= 299 ? inferSessionId(opened.text) : undefined;
    if (id === undefined) throw new ProbeError('--session-url gave no session id');
    carry['session'] = id.sample;
    sessionOpen = { url: target.sessionUrl ?? sessionUrl.href, from: id.from };
  }

  const probes: SentProbe[] = [];
  const answers: JsonValue[] = [];
  const greeted = await send(request, target.greeting);
  const outcome = inferResponse({
    status: greeted.status,
    contentType: greeted.headers['content-type'],
    body: greeted.text,
    sent: [
      target.greeting,
      ...(session === undefined ? [] : [session]),
      ...Object.values(carry).map(String),
    ],
  });
  if (!outcome.ok) {
    throw new ProbeError(
      `the greeting's answer can't be read: ${outcome.problem} (${outcome.shape})`,
    );
  }
  const { inference } = outcome;
  const record = (message: string, answer: typeof greeted): JsonValue | undefined => {
    const document = documentOf(answer.text, inference);
    if (document !== undefined && answer.status >= 200 && answer.status <= 299) {
      answers.push(document);
    }
    probes.push({
      message,
      status: answer.status,
      latencyMs: Math.round(answer.latencyMs * 100) / 100,
      shape:
        document === undefined
          ? (answer.headers['content-type'] ?? 'no content type')
          : shapeOf(document),
    });
    // What the profile carries from one answer to the next (ADR-0016).
    for (const entry of inference.carry) {
      const [value] = document === undefined ? [] : queryJsonPath(document, entry.from);
      if (value !== undefined) carry[entry.name] = toJson(value);
    }
    return document;
  };
  record(target.greeting, greeted);

  const collections: FoundCollection[] = [];
  if (probed !== undefined) {
    const take = (document: JsonValue | undefined, name: string, probe: number) => {
      const taken = new Set(collections.map((found) => found.match.items));
      const match = (document === undefined ? [] : matchRows(document, probed)).find(
        (candidate) => !taken.has(candidate.items),
      );
      if (match !== undefined) collections.push({ name, probe, match });
      return match;
    };
    const shown = take(
      record(probed.probe.message, await send(request, probed.probe.message)),
      probed.probe.collection,
      2,
    );
    const byId = new Map(probed.rows.map((row) => [JSON.stringify(row[probed.id]), row]));
    const rows = (shown?.ids ?? []).flatMap((id): DataRow[] => {
      const row = byId.get(JSON.stringify(id));
      return row === undefined ? [] : [row];
    });
    const next = probed.next(rows);
    if (next !== undefined) {
      take(record(next.message, await send(request, next.message)), next.collection, 3);
    }
  }
  return { inference, sessionOpen, probes, collections, answers };
}
