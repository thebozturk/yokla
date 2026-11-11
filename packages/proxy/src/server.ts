// The model proxy (ADR-0012): a localhost HTTP server between an app and its
// providers. A call to /<upstream-id>/<rest> goes to <upstream>/<rest> with
// the app's own headers, and the response comes back byte for byte. Nothing
// is changed in either direction. While a recording is open, every call
// yields a ProxyRecord, tagged with the turn the runner marked as in flight
// and holding the messages it sent (ADR-0015), and a turn the runner armed
// with faults gets them (ADR-0013).
// Paths under /_yokla/ are the local control endpoint
// and are never forwarded. The proxy contacts only its configured upstreams.

import { randomUUID } from 'node:crypto';
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
import { FaultPlan, z, type ProxyRecord, type ProxyUsage } from '@yokla/core';
import {
  armTurn,
  changeAnswer,
  errorBody,
  isChanging,
  jitter,
  nextFault,
  type ArmedTurn,
} from './faults.ts';
import { readPrompt } from './prompts.ts';
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
});

/** A call the proxy answered itself made no provider call: zero is a measurement. */
const NOTHING_SPENT: ProxyUsage = {
  input: 0,
  output: 0,
  cachedInput: 0,
  cacheWrite: 0,
  reasoning: 0,
};

interface Recording {
  readonly id: string;
  readonly startedAt: string;
  readonly records: ProxyRecord[];
  /** The turn the runner says is in flight (serial correlation). */
  mark: string | null;
  /** The turns the runner armed, with their fault plans (ADR-0013). */
  readonly turns: Map<string, ArmedTurn>;
}

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
      recording = {
        id: randomUUID(),
        startedAt: new Date().toISOString(),
        records: [],
        mark: null,
        turns: new Map(),
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
        sendJson(response, 400, { error: 'expected {"inFlight"?: boolean, "faults"?: [...]}' });
        return;
      }
      const turn = decodeURIComponent(turned[2] ?? '');
      if (parsed.data.inFlight) open.mark = turn;
      open.turns.set(turn, armTurn(parsed.data.faults));
      sendJson(response, 200, {
        id: open.id,
        turn,
        inFlight: parsed.data.inFlight,
        faults: parsed.data.faults.length,
      });
      return;
    }
    const match = /^\/_yokla\/recordings\/([\w-]+)$/u.exec(path);
    if (match !== null && (request.method === 'GET' || request.method === 'DELETE')) {
      const open = recording;
      if (open?.id !== match[1] || open === undefined) {
        sendJson(response, 404, { error: 'no such recording' });
        return;
      }
      const { id, startedAt, records } = open;
      if (request.method === 'DELETE') recording = undefined;
      sendJson(response, 200, { id, startedAt, records });
      return;
    }
    sendJson(response, 404, { error: 'unknown control endpoint' });
  }

  async function forward(
    request: IncomingMessage,
    response: ServerResponse,
    upstream: ProxyUpstream,
    rest: string,
  ): Promise<void> {
    const body = await readBody(request, maxRequest);
    if (body === undefined) {
      sendJson(response, 413, { error: 'request body too large for the proxy' });
      return;
    }
    const base = new URL(upstream.upstream);
    const startedAt = new Date();
    const started = performance.now();
    const facts = requestFacts(body);
    const trace = request.headers['x-yokla-trace'];
    const captured: Buffer[] = [];
    let capturedBytes = 0;
    let overflow = false;
    const open = recording;
    const mark = open?.mark ?? null;
    // The turn this call belongs to: the one its trace names, else the one in flight.
    const turnId = typeof trace === 'string' && open?.turns.has(trace) === true ? trace : mark;
    const armed = turnId === null ? undefined : open?.turns.get(turnId);
    const fault = armed === undefined ? undefined : nextFault(armed, upstream.id);

    const finish = (
      status: number | null,
      encoding: string | undefined,
      stream: boolean,
      error?: string,
      extra: { usage?: ProxyUsage; forwarded?: false; applied?: boolean } = {},
    ) => {
      if (open === undefined || recording !== open) return;
      const raw = overflow ? undefined : decoded(Buffer.concat(captured), encoding);
      const read =
        extra.usage !== undefined
          ? { usage: extra.usage, model: null }
          : raw === undefined
            ? { usage: UNMEASURED, model: null }
            : readUsage(upstream.kind, raw, stream);
      const path = rest.split('?')[0] ?? '';
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
        prompt: readPrompt(upstream.kind, path, decoded(body, request.headers['content-encoding'])),
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
      const seed = `${turnId ?? ''}|${upstream.id}|${(armed?.matched ?? []).join(',')}`;
      await new Promise((resolve) => setTimeout(resolve, fault.ms + jitter(seed, fault.jitterMs)));
    }
    const changing = fault !== undefined && isChanging(fault.kind) ? fault.kind : undefined;

    const send = base.protocol === 'https:' ? httpsRequest : httpRequest;
    const outgoing = send(
      {
        protocol: base.protocol,
        hostname: base.hostname,
        port: base.port,
        method: request.method,
        path: `${base.pathname.replace(/\/$/u, '')}${rest}`,
        headers: { ...endToEnd(request.headers), host: base.host },
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
            finish(status, encoding, stream, undefined, { applied: changed.applied });
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
