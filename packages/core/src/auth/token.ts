// What a token answer holds, and keeping secrets out of what yokla writes
// (ADR-0031). Pure: the runtime sends the token request.

import { queryJsonPath } from '../extract/jsonpath.ts';
import type { JsonValue } from '../extract/response.ts';
import type { TargetAuth } from '../schema/profile.ts';

export interface Token {
  readonly token: string;
  /** Its lifetime, when the answer gives one. */
  readonly expiresInMs: number | undefined;
}

function seconds(value: unknown): number | undefined {
  const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof number === 'number' && Number.isFinite(number) && number > 0
    ? number * 1000
    : undefined;
}

/** The token in a 2xx answer to the token request; a problem when there is none. */
export function readToken(auth: TargetAuth, answer: unknown): Token | { readonly problem: string } {
  if (auth.kind === 'oauth2-client-credentials') {
    const token: unknown =
      typeof answer === 'object' && answer !== null
        ? Reflect.get(answer, 'access_token')
        : undefined;
    if (typeof token !== 'string' || token === '') {
      return { problem: 'the token endpoint answered without an access_token' };
    }
    return { token, expiresInMs: seconds(Reflect.get(Object(answer), 'expires_in')) };
  }
  const [token] = queryJsonPath(answer, auth.token);
  if (typeof token !== 'string' || token === '') {
    return { problem: `the token request's answer has no token at ${auth.token}` };
  }
  const [lifetime] = auth.expiresIn === undefined ? [] : queryJsonPath(answer, auth.expiresIn);
  return { token, expiresInMs: seconds(lifetime) };
}

/** What an OAuth 2.0 error answer says (RFC 6749 §5.2): its error, and its description. */
export function oauthError(answer: unknown): string | undefined {
  if (typeof answer !== 'object' || answer === null) return undefined;
  const error: unknown = Reflect.get(answer, 'error');
  if (typeof error !== 'string' || error === '') return undefined;
  const description: unknown = Reflect.get(answer, 'error_description');
  return typeof description === 'string' && description !== ''
    ? `${error} (${description})`
    : error;
}

/** How long a token is used: until less than this much of its lifetime remains. */
export function refreshMargin(lifetimeMs: number, refreshBeforeMs: number): number {
  return Math.min(refreshBeforeMs, lifetimeMs / 2);
}

export const MASK = '***';

/** The text with every secret in it shown as ***, the longest first. */
export function maskSecrets(text: string, secrets: Iterable<string>): string {
  let masked = text;
  for (const secret of [...new Set(secrets)]
    .filter((s) => s !== '')
    .toSorted((a, b) => b.length - a.length)) {
    masked = masked.replaceAll(secret, MASK);
  }
  return masked;
}

/** Every string in a JSON value masked; the shape is kept. */
export function maskDeep(value: JsonValue, secrets: Iterable<string>): JsonValue {
  const list = [...secrets].filter((secret) => secret !== '');
  if (list.length === 0) return value;
  const walk = (node: JsonValue): JsonValue => {
    if (typeof node === 'string') return maskSecrets(node, list);
    if (Array.isArray(node)) return node.map(walk);
    if (typeof node === 'object' && node !== null) {
      return Object.fromEntries(Object.entries(node).map(([key, inner]) => [key, walk(inner)]));
    }
    return node;
  };
  return walk(value);
}
