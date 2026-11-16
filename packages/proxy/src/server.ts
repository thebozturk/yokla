// The model proxy (ADR-0012): a localhost HTTP server between an app and its
// providers. A call to /<upstream-id>/<rest> goes to <upstream>/<rest> with
// the app's own headers, and the response comes back byte for byte. Nothing
// is changed in either direction. While a recording is open, every call
// yields a ProxyRecord, tagged with the turn the runner marked as in flight
// and holding the messages it sent (ADR-0015), and a turn the runner armed
// with faults gets them (ADR-0013).
// Paths under /_yokla/ are the local control endpoint
// and are never forwarded. The proxy contacts only its configured upstreams.

import { createHash, randomUUID } from 'node:crypto';
import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type ServerResponse,
} from 'node:http';
import { request as httpsRequest } from 'node:https';
import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib';
import {
  CassetteCall,
  FaultPlan,
  ModelSwap,
  modelCallOf,
  readOtlpJson,
  readOtlpProtobuf,
  z,
  type OtlpSpan,
  type ProxyRecord,
  type ProxyUsage,
  type SpanCall,
} from '@yokla/core';
import {
  armTurn,
  changeAnswer,
  errorBody,
  isChanging,
  jitter,
  jitterSeed,
  nextFault,
  type ArmedTurn,
} from './faults.ts';
import { geminiFacts } from './gemini.ts';
import { readPrompt } from './prompts.ts';
import { readOutputText } from './output.ts';
import { readOffered, readToolCalls } from './tools.ts';
import { readUsage, UNMEASURED, type UpstreamKind } from './usage.ts';

export interface ProxyUpstream {
  readonly id: string;
  readonly kind: UpstreamKind;
  readonly upstream: string;
}

export interface ProxyOptions {
  readonly upstreams: readonly ProxyUpstream[];
  /** 0 picks a free port. */
  readonly port: number;
  /** Called for each call recorded while a recording is open. */
  readonly onRecord?: (record: ProxyRecord) => void;
  /** Response bytes kept for reading usage; beyond this, usage is unmeasured. */
  readonly maxCaptureBytes?: number;
  readonly maxRequestBytes?: number;
}

export interface RunningProxy {
  readonly url: string;
  readonly port: number;
  close(): Promise<void>;
}

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
]);

/** Headers to pass on: all but hop-by-hop ones and those named in Connection. */
function endToEnd(headers: IncomingHttpHeaders): OutgoingHttpHeaders {
  const named = new Set(
    (headers.connection ?? '')
      .split(',')
      .map((name) => name.trim().toLowerCase())
      .filter((name) => name !== ''),
  );
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => !HOP_BY_HOP.has(name) && !named.has(name)),
  );
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
  });
  response.end(text);
}

function decoded(body: Buffer, encoding: string | undefined): string | undefined {
  try {
    switch ((encoding ?? '').trim().toLowerCase()) {
      case '':
      case 'identity':
        return body.toString('utf8');
      case 'gzip':
      case 'x-gzip':
        return gunzipSync(body).toString('utf8');
      case 'br':
        return brotliDecompressSync(body).toString('utf8');
      case 'deflate':
        return inflateSync(body).toString('utf8');
      default:
        return undefined;
    }
  } catch {
    return undefined;
  }
}

function requestFacts(body: Buffer): { model: string | null; stream: boolean } {
  try {
    const value: unknown = JSON.parse(body.toString('utf8'));
    if (typeof value !== 'object' || value === null) return { model: null, stream: false };
    const model: unknown = Reflect.get(value, 'model');
    const stream: unknown = Reflect.get(value, 'stream');
    return { model: typeof model === 'string' ? model : null, stream: stream === true };
  } catch {
    return { model: null, stream: false };
  }
}

async function readBody(request: IncomingMessage, max: number): Promise<Buffer | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > max) return undefined;
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

const TurnArming = z.object({
  inFlight: z.boolean().default(false),
  faults: z.array(FaultPlan).default([]),
  /** What identifies the turn across runs, for repeatable jitter (ADR-0017). */
  seed: z.string().min(1).max(1024).optional(),
});

/** A call the proxy answered itself made no provider call: zero is a measurement. */
const NOTHING_SPENT: ProxyUsage = {
  input: 0,
  output: 0,
  cachedInput: 0,
  cacheWrite: 0,
  reasoning: 0,
};

