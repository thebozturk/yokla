// The demo-shop's bearer tokens (ADR-0031): with --auth, the chat, the
// session opening and the WebSocket take a request only with a token the shop
// issued, that hasn't expired and has uses left. Tokens come from two places:
// POST /v1/oauth/token, by OAuth 2.0 client credentials (RFC 6749 §4.4), and
// POST /v1/login, for a username and password, in an answer shape of its own.

import { randomUUID } from 'node:crypto';

export interface AuthOptions {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly username: string;
  readonly password: string;
  /** How long a token is valid. */
  readonly ttlMs: number;
  /** How many requests one token serves; unlimited when undefined. */
  readonly maxUses?: number;
  readonly now?: () => number;
}

export interface Answer {
  readonly status: number;
  readonly body: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}

interface Issued {
  readonly expiresAt: number;
  uses: number;
}

/** A form value, decoded as application/x-www-form-urlencoded. */
function formDecoded(text: string): string {
  return decodeURIComponent(text.replaceAll('+', ' '));
}

const NO_STORE = { 'cache-control': 'no-store' };

export class TokenIssuer {
  readonly #options: AuthOptions;
  readonly #issued = new Map<string, Issued>();

  constructor(options: AuthOptions) {
    this.#options = options;
  }

  #now(): number {
    return (this.#options.now ?? Date.now)();
  }

  #issue(): string {
    const token = `dst_${randomUUID()}`;
    this.#issued.set(token, { expiresAt: this.#now() + this.#options.ttlMs, uses: 0 });
    return token;
  }

  /** Whether a request with this authorization header may go on; it uses the token once. */
  admit(authorization: string | undefined): boolean {
    const token = /^Bearer (\S+)$/iu.exec(authorization ?? '')?.[1];
    const issued = token === undefined ? undefined : this.#issued.get(token);
    if (issued === undefined || this.#now() >= issued.expiresAt) return false;
    if (this.#options.maxUses !== undefined && issued.uses >= this.#options.maxUses) return false;
    issued.uses += 1;
    return true;
  }

  /** POST /v1/oauth/token: client credentials, by HTTP Basic or in the form. */
  token(body: string, authorization: string | undefined): Answer {
    const form = new URLSearchParams(body);
    let id = form.get('client_id') ?? undefined;
    let secret = form.get('client_secret') ?? undefined;
    const basic = /^Basic (\S+)$/iu.exec(authorization ?? '')?.[1];
    if (basic !== undefined) {
      const pair = Buffer.from(basic, 'base64').toString('utf8');
      const colon = pair.indexOf(':');
      id = formDecoded(pair.slice(0, colon));
      secret = formDecoded(pair.slice(colon + 1));
    }
    if (form.get('grant_type') !== 'client_credentials') {
      return { status: 400, body: { error: 'unsupported_grant_type' }, headers: NO_STORE };
    }
    if (id !== this.#options.clientId || secret !== this.#options.clientSecret) {
      return {
        status: 401,
        body: { error: 'invalid_client', error_description: 'client authentication failed' },
        headers: { ...NO_STORE, 'www-authenticate': 'Basic' },
      };
    }
    return {
      status: 200,
      body: {
        access_token: this.#issue(),
        token_type: 'Bearer',
        expires_in: this.#options.ttlMs / 1000,
      },
      headers: NO_STORE,
    };
  }

  /** POST /v1/login: a username and password, as JSON. */
  login(body: string): Answer {
    let value: unknown;
    try {
      value = JSON.parse(body);
    } catch {
      value = undefined;
    }
    const field = (name: string): unknown =>
      typeof value === 'object' && value !== null ? Reflect.get(value, name) : undefined;
    if (
      field('username') !== this.#options.username ||
      field('password') !== this.#options.password
    ) {
      return { status: 401, body: { error: 'invalid_credentials' }, headers: NO_STORE };
    }
    return {
      status: 200,
      body: { data: { jwt: this.#issue(), ttlSeconds: this.#options.ttlMs / 1000 } },
      headers: NO_STORE,
    };
  }
}
