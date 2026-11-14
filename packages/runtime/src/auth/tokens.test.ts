import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { TargetAuth } from '@yokla/core';
import { afterEach, describe, expect, it } from 'vitest';
import { AuthError, authorized, TokenSource } from './tokens.ts';

interface Received {
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

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

/** A token endpoint: answers each request with what `answer` gives, and keeps what it got. */
async function endpoint(
  answer: (index: number) => { status?: number; body: unknown; delayMs?: number },
): Promise<{ url: string; received: Received[] }> {
  const received: Received[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      received.push({ headers: request.headers, body: Buffer.concat(chunks).toString('utf8') });
      const { status = 200, body, delayMs = 0 } = answer(received.length - 1);
      setTimeout(() => {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(body));
      }, delayMs);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (typeof address !== 'object' || address === null) throw new Error('no address');
  return { url: `http://127.0.0.1:${String(address.port)}/token`, received };
}

const ENV = { CLIENT_ID: 'chat app', CLIENT_SECRET: 's3cr3t/value', AUDIENCE: 'https://chat' };

type OAuth = Extract<TargetAuth, { kind: 'oauth2-client-credentials' }>;

const oauth = (tokenUrl: string, change: Partial<Omit<OAuth, 'kind'>> = {}): OAuth => ({
  kind: 'oauth2-client-credentials',
  tokenUrl,
  clientId: '{{env.CLIENT_ID}}',
  clientSecret: '{{env.CLIENT_SECRET}}',
  clientAuth: 'basic',
  scope: 'chat',
  params: { audience: '{{env.AUDIENCE}}' },
  timeoutMs: 2_000,
  refreshBeforeMs: 30_000,
  ...change,
});

/** A clock the test moves. */
function clock(): { now: () => number; at: number } {
  const state = { at: 0, now: () => state.at };
  return state;
}

const issued = (index: number, expires?: number) => ({
  body: {
    access_token: `tkn-${String(index + 1)}`,
    token_type: 'Bearer',
    ...(expires === undefined ? {} : { expires_in: expires }),
  },
});

describe('TokenSource (ADR-0031)', () => {
  it('asks for client credentials with HTTP Basic, the scope and the further fields', async () => {
    const server = await endpoint((index) => issued(index, 3600));
    const tokens = new TokenSource(oauth(server.url), ENV, clock().now);
    expect(await tokens.token()).toBe('tkn-1');
    const [request] = server.received;
    expect(request?.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(Object.fromEntries(new URLSearchParams(request?.body))).toEqual({
      grant_type: 'client_credentials',
      scope: 'chat',
      audience: 'https://chat',
    });
    // RFC 6749 §2.3.1: the id and secret are form-encoded before Basic.
    const basic = request?.headers.authorization?.replace(/^Basic /u, '') ?? '';
    expect(Buffer.from(basic, 'base64').toString('utf8')).toBe('chat+app:s3cr3t%2Fvalue');
  });

  it('puts the client credentials in the form, when asked', async () => {
    const server = await endpoint((index) => issued(index));
    await new TokenSource(oauth(server.url, { clientAuth: 'body' }), ENV, clock().now).token();
    const [request] = server.received;
    expect(request?.headers.authorization).toBeUndefined();
    expect(Object.fromEntries(new URLSearchParams(request?.body))).toMatchObject({
      client_id: 'chat app',
      client_secret: 's3cr3t/value',
    });
  });

  it('sends a token request the profile describes, and reads the token where it says', async () => {
    const server = await endpoint(() => ({ body: { data: { jwt: 'eyJ.a.b', ttl: 120 } } }));
    const login: TargetAuth = {
      kind: 'request',
      request: {
        url: server.url,
        method: 'POST',
        timeoutMs: 2_000,
        body: { user: 'tester', password: '{{env.PASSWORD}}' },
      },
      token: '$.data.jwt',
      expiresIn: '$.data.ttl',
      refreshBeforeMs: 30_000,
    };
    const tokens = new TokenSource(login, { PASSWORD: 'pw-123' }, clock().now);
    expect(await tokens.token()).toBe('eyJ.a.b');
    expect(JSON.parse(server.received[0]?.body ?? '')).toEqual({
      user: 'tester',
      password: 'pw-123',
    });
    expect(tokens.secrets().toSorted()).toEqual(['eyJ.a.b', 'pw-123']);
  });

  it('keeps a token until less than the refresh margin of its lifetime remains', async () => {
    const server = await endpoint((index) => issued(index, 60));
    const time = clock();
    const tokens = new TokenSource(oauth(server.url), ENV, time.now);
    expect(await tokens.token()).toBe('tkn-1');
    time.at = 29_999;
    expect(await tokens.token()).toBe('tkn-1');
    // 60 s with a 30 s margin: due at 30 s.
    time.at = 30_000;
    expect(await tokens.token()).toBe('tkn-2');
    expect(tokens.summary()).toEqual({ kind: 'oauth2-client-credentials', tokens: 2, retried: 0 });
  });

  it('takes half the lifetime as the margin for a short-lived token, and keeps one without a lifetime', async () => {
    const short = await endpoint((index) => issued(index, 20));
    const time = clock();
    const tokens = new TokenSource(oauth(short.url), ENV, time.now);
    await tokens.token();
    time.at = 9_999;
    expect(await tokens.token()).toBe('tkn-1');
    time.at = 10_000;
    expect(await tokens.token()).toBe('tkn-2');
    const lasting = await endpoint((index) => issued(index));
    const forever = new TokenSource(oauth(lasting.url), ENV, time.now);
    await forever.token();
    time.at = 1e12;
    expect(await forever.token()).toBe('tkn-1');
    expect(lasting.received).toHaveLength(1);
  });

  it('fetches once for requests that need a token at the same time', async () => {
    const server = await endpoint((index) => ({ ...issued(index, 3600), delayMs: 30 }));
    const tokens = new TokenSource(oauth(server.url), ENV, clock().now);
    expect(await Promise.all([tokens.token(), tokens.token(), tokens.token()])).toEqual([
      'tkn-1',
      'tkn-1',
      'tkn-1',
    ]);
    expect(server.received).toHaveLength(1);
  });

  it('replaces a refused token once, however many requests it refused', async () => {
    const server = await endpoint((index) => ({ ...issued(index, 3600), delayMs: 20 }));
    const tokens = new TokenSource(oauth(server.url), ENV, clock().now);
    const first = await tokens.token();
    expect(await Promise.all([tokens.renew(first), tokens.renew(first)])).toEqual([
      'tkn-2',
      'tkn-2',
    ]);
    // A request that only now learns tkn-1 was refused gets tkn-2, with no new fetch.
    expect(await tokens.renew(first)).toBe('tkn-2');
    expect(server.received).toHaveLength(2);
    expect(tokens.summary()).toEqual({ kind: 'oauth2-client-credentials', tokens: 2, retried: 3 });
  });

  it('says why a fetch failed, with every secret masked', async () => {
    const refused = await endpoint(() => ({
      status: 401,
      body: { error: 'invalid_client', error_description: 'bad secret s3cr3t/value' },
    }));
    const tokens = new TokenSource(oauth(refused.url), ENV, clock().now);
    await expect(tokens.token()).rejects.toThrow(
      new AuthError('the token request answered 401: invalid_client (bad secret ***)'),
    );
    const empty = await endpoint(() => ({ body: { token_type: 'Bearer' } }));
    await expect(new TokenSource(oauth(empty.url), ENV, clock().now).token()).rejects.toThrow(
      'the token endpoint answered without an access_token',
    );
    const closed = new TokenSource(oauth('http://127.0.0.1:9/token'), ENV, clock().now);
    await expect(closed.token()).rejects.toThrow(/^the token request failed: /u);
    // A failed fetch leaves the next request to try again.
    const flaky = await endpoint((index) =>
      index === 0 ? { status: 503, body: {} } : issued(index),
    );
    const retrying = new TokenSource(oauth(flaky.url), ENV, clock().now);
    await expect(retrying.token()).rejects.toThrow('the token request answered 503');
    expect(await retrying.token()).toBe('tkn-2');
  });

  it('counts every environment value auth uses, and every token, as a secret', async () => {
    const server = await endpoint((index) => issued(index));
    const tokens = new TokenSource(oauth(server.url), { ...ENV, UNUSED: 'other' }, clock().now);
    await tokens.token();
    expect(tokens.secrets().toSorted()).toEqual([
      'chat app',
      'https://chat',
      's3cr3t/value',
      'tkn-1',
    ]);
  });
});

describe('authorized (ADR-0031)', () => {
  it('sends once with the token, and once more with a new one when it is refused', async () => {
    const server = await endpoint((index) => issued(index));
    const tokens = new TokenSource(oauth(server.url), ENV, clock().now);
    const sent: (string | undefined)[] = [];
    const status = await authorized(
      tokens,
      (auth) => {
        sent.push(auth.auth);
        return Promise.resolve(sent.length === 1 ? 401 : 200);
      },
      (code) => code === 401,
    );
    expect(status).toBe(200);
    expect(sent).toEqual(['tkn-1', 'tkn-2']);
    // A second refusal is the request's answer: no third try.
    const twice: (string | undefined)[] = [];
    expect(
      await authorized(
        tokens,
        (auth) => {
          twice.push(auth.auth);
          return Promise.resolve(401);
        },
        (code) => code === 401,
      ),
    ).toBe(401);
    expect(twice).toEqual(['tkn-2', 'tkn-3']);
    // Without auth, it sends once, with no token.
    const plain: unknown[] = [];
    await authorized(
      undefined,
      (auth) => {
        plain.push(auth);
        return Promise.resolve(401);
      },
      () => true,
    );
    expect(plain).toEqual([{}]);
  });
});
