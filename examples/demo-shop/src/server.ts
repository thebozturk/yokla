import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Assistant } from './assistant.ts';
import { RateLimiter, type RateLimitOptions } from './rate-limit.ts';

export interface DemoShopServerOptions {
  readonly assistant: Assistant;
  /** `false` disables rate limiting. */
  readonly rateLimit: RateLimitOptions | false;
  readonly now?: () => number;
}

export const DEFAULT_RATE_LIMIT: RateLimitOptions = { burstPerSecond: 3, perMinute: 120 };

const MAX_BODY_BYTES = 64 * 1024;
const MAX_MESSAGE_LENGTH = 2_000;
const MAX_SESSION_ID_LENGTH = 128;

function send(
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers });
  response.end(JSON.stringify(body));
}

function readBody(request: IncomingMessage): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const onData = (chunk: Buffer): void => {
      size += chunk.length;
      if (size <= MAX_BODY_BYTES) {
        chunks.push(chunk);
        return;
      }
      // Stop buffering but keep draining, so the client can read the 413.
      request.off('data', onData);
      request.resume();
      resolve(undefined);
    };
    request.on('data', onData);
    request.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    request.on('error', reject);
  });
}

function parseChatRequest(body: string): { message: string; sessionId: string } | undefined {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null) return undefined;
  const message: unknown = 'message' in value ? value.message : undefined;
  const sessionId: unknown = 'sessionId' in value ? value.sessionId : undefined;
  if (typeof message !== 'string' || message.trim() === '' || message.length > MAX_MESSAGE_LENGTH)
    return undefined;
  if (typeof sessionId !== 'string' || sessionId === '' || sessionId.length > MAX_SESSION_ID_LENGTH)
    return undefined;
  return { message, sessionId };
}

function wantsCacheBypass(request: IncomingMessage): boolean {
  const value = request.headers['x-cache-bypass'];
  return typeof value === 'string' && value !== '' && value !== '0' && value !== 'false';
}

export function createDemoShopServer(options: DemoShopServerOptions): Server {
  const limiter =
    options.rateLimit === false
      ? undefined
      : new RateLimiter(options.rateLimit, options.now ?? Date.now);

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (path === '/healthz' && request.method === 'GET') {
      send(response, 200, { status: 'ok' });
      return;
    }
    if (path !== '/v1/chat') {
      send(response, 404, { error: 'not_found' });
      return;
    }
    if (request.method !== 'POST') {
      send(response, 405, { error: 'method_not_allowed' }, { allow: 'POST' });
      return;
    }
    if (limiter !== undefined) {
      const decision = limiter.take(request.socket.remoteAddress ?? 'unknown');
      if (!decision.allowed) {
        send(
          response,
          429,
          { error: 'rate_limited' },
          { 'retry-after': String(decision.retryAfterSeconds) },
        );
        return;
      }
    }

    const body = await readBody(request);
    if (body === undefined) {
      send(response, 413, { error: 'payload_too_large' }, { connection: 'close' });
      return;
    }
    const chat = parseChatRequest(body);
    if (chat === undefined) {
      send(response, 400, {
        error: 'invalid_request',
        detail: `expected JSON {"message": non-empty string (max ${String(MAX_MESSAGE_LENGTH)}), "sessionId": non-empty string (max ${String(MAX_SESSION_ID_LENGTH)})}`,
      });
      return;
    }

    const { reply, cache } = await options.assistant.reply(chat.sessionId, chat.message, {
      bypassCache: wantsCacheBypass(request),
    });
    send(response, 200, { data: reply }, { 'x-cache': cache });
  }

  return createServer((request, response) => {
    handle(request, response).catch(() => {
      if (response.headersSent) response.destroy();
      else send(response, 500, { error: 'internal_error' });
    });
  });
}
