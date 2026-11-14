import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { Assistant } from './assistant.ts';
import { TokenIssuer, type AuthOptions } from './auth.ts';
import { loadShopData } from './catalog.ts';
import { ScriptedModel } from './model.ts';
import { createDemoShopServer } from './server.ts';

const servers: Server[] = [];

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

const CREDENTIALS = {
  clientId: 'demo client',
  clientSecret: 'demo/secret',
  username: 'tester',
  password: 'demo-password',
};

async function shop(
  change: Partial<AuthOptions> = {},
): Promise<{ url: string; time: { at: number } }> {
  const time = { at: 0 };
  const server = createDemoShopServer({
    assistant: new Assistant({ data: loadShopData(), model: new ScriptedModel(), defect: null }),
    rateLimit: false,
    auth: new TokenIssuer({ ...CREDENTIALS, ttlMs: 60_000, now: () => time.at, ...change }),
  });
  servers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (typeof address !== 'object' || address === null) throw new Error('no address');
  return { url: `http://127.0.0.1:${String(address.port)}`, time };
}

const basic = (id: string, secret: string) =>
  `Basic ${Buffer.from(
    `${new URLSearchParams([['', id]]).toString().slice(1)}:${new URLSearchParams([['', secret]]).toString().slice(1)}`,
  ).toString('base64')}`;

async function tokenBy(url: string, init: RequestInit): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${url}/v1/oauth/token`, { method: 'POST', ...init });
  return { status: response.status, body: await response.json() };
}

const FORM = { 'content-type': 'application/x-www-form-urlencoded' };

async function chat(url: string, token: string | undefined): Promise<number> {
  const response = await fetch(`${url}/v1/chat`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify({ message: 'Merhaba', sessionId: 's-1' }),
  });
  await response.body?.cancel();
  return response.status;
}

function tokenOf(body: unknown): string {
  const token: unknown = Reflect.get(Object(body), 'access_token');
  if (typeof token !== 'string') throw new Error('no token');
  return token;
}

describe('the demo-shop with bearer tokens (ADR-0031)', () => {
  it('issues a token by client credentials, by HTTP Basic or in the form', async () => {
    const { url } = await shop();
    const byBasic = await tokenBy(url, {
      headers: { ...FORM, authorization: basic('demo client', 'demo/secret') },
      body: 'grant_type=client_credentials&scope=chat',
    });
    expect(byBasic).toEqual({
      status: 200,
      body: {
        access_token: expect.stringMatching(/^dst_/u) as unknown,
        token_type: 'Bearer',
        expires_in: 60,
      },
    });
    const inForm = await tokenBy(url, {
      headers: FORM,
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: 'demo client',
        client_secret: 'demo/secret',
      }).toString(),
    });
    expect(inForm.status).toBe(200);
    expect(tokenOf(inForm.body)).not.toBe(tokenOf(byBasic.body));
  });

  it('refuses a wrong client, and another grant, as RFC 6749 §5.2 says', async () => {
    const { url } = await shop();
    expect(
      await tokenBy(url, {
        headers: { ...FORM, authorization: basic('demo client', 'wrong') },
        body: 'grant_type=client_credentials',
      }),
    ).toEqual({
      status: 401,
      body: { error: 'invalid_client', error_description: 'client authentication failed' },
    });
    expect(
      await tokenBy(url, {
        headers: { ...FORM, authorization: basic('demo client', 'demo/secret') },
        body: 'grant_type=password',
      }),
    ).toEqual({ status: 400, body: { error: 'unsupported_grant_type' } });
  });

  it('issues a token for a username and password, in an answer of its own shape', async () => {
    const { url } = await shop({ ttlMs: 1500 });
    const login = (password: string) =>
      fetch(`${url}/v1/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'tester', password }),
      });
    const ok = await login('demo-password');
    expect(ok.status).toBe(200);
    const body: unknown = await ok.json();
    expect(body).toEqual({
      data: { jwt: expect.stringMatching(/^dst_/u) as unknown, ttlSeconds: 1.5 },
    });
    const jwt: unknown = Reflect.get(Object(Reflect.get(Object(body), 'data')), 'jwt');
    expect(await chat(url, String(jwt))).toBe(200);
    expect((await login('wrong')).status).toBe(401);
  });

  it('takes a chat only with a token it issued, unexpired, with uses left', async () => {
    const { url, time } = await shop({ maxUses: 2 });
    const token = tokenOf(
      (
        await tokenBy(url, {
          headers: { ...FORM, authorization: basic('demo client', 'demo/secret') },
          body: 'grant_type=client_credentials',
        })
      ).body,
    );
    expect(await chat(url, undefined)).toBe(401);
    expect(await chat(url, 'dst_made-up')).toBe(401);
    // A token in another scheme is no bearer token.
    const other = await fetch(`${url}/v1/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Token ${token}` },
      body: JSON.stringify({ message: 'Merhaba', sessionId: 's-1' }),
    });
    await other.body?.cancel();
    expect(other.status).toBe(401);
    expect(await chat(url, token)).toBe(200);
    expect(await chat(url, token)).toBe(200);
    // Two uses, then refused.
    expect(await chat(url, token)).toBe(401);
    const fresh = tokenOf(
      (
        await tokenBy(url, {
          headers: { ...FORM, authorization: basic('demo client', 'demo/secret') },
          body: 'grant_type=client_credentials',
        })
      ).body,
    );
    time.at = 59_999;
    expect(await chat(url, fresh)).toBe(200);
    time.at = 60_000;
    expect(await chat(url, fresh)).toBe(401);
  });

  it('refuses a WebSocket handshake without a valid token', async () => {
    const { url } = await shop();
    const opened = (headers: Record<string, string>) =>
      new Promise<string>((resolve) => {
        const socket = new WebSocket(`${url.replace('http:', 'ws:')}/v1/ws?session=s`, { headers });
        socket.addEventListener('open', () => {
          socket.close(1000);
          resolve('open');
        });
        socket.addEventListener('error', () => {
          resolve('refused');
        });
      });
    expect(await opened({})).toBe('refused');
    const token = tokenOf(
      (
        await tokenBy(url, {
          headers: { ...FORM, authorization: basic('demo client', 'demo/secret') },
          body: 'grant_type=client_credentials',
        })
      ).body,
    );
    expect(await opened({ authorization: `Bearer ${token}` })).toBe('open');
  });

  it('serves no token endpoint without --auth', async () => {
    const server = createDemoShopServer({
      assistant: new Assistant({ data: loadShopData(), model: new ScriptedModel(), defect: null }),
      rateLimit: false,
    });
    servers.push(server);
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    const url = `http://127.0.0.1:${String(typeof address === 'object' && address !== null ? address.port : 0)}`;
    expect((await fetch(`${url}/v1/oauth/token`, { method: 'POST' })).status).toBe(404);
    expect(await chat(url, undefined)).toBe(200);
  });
});
