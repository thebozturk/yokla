import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { BuiltRequest } from '@yokla/core';
import { afterEach, describe, expect, it } from 'vitest';
import { HttpClient, HttpError } from './client.ts';
import type { Clock } from './rate-limit.ts';

type Handler = (request: IncomingMessage, body: string, response: ServerResponse) => void;

const servers: Server[] = [];

async function serve(handler: Handler): Promise<string> {
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      handler(request, Buffer.concat(chunks).toString('utf8'), response);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (typeof address !== 'object' || address === null) throw new Error('no address');
  return `http://127.0.0.1:${String(address.port)}`;
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => {
            resolve();
          });
        }),
    ),
  );
});

function fakeClock(): Clock & { readonly sleeps: number[] } {
  let time = 0;
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => time,
    sleep: (ms) => {
      sleeps.push(ms);
      time += ms;
      return Promise.resolve();
    },
  };
}

function post(url: string, body: unknown = { message: 'hi' }): BuiltRequest {
  return {
    url,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

describe('HttpClient', () => {
  it('sends the request and parses a JSON response', async () => {
    const base = await serve((request, body, response) => {
      response.writeHead(200, { 'content-type': 'application/json', 'X-Echo': 'yes' });
      response.end(
        JSON.stringify({
          method: request.method,
          path: request.url,
          body: JSON.parse(body) as unknown,
        }),
      );
    });
    const client = new HttpClient({ allowedOrigins: [base], timeoutMs: 5_000 });
    const result = await client.send(post(`${base}/v1/chat`, { message: 'Çadır' }));
    expect(result).toMatchObject({
      status: 200,
      attempts: 1,
      waitedMs: 0,
      json: { method: 'POST', path: '/v1/chat', body: { message: 'Çadır' } },
    });
    expect(result.headers['x-echo']).toBe('yes');
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('keeps a non-JSON body as text', async () => {
    const base = await serve((_request, _body, response) => {
      response.end('plain text');
    });
    const result = await new HttpClient({ allowedOrigins: [base], timeoutMs: 5_000 }).send(
      post(base),
    );
    expect([result.text, result.json]).toEqual(['plain text', undefined]);
  });

  it('refuses hosts that are not configured targets, without contacting them', async () => {
    let contacted = false;
    const other = await serve((_request, _body, response) => {
      contacted = true;
      response.end('{}');
    });
    const client = new HttpClient({ allowedOrigins: ['http://127.0.0.1:1'], timeoutMs: 5_000 });
    await expect(client.send(post(other))).rejects.toMatchObject({ kind: 'refused-host' });
    expect(contacted).toBe(false);
  });

  it('waits as long as the longest tiered retry header asks, then retries', async () => {
    let calls = 0;
    const base = await serve((_request, _body, response) => {
      calls += 1;
      if (calls === 1) {
        response.writeHead(429, { 'retry-after-burst': '300', 'retry-after-minute': '1500' });
        response.end('{}');
        return;
      }
      response.end('{"ok":true}');
    });
    const clock = fakeClock();
    const client = new HttpClient({
      allowedOrigins: [base],
      timeoutMs: 5_000,
      retryAfter: {
        headers: ['retry-after', 'retry-after-*'],
        unit: 'milliseconds',
        maxWaitMs: 60_000,
      },
      clock,
    });
    const result = await client.send(post(base));
    expect(result).toMatchObject({ status: 200, attempts: 2, waitedMs: 1_500, json: { ok: true } });
    expect(clock.sleeps).toEqual([1_500]);
  });

  it('gives up when the target asks for a longer wait than allowed', async () => {
    const base = await serve((_request, _body, response) => {
      response.writeHead(429, { 'retry-after': '120' });
      response.end();
    });
    const client = new HttpClient({
      allowedOrigins: [base],
      timeoutMs: 5_000,
      retryAfter: { headers: ['retry-after'], unit: 'seconds', maxWaitMs: 60_000 },
      clock: fakeClock(),
    });
    await expect(client.send(post(base))).rejects.toMatchObject({ kind: 'rate-limited' });
  });

  it('gives up after the retry budget', async () => {
    let calls = 0;
    const base = await serve((_request, _body, response) => {
      calls += 1;
      response.writeHead(429, { 'retry-after': '1' });
      response.end();
    });
    const client = new HttpClient({
      allowedOrigins: [base],
      timeoutMs: 5_000,
      maxRetries: 2,
      clock: fakeClock(),
    });
    await expect(client.send(post(base))).rejects.toBeInstanceOf(HttpError);
    expect(calls).toBe(3);
  });

  it('times out a target that never answers', async () => {
    const base = await serve(() => {
      // Never respond.
    });
    const client = new HttpClient({ allowedOrigins: [base], timeoutMs: 100 });
    await expect(client.send(post(base))).rejects.toMatchObject({ kind: 'timeout' });
  });

  it('reports a refused connection as a network error', async () => {
    const client = new HttpClient({ allowedOrigins: ['http://127.0.0.1:1'], timeoutMs: 2_000 });
    await expect(client.send(post('http://127.0.0.1:1/'))).rejects.toMatchObject({
      kind: 'network',
    });
  });

  it('rejects a response larger than the limit', async () => {
    const base = await serve((_request, _body, response) => {
      response.end('x'.repeat(2_000));
    });
    const client = new HttpClient({
      allowedOrigins: [base],
      timeoutMs: 5_000,
      maxResponseBytes: 1_000,
    });
    await expect(client.send(post(base))).rejects.toMatchObject({ kind: 'too-large' });
  });
});