/** What a recording does with model calls besides measuring them (ADR-0040). */
const Opening = z.object({
  /** Keep each forwarded call as a cassette keeps it. */
  capture: z.boolean().default(false),
  /** Send the calls that ask for a model to another (ADR-0042). */
  swaps: z.array(ModelSwap).default([]),
  /** Answer each call from these recorded calls, forwarding nothing. */
  replay: z.object({ loose: z.boolean().default(false), calls: z.array(CassetteCall) }).optional(),
});

interface Replay {
  readonly loose: boolean;
  readonly calls: readonly CassetteCall[];
  /** Which recorded calls have answered already. */
  readonly used: boolean[];
}

/**
 * The recorded call that answers a call (ADR-0040): within its turn, the first
 * unused one with the same upstream, path and request hash; with `loose`, else
 * the one at the same position, marked diverged. Undefined when none fits.
 */
function findReplay(
  replay: Replay,
  call: {
    turn: string | undefined;
    position: number | undefined;
    upstream: string;
    path: string;
    requestSha256: string;
  },
): { call: CassetteCall; diverged: boolean } | undefined {
  if (call.turn === undefined) return undefined;
  const fits = (recorded: CassetteCall, index: number) =>
    replay.used[index] !== true &&
    recorded.turn === call.turn &&
    recorded.upstream === call.upstream &&
    recorded.path === call.path;
  let index = replay.calls.findIndex(
    (recorded, i) => fits(recorded, i) && recorded.requestSha256 === call.requestSha256,
  );
  let diverged = false;
  if (index === -1 && replay.loose) {
    index = replay.calls.findIndex(
      (recorded, i) => fits(recorded, i) && recorded.position === call.position,
    );
    diverged = index !== -1;
  }
  const found = replay.calls[index];
  if (found === undefined) return undefined;
  replay.used[index] = true;
  return { call: found, diverged };
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * The call a model swap makes of an app's call (ADR-0042): the first swap of
 * the called upstream for the model the call asks for, with the model's name
 * changed in the body, or in a Gemini call's path, and sent to the swap's
 * upstream. Undefined when no swap applies, or the body names no model.
 */
function swapOf(
  swaps: readonly ModelSwap[],
  upstreams: ReadonlyMap<string, ProxyUpstream>,
  called: ProxyUpstream,
  rest: string,
  body: Buffer,
  headers: IncomingHttpHeaders,
):
  | {
      readonly asked: string;
      readonly upstream: ProxyUpstream;
      readonly rest: string;
      readonly body: Buffer;
      readonly headers: OutgoingHttpHeaders;
    }
  | undefined {
  if (swaps.length === 0) return undefined;
  if (called.kind === 'gemini') {
    const asked = geminiFacts(rest).model;
    const swap = swaps.find((s) => s.upstream === called.id && s.asked === asked);
    if (swap === undefined || asked === null) return undefined;
    return {
      asked,
      upstream: upstreams.get(swap.to ?? called.id) ?? called,
      rest: rest.replace(`/models/${asked}:`, `/models/${swap.model}:`),
      body,
      headers: endToEnd(headers),
    };
  }
  let value: unknown;
  try {
    value = JSON.parse(decoded(body, headers['content-encoding']) ?? '');
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const asked: unknown = Reflect.get(value, 'model');
  const swap = swaps.find((s) => s.upstream === called.id && s.asked === asked);
  if (swap === undefined || typeof asked !== 'string') return undefined;
  // A changed body goes uncompressed, as a fault's does (ADR-0013); the app's length goes,
  // and Node sets the new one, since the body is given whole to end().
  const changed = Buffer.from(JSON.stringify({ ...value, model: swap.model }), 'utf8');
  const { 'content-encoding': _encoding, 'content-length': _length, ...kept } = endToEnd(headers);
  return {
    asked,
    upstream: upstreams.get(swap.to ?? called.id) ?? called,
    rest,
    body: changed,
    headers: kept,
  };
}

interface Recording {
  readonly id: string;
  readonly startedAt: string;
  readonly records: ProxyRecord[];
  /** Keep each forwarded call as a cassette keeps it (ADR-0040). */
  readonly capture: boolean;
  /** Answer from a cassette instead of the provider (ADR-0040). */
  readonly replay: Replay | undefined;
  /** Per turn key, how many calls have arrived, for each call's position (ADR-0040). */
  readonly positions: Map<string, number>;
  /** The model swaps of this recording (ADR-0042). */
  readonly swaps: readonly ModelSwap[];
  /** The turn the runner says is in flight (serial correlation). */
  mark: string | null;
  /** The turns the runner armed, with their fault plans (ADR-0013). */
  readonly turns: Map<string, ArmedTurn>;
  /** Calls of this recording whose answer to the app hasn't closed yet (ADR-0016). */
  inFlight: number;
  /** When a call of this recording last ended, on the performance clock. */
  lastActivity: number;
  /** Model calls read from the OpenTelemetry spans the app exported (ADR-0029). */
  readonly spans: SpanCall[];
  /** When the app last exported spans, on the performance clock. */
  lastExport: number;
}

const Settling = z.object({
  quietMs: z.int().min(0).max(600_000),
  maxWaitMs: z.int().min(0).max(600_000),
});

export async function startProxy(options: ProxyOptions): Promise<RunningProxy> {
  const upstreams = new Map(options.upstreams.map((upstream) => [upstream.id, upstream]));
  const maxCapture = options.maxCaptureBytes ?? 16 * 1024 * 1024;
  const maxRequest = options.maxRequestBytes ?? 32 * 1024 * 1024;
  let recording: Recording | undefined;

  async function control(
    request: IncomingMessage,
    response: ServerResponse,
    path: string,
  ): Promise<void> {
    if (request.method === 'GET' && path === '/_yokla/health') {
      sendJson(response, 200, {
        ok: true,
        upstreams: [...upstreams.keys()],
        // Whether one is open, not which: its id is the key to its prompts (ADR-0015).
        recording: recording !== undefined,
      });
      return;
    }
    if (request.method === 'POST' && path === '/_yokla/recordings') {
      if (recording !== undefined) {
        sendJson(response, 409, { error: `recording ${recording.id} is already open` });
        return;
      }
      const body = await readBody(request, maxRequest);
      // A cassette too large to read must not open a recording that forwards every call.
      if (body === undefined) {
        sendJson(response, 413, { error: 'the opening is too large for the proxy' });
        return;
      }
      let value: unknown = {};
      try {
        const text = body.toString('utf8');
        value = text.trim() === '' ? {} : JSON.parse(text);
      } catch {
        value = undefined;
      }
      const opening = Opening.safeParse(value);
      if (!opening.success) {
        sendJson(response, 400, {
          error: 'expected {"capture"?: boolean, "replay"?: {"loose"?: boolean, "calls": [...]}}',
        });
        return;
      }
      const { capture, replay, swaps } = opening.data;
      // A swap goes to an upstream the proxy routes, of the kind the app called (ADR-0042).
      const misrouted = swaps.flatMap((swap) => {
        const from = upstreams.get(swap.upstream);
        const to = upstreams.get(swap.to ?? swap.upstream);
        if (from === undefined) return [`no upstream "${swap.upstream}"`];
        if (to === undefined) return [`no upstream "${swap.to ?? ''}"`];
        return to.kind === from.kind
          ? []
          : [`upstream "${to.id}" is ${to.kind}, not ${from.kind} like "${from.id}"`];
      });
      if (misrouted.length > 0) {
        sendJson(response, 400, { error: `a model swap can't apply: ${misrouted.join('; ')}` });
        return;
      }
      recording = {
        id: randomUUID(),
        startedAt: new Date().toISOString(),
        records: [],
        capture,
        replay:
          replay === undefined
            ? undefined
            : { loose: replay.loose, calls: replay.calls, used: replay.calls.map(() => false) },
        positions: new Map(),
        swaps,
        mark: null,
        turns: new Map(),
        inFlight: 0,
        lastActivity: performance.now(),
        spans: [],
        lastExport: performance.now(),
      };
      sendJson(response, 201, { id: recording.id, startedAt: recording.startedAt });
      return;
    }
    const turned = /^\/_yokla\/recordings\/([\w-]+)\/turns\/([^/]+)$/u.exec(path);
    if (turned !== null && request.method === 'PUT') {
      const open = recording;
      if (open?.id !== turned[1] || open === undefined) {
        sendJson(response, 404, { error: 'no such recording' });
        return;
      }
      const body = await readBody(request, 1024 * 1024);
      let value: unknown;
      try {
        value = JSON.parse(body?.toString('utf8') ?? '');
      } catch {
        value = undefined;
      }
      const parsed = TurnArming.safeParse(value);
      if (!parsed.success) {
        sendJson(response, 400, {
          error: 'expected {"inFlight"?: boolean, "faults"?: [...], "seed"?: string}',
        });
        return;
      }
      const turn = decodeURIComponent(turned[2] ?? '');
      if (parsed.data.inFlight) open.mark = turn;
      open.turns.set(turn, armTurn(parsed.data.faults, parsed.data.seed));
      sendJson(response, 200, {
        id: open.id,
        turn,
        inFlight: parsed.data.inFlight,
        faults: parsed.data.faults.length,
      });
      return;
    }
    // OTLP/HTTP trace exports (ADR-0029): JSON or protobuf, gzipped or not.
    if (request.method === 'POST' && path === '/_yokla/otlp/v1/traces') {
      const raw = await readBody(request, maxRequest);
      if (raw === undefined) {
        sendJson(response, 413, { error: 'export too large for the proxy' });
        return;
      }
      const type = request.headers['content-type'] ?? '';
      const protobuf = type.includes('protobuf');
      let spans: OtlpSpan[] | undefined;
      try {
        const body = request.headers['content-encoding'] === 'gzip' ? gunzipSync(raw) : raw;
        spans = protobuf
          ? readOtlpProtobuf(new Uint8Array(body))
          : type.includes('json')
            ? readOtlpJson(JSON.parse(body.toString('utf8')))
            : undefined;
      } catch {
        spans = undefined;
      }
      if (spans === undefined) {
        sendJson(response, 400, {
          error: 'expected an OTLP trace export, as application/json or application/x-protobuf',
        });
        return;
      }
      const open = recording;
      if (open !== undefined) {
        open.spans.push(...spans.flatMap((span) => modelCallOf(span) ?? []));
        open.lastExport = performance.now();
      }
      // An empty ExportTraceServiceResponse: a full success.
      if (protobuf) response.writeHead(200, { 'content-type': 'application/x-protobuf' }).end();
      else sendJson(response, 200, {});
      return;
    }
    const spansSettling = /^\/_yokla\/recordings\/([\w-]+)\/spans\/settle$/u.exec(path);
    if (spansSettling !== null && request.method === 'POST') {
      const open = recording;
      if (open?.id !== spansSettling[1] || open === undefined) {
        sendJson(response, 404, { error: 'no such recording' });
        return;
      }
      const body = await readBody(request, 1024 * 1024);
      let value: unknown;
      try {
        value = JSON.parse(body?.toString('utf8') ?? '');
      } catch {
        value = undefined;
      }
      const parsed = Settling.safeParse(value);
      if (!parsed.success) {
        sendJson(response, 400, { error: 'expected {"quietMs": n, "maxWaitMs": n}' });
        return;
      }
      // Spans come in batches: wait until no export has come for quietMs.
      const { quietMs, maxWaitMs } = parsed.data;
      const asked = performance.now();
      for (;;) {
        const now = performance.now();
        const quiet = now - Math.max(open.lastExport, asked);
        const waited = now - asked;
        if (quiet >= quietMs || waited >= maxWaitMs) {
          sendJson(response, 200, {
            id: open.id,
            settled: quiet >= quietMs,
            waitedMs: Math.round(waited),
            spans: open.spans.length,
          });
          return;
        }
        const pause = Math.min(25, Math.max(1, quietMs - quiet), Math.max(1, maxWaitMs - waited));
        await new Promise((resolve) => setTimeout(resolve, pause));
      }
    }
    const settling = /^\/_yokla\/recordings\/([\w-]+)\/settle$/u.exec(path);
    if (settling !== null && request.method === 'POST') {
      const open = recording;
      if (open?.id !== settling[1] || open === undefined) {
        sendJson(response, 404, { error: 'no such recording' });
        return;
      }
      const body = await readBody(request, 1024 * 1024);
      let value: unknown;
      try {
        value = JSON.parse(body?.toString('utf8') ?? '');
      } catch {
        value = undefined;
      }
      const parsed = Settling.safeParse(value);
      if (!parsed.success) {
        sendJson(response, 400, { error: 'expected {"quietMs": n, "maxWaitMs": n}' });
        return;
      }
      const { quietMs, maxWaitMs } = parsed.data;
      // Quiet counts from the later of the last activity and this request, so a
      // call the app starts right after its answer still has quietMs to show up.
      const asked = performance.now();
      for (;;) {
        const now = performance.now();
        const quiet = now - Math.max(open.lastActivity, asked);
        const waited = now - asked;
        if (open.inFlight === 0 && quiet >= quietMs) {
          sendJson(response, 200, { id: open.id, settled: true, waitedMs: Math.round(waited) });
          return;
        }
        if (waited >= maxWaitMs) {
          sendJson(response, 200, {
            id: open.id,
            settled: false,
            waitedMs: Math.round(waited),
            inFlight: open.inFlight,
          });
          return;
        }
        const pause = Math.min(25, Math.max(1, quietMs - quiet), Math.max(1, maxWaitMs - waited));
        await new Promise((resolve) => setTimeout(resolve, pause));
      }
    }
    const match = /^\/_yokla\/recordings\/([\w-]+)$/u.exec(path);
    if (match !== null && (request.method === 'GET' || request.method === 'DELETE')) {
      const open = recording;
      if (open?.id !== match[1] || open === undefined) {
        sendJson(response, 404, { error: 'no such recording' });
        return;
      }
      const { id, startedAt, records, spans } = open;
      if (request.method === 'DELETE') recording = undefined;
      sendJson(response, 200, { id, startedAt, records, spans });
      return;
    }
    sendJson(response, 404, { error: 'unknown control endpoint' });
  }

  async function forward(
    request: IncomingMessage,
    response: ServerResponse,
    called: ProxyUpstream,
    calledRest: string,
  ): Promise<void> {
    const open = recording;
    if (open !== undefined) {
      // In flight until the answer to the app closes, however the call ends (ADR-0016).
      open.inFlight += 1;
      response.once('close', () => {
        open.inFlight -= 1;
        open.lastActivity = performance.now();
      });
    }
    const received = await readBody(request, maxRequest);
    if (received === undefined) {
      sendJson(response, 413, { error: 'request body too large for the proxy' });
      return;
    }
    // A model swap sends the call to another model, within a recording only (ADR-0042).
    const swapped =
      open === undefined
        ? undefined
        : swapOf(open.swaps, upstreams, called, calledRest, received, request.headers);
    const upstream = swapped?.upstream ?? called;
    const rest = swapped?.rest ?? calledRest;
    const body = swapped?.body ?? received;
    const sentEncoding = swapped === undefined ? request.headers['content-encoding'] : undefined;
    const base = new URL(upstream.upstream);
    const startedAt = new Date();
    const started = performance.now();
    // Gemini names the model and the streaming method in the path (ADR-0032).
    const facts = upstream.kind === 'gemini' ? geminiFacts(rest) : requestFacts(body);
    const trace = request.headers['x-yokla-trace'];
    const captured: Buffer[] = [];
    let capturedBytes = 0;
    let overflow = false;
    const mark = open?.mark ?? null;
    // The turn this call belongs to: the one its trace names, else the one in flight.
    const turnId = typeof trace === 'string' && open?.turns.has(trace) === true ? trace : mark;
    const armed = turnId === null ? undefined : open?.turns.get(turnId);
    // Faults name the upstream the app called, swapped or not.
    const fault = armed === undefined ? undefined : nextFault(armed, called.id);
    const callPath = rest.split('?')[0] ?? '';
    // A cassette keys a call by its turn and its position there, in arrival order (ADR-0040).
    const turnKey = armed?.seed;
    const cassette = open !== undefined && (open.capture || open.replay !== undefined);
    let position: number | undefined;
    if (cassette && turnKey !== undefined && open !== undefined) {
      position = open.positions.get(turnKey) ?? 0;
      open.positions.set(turnKey, position + 1);
    }
    const requestSha256 = cassette ? sha256(decoded(body, sentEncoding) ?? '') : '';

    const finish = (
      status: number | null,
      encoding: string | undefined,
      stream: boolean,
      error?: string,
      extra: {
        usage?: ProxyUsage;
        forwarded?: false;
        applied?: boolean;
        answered?: string;
        contentType?: string;
        replay?: { diverged: boolean };
      } = {},
    ) => {
      if (open === undefined || recording !== open) return;
      const raw = overflow ? undefined : decoded(Buffer.concat(captured), encoding);
      const read =
        extra.usage !== undefined
          ? { usage: extra.usage, model: null }
          : raw === undefined
            ? { usage: UNMEASURED, model: null }
            : readUsage(upstream.kind, raw, stream);
      const path = callPath;
      const sent = decoded(body, sentEncoding);
      const asked = readToolCalls(upstream.kind, raw, stream, status);
      // What the app got: the changed answer, when a fault changed it (ADR-0033).
      const output = readOutputText(upstream.kind, extra.answered ?? raw, stream, status);
      const record: ProxyRecord = {
        id: randomUUID(),
        upstream: upstream.id,
        kind: upstream.kind,
        method: request.method ?? 'GET',
        path,
        model: read.model ?? facts.model,
        startedAt: startedAt.toISOString(),
        durationMs: Math.round((performance.now() - started) * 100) / 100,
        status,
        stream,
        usage: read.usage,
        trace: typeof trace === 'string' ? trace : null,
        mark,
        ...(fault === undefined
          ? {}
          : { fault: { kind: fault.kind, applied: extra.applied ?? true } }),
        ...(extra.forwarded === false ? { forwarded: false } : {}),
        ...(error === undefined ? {} : { error }),
        // What the call sent to the model, read only for an open recording (ADR-0015).
        prompt: readPrompt(upstream.kind, path, sent),
        // The tools it offered, and the calls the model asked for (ADR-0025).
        tools: readOffered(upstream.kind, sent),
        toolCalls:
          asked === null
            ? null
            : asked.map((call) => ({
                name: call.name,
                chars: call.arguments.length,
                arguments: call.arguments,
              })),
        // The text the model answered, read as its prompt is (ADR-0033).
        output: output === null ? null : { chars: output.length, text: output },
        ...(extra.replay === undefined ? {} : { replay: extra.replay }),
        ...(swapped === undefined ? {} : { asked: swapped.asked }),
        // A forwarded call as a cassette keeps it: the provider's own answer (ADR-0040).
        ...(open.capture &&
        extra.forwarded !== false &&
        turnKey !== undefined &&
        position !== undefined &&
        raw !== undefined &&
        status !== null
          ? {
              capture: {
                turn: turnKey,
                position,
                upstream: upstream.id,
                path,
                requestSha256,
                status,
                contentType: extra.contentType ?? 'application/json',
                body: raw,
              },
            }
          : {}),
      };
      open.records.push(record);
      options.onRecord?.(record);
    };

    if (fault?.kind === 'status') {
      response.writeHead(fault.status, {
        'content-type': 'application/json',
        ...(fault.retryAfterS === undefined ? {} : { 'retry-after': String(fault.retryAfterS) }),
      });
      response.end(errorBody(upstream.kind, fault.status));
      finish(fault.status, undefined, facts.stream, undefined, {
        usage: NOTHING_SPENT,
        forwarded: false,
      });
      return;
    }
    if (fault?.kind === 'timeout') {
      // Never answer: the app gives up, or the hold ends the connection.
      const hold = setTimeout(() => {
        response.destroy();
      }, fault.holdMs);
      response.on('close', () => {
        clearTimeout(hold);
        finish(null, undefined, facts.stream, 'held without an answer (timeout fault)', {
          usage: NOTHING_SPENT,
          forwarded: false,
        });
      });
      return;
    }
    if (fault?.kind === 'latency') {
      const seed = jitterSeed(armed, turnId, called.id);
      await new Promise((resolve) => setTimeout(resolve, fault.ms + jitter(seed, fault.jitterMs)));
    }
    const changing = fault !== undefined && isChanging(fault) ? fault : undefined;

    // Replaying: the answer comes from the cassette, and nothing goes upstream (ADR-0040).
    if (open?.replay !== undefined) {
      const found = findReplay(open.replay, {
        turn: turnKey,
        position,
        upstream: upstream.id,
        path: callPath,
        requestSha256,
      });
      if (found === undefined) {
        const said = `yokla replay: the cassette has no call that matches call ${String((position ?? 0) + 1)} of turn ${turnKey ?? '(none)'} to ${upstream.id}${callPath}`;
        sendJson(response, 502, { error: said });
        finish(502, undefined, facts.stream, said, {
          usage: NOTHING_SPENT,
          forwarded: false,
          replay: { diverged: true },
        });
        return;
      }
      const recorded = found.call;
      const stream = recorded.contentType.includes('text/event-stream') || facts.stream;
      const changed =
        changing === undefined
          ? undefined
          : changeAnswer(changing, upstream.kind, recorded.body, stream);
      const out = changed?.body ?? recorded.body;
      captured.push(Buffer.from(recorded.body, 'utf8'));
      response.writeHead(recorded.status, {
        'content-type': recorded.contentType,
        'content-length': Buffer.byteLength(out, 'utf8'),
      });
      response.end(out);
      finish(recorded.status, undefined, stream, undefined, {
        forwarded: false,
        replay: { diverged: found.diverged },
        ...(changed === undefined ? {} : { applied: changed.applied, answered: changed.body }),
      });
      return;
    }

    const send = base.protocol === 'https:' ? httpsRequest : httpRequest;
    const outgoing = send(
      {
        protocol: base.protocol,
        hostname: base.hostname,
        port: base.port,
        method: request.method,
        path: `${base.pathname.replace(/\/$/u, '')}${rest}`,
        headers: { ...(swapped?.headers ?? endToEnd(request.headers)), host: base.host },
      },
      (upstreamResponse) => {
        const type = upstreamResponse.headers['content-type'] ?? '';
        const stream = type.includes('text/event-stream') || facts.stream;
        if (changing !== undefined) {
          // A changing fault needs the whole answer: hold it, change it, send it uncompressed.
          const held: Buffer[] = [];
          upstreamResponse.on('data', (chunk: Buffer) => held.push(chunk));
          upstreamResponse.on('end', () => {
            const original = Buffer.concat(held);
            captured.push(original);
            const encoding = upstreamResponse.headers['content-encoding'];
            const raw = decoded(original, encoding);
            const status = upstreamResponse.statusCode ?? 502;
            const {
              'content-encoding': _encoding,
              'content-length': _length,
              ...headers
            } = endToEnd(upstreamResponse.headers);
            const changed =
              raw === undefined
                ? { body: undefined, applied: false }
                : changeAnswer(changing, upstream.kind, raw, stream);
            const out = changed.body === undefined ? original : Buffer.from(changed.body, 'utf8');
            response.writeHead(status, {
              ...(changed.body === undefined ? endToEnd(upstreamResponse.headers) : headers),
              'content-length': out.length,
            });
            response.end(out);
            finish(status, encoding, stream, undefined, {
              contentType: type,
              applied: changed.applied,
              ...(changed.body === undefined ? {} : { answered: changed.body }),
            });
          });
          upstreamResponse.on('error', (error) => {
            response.destroy(error);
            finish(upstreamResponse.statusCode ?? null, undefined, stream, error.message);
          });
          return;
        }
        response.writeHead(upstreamResponse.statusCode ?? 502, endToEnd(upstreamResponse.headers));
        upstreamResponse.on('data', (chunk: Buffer) => {
          if (!overflow) {
            capturedBytes += chunk.length;
            if (capturedBytes > maxCapture) overflow = true;
            else captured.push(chunk);
          }
          response.write(chunk);
        });
        upstreamResponse.on('end', () => {
          response.end();
          finish(
            upstreamResponse.statusCode ?? null,
            upstreamResponse.headers['content-encoding'],
            stream,
            undefined,
            { contentType: type },
          );
        });
        upstreamResponse.on('error', (error) => {
          response.destroy(error);
          finish(upstreamResponse.statusCode ?? null, undefined, stream, error.message);
        });
      },
    );
    outgoing.on('error', (error) => {
      if (response.headersSent) response.destroy(error);
      else sendJson(response, 502, { error: `upstream ${upstream.id} failed: ${error.message}` });
      finish(null, undefined, facts.stream, error.message);
    });
    response.on('close', () => {
      if (!response.writableFinished) outgoing.destroy();
    });
    outgoing.end(body);
  }

  const server = createServer((request, response) => {
    const url = request.url ?? '/';
    const path = url.split('?')[0] ?? '/';
    if (path === '/_yokla' || path.startsWith('/_yokla/')) {
      control(request, response, path).catch((error: unknown) => {
        if (!response.headersSent) sendJson(response, 500, { error: String(error) });
        else response.destroy();
      });
      return;
    }
    const match = /^\/([^/?]+)(.*)$/u.exec(url);
    const upstream = match === null ? undefined : upstreams.get(match[1] ?? '');
    if (match === null || upstream === undefined) {
      sendJson(response, 404, { error: `no upstream for ${path}` });
      return;
    }
    forward(request, response, upstream, match[2] ?? '').catch((error: unknown) => {
      if (!response.headersSent) sendJson(response, 500, { error: String(error) });
      else response.destroy();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (typeof address !== 'object' || address === null) throw new Error('proxy has no address');
  return {
    url: `http://127.0.0.1:${String(address.port)}`,
    port: address.port,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}
