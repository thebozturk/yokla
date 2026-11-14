// The token target.auth gets for the run (ADR-0031): fetched once before the
// first request, again before it expires, and again when the target refuses
// it. One fetch at a time: requests that need a token wait for the fetch in
// progress. The token endpoint is the only host its HTTP client may reach.
// Every value of auth is a secret, kept for masking what yokla writes.

import {
  buildRequest,
  maskSecrets,
  oauthError,
  readToken,
  refreshMargin,
  renderText,
  type BuiltRequest,
  type Results,
  type TargetAuth,
  type TemplateValues,
} from '@yokla/core';
import { HttpClient, HttpError } from '../http/client.ts';

export class AuthError extends Error {
  override readonly name = 'AuthError';
}

const ENV = /\{\{\s*env\.([A-Za-z_]\w*)\s*\}\}/gu;

/** The form encoding RFC 6749 §2.3.1 applies to a client id and secret before Basic. */
function formEncoded(text: string): string {
  return new URLSearchParams([['', text]]).toString().slice(1);
}

interface Current {
  readonly token: string;
  /** When to fetch a new one, on the clock; undefined: until the target refuses it. */
  readonly renewAt: number | undefined;
}

export class TokenSource {
  readonly #auth: TargetAuth;
  readonly #values: TemplateValues;
  readonly #now: () => number;
  readonly #client: HttpClient;
  readonly #secrets = new Set<string>();
  #current: Current | undefined;
  #fetching: Promise<string> | undefined;
  #tokens = 0;
  #retried = 0;

  constructor(
    auth: TargetAuth,
    env: Readonly<Record<string, string | undefined>>,
    now: () => number,
  ) {
    this.#auth = auth;
    this.#values = { message: '', session: undefined, requestId: undefined, carry: {}, env };
    this.#now = now;
    // Every environment value the auth section uses is a secret.
    for (const [, name = ''] of JSON.stringify(auth).matchAll(ENV)) {
      const value = env[name];
      if (value !== undefined && value !== '') this.#secrets.add(value);
    }
    const url = renderText(
      auth.kind === 'request' ? auth.request.url : auth.tokenUrl,
      this.#values,
    );
    this.#client = new HttpClient({
      allowedOrigins: [new URL(url).origin],
      timeoutMs: auth.kind === 'request' ? auth.request.timeoutMs : auth.timeoutMs,
    });
  }

  /** The token to send now: the current one, or a new one when it is due. */
  async token(): Promise<string> {
    const current = this.#current;
    if (current !== undefined && (current.renewAt === undefined || this.#now() < current.renewAt)) {
      return current.token;
    }
    return this.#fetch();
  }

  /** The target refused this token: a new one, unless another request already got it. */
  async renew(refused: string): Promise<string> {
    this.#retried += 1;
    if (this.#current?.token === refused) this.#current = undefined;
    return this.token();
  }

  /** Every secret of the run so far: the tokens, and the environment values auth uses. */
  secrets(): readonly string[] {
    return [...this.#secrets];
  }

  /** What the results say of the run's authentication, with no secret in it. */
  summary(): NonNullable<Results['run']['auth']> {
    return { kind: this.#auth.kind, tokens: this.#tokens, retried: this.#retried };
  }

  #fetch(): Promise<string> {
    this.#fetching ??= this.#request().finally(() => {
      this.#fetching = undefined;
    });
    return this.#fetching;
  }

  #built(): BuiltRequest {
    const auth = this.#auth;
    if (auth.kind === 'request') return buildRequest(auth.request, undefined, this.#values);
    const text = (template: string) => renderText(template, this.#values);
    const id = text(auth.clientId);
    const secret = text(auth.clientSecret);
    const form = new URLSearchParams({ grant_type: 'client_credentials' });
    if (auth.scope !== undefined) form.set('scope', text(auth.scope));
    for (const [name, value] of Object.entries(auth.params ?? {})) form.set(name, text(value));
    const headers: Record<string, string> = {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    };
    if (auth.clientAuth === 'basic') {
      const pair = `${formEncoded(id)}:${formEncoded(secret)}`;
      headers['authorization'] = `Basic ${Buffer.from(pair, 'utf8').toString('base64')}`;
    } else {
      form.set('client_id', id);
      form.set('client_secret', secret);
    }
    return { url: text(auth.tokenUrl), method: 'POST', headers, body: form.toString() };
  }

  async #request(): Promise<string> {
    const started = this.#now();
    const fail = (message: string) => new AuthError(maskSecrets(message, this.#secrets));
    let result;
    try {
      result = await this.#client.send(this.#built());
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw fail(
        `the token request failed: ${error instanceof HttpError ? `${error.kind}: ${message}` : message}`,
      );
    }
    if (result.status < 200 || result.status > 299) {
      const said = oauthError(result.json);
      throw fail(
        `the token request answered ${String(result.status)}${said === undefined ? '' : `: ${said}`}`,
      );
    }
    const read = readToken(this.#auth, result.json);
    if ('problem' in read) throw fail(read.problem);
    this.#secrets.add(read.token);
    this.#tokens += 1;
    this.#current = {
      token: read.token,
      renewAt:
        read.expiresInMs === undefined
          ? undefined
          : started +
            read.expiresInMs -
            refreshMargin(read.expiresInMs, this.#auth.refreshBeforeMs),
    };
    return read.token;
  }
}

/** Sends with the run's token, and once more with a new one when the target refuses it. */
export async function authorized<T>(
  tokens: TokenSource | undefined,
  send: (auth: { readonly auth?: string }) => Promise<T>,
  refused: (result: T) => boolean,
): Promise<T> {
  if (tokens === undefined) return send({});
  const token = await tokens.token();
  const first = await send({ auth: token });
  if (!refused(first)) return first;
  return send({ auth: await tokens.renew(token) });
}
