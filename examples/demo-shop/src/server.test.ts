import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { Assistant } from './assistant.ts';
import { loadShopData } from './catalog.ts';
import { ScriptedModel } from './model.ts';
import type { RateLimitOptions } from './rate-limit.ts';
import { createDemoShopServer } from './server.ts';

const data = loadShopData();
const servers: Server[] = [];

async function start(
  rateLimit: RateLimitOptions | false = false,
  now?: () => number,
): Promise<string> {
  const assistant = new Assistant({ data, model: new ScriptedModel(), defect: null });
  const server = createDemoShopServer({
    assistant,
    rateLimit,
    ...(now === undefined ? {} : { now }),
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
          server.close(() => {
            resolve();
          });
        }),
    ),
  );
});

function chat(
  base: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${base}/v1/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

describe('demo-shop HTTP server', () => {
  it('answers a chat request in the documented shape', async () => {
    const base = await start();
    const response = await chat(base, { message: 'Show me headlamps', sessionId: 's1' });
    expect(response.status).toBe(200);
    expect(response.headers.get('x-cache')).toBe('miss');
    const body: unknown = await response.json();
    expect(body).toMatchObject({
      data: {
        answer: expect.stringContaining('Here are our headlamps:') as unknown,
        metadata: { route: 'product-search', language: 'en' },
        products: [
          {
            id: 'HLP-001',
            name: 'Headlamp 200 lm',
            category: 'outdoor/lighting/headlamp',
            price: { amount: 349.9, currency: 'TRY' },
            stockQuantity: 40,
            attributes: {},
          },
          { id: 'HLP-002', stockQuantity: null },
          { id: 'HLP-003', stockQuantity: 0 },
        ],
      },
    });
  });

  it('serves repeated first turns from cache unless the bypass header is set', async () => {
    const base = await start();
    const message = { message: 'Çadır önerir misin?', sessionId: 'a' };
    expect((await chat(base, message)).headers.get('x-cache')).toBe('miss');
    expect((await chat(base, { ...message, sessionId: 'b' })).headers.get('x-cache')).toBe('hit');
    expect(
      (await chat(base, { ...message, sessionId: 'c' }, { 'x-cache-bypass': '1' })).headers.get(
        'x-cache',
      ),
    ).toBe('bypass');
    expect(
      (await chat(base, { ...message, sessionId: 'd' }, { 'x-cache-bypass': '0' })).headers.get(
        'x-cache',
      ),
    ).toBe('hit');
  });

  it('rate limits with 429 and Retry-After', async () => {
    let time = 0;
    const base = await start({ burstPerSecond: 1, perMinute: 60 }, () => time);
    expect((await chat(base, { message: 'Merhaba', sessionId: 'a' })).status).toBe(200);
    const limited = await chat(base, { message: 'Merhaba', sessionId: 'a' });
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('1');
    time += 1_000;
    expect((await chat(base, { message: 'Merhaba', sessionId: 'a' })).status).toBe(200);
  });

  it.each([
    ['invalid JSON', '{'],
    ['missing message', { sessionId: 's' }],
    ['empty message', { message: '  ', sessionId: 's' }],
    ['missing session', { message: 'hi' }],
    ['non-string session', { message: 'hi', sessionId: 1 }],
  ])('rejects %s with 400', async (_name, body) => {
    const base = await start();
    expect((await chat(base, body)).status).toBe(400);
  });

  it('rejects oversized bodies, unknown paths and wrong methods', async () => {
    const base = await start();
    expect((await chat(base, { message: 'x'.repeat(70_000), sessionId: 's' })).status).toBe(413);
    expect((await fetch(`${base}/nope`)).status).toBe(404);
    const get = await fetch(`${base}/v1/chat`);
    expect(get.status).toBe(405);
    expect(get.headers.get('allow')).toBe('POST');
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
  });
});
