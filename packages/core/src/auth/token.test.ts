import { describe, expect, it } from 'vitest';
import type { TargetAuth } from '../schema/profile.ts';
import { maskDeep, maskSecrets, oauthError, readToken, refreshMargin } from './token.ts';

const OAUTH: TargetAuth = {
  kind: 'oauth2-client-credentials',
  tokenUrl: 'https://auth.example.com/token',
  clientId: 'chat',
  clientSecret: '{{env.SECRET}}',
  clientAuth: 'basic',
  timeoutMs: 10_000,
  refreshBeforeMs: 30_000,
};

const LOGIN: TargetAuth = {
  kind: 'request',
  request: { url: 'https://chat.example.com/login', method: 'POST', timeoutMs: 30_000 },
  token: '$.data.jwt',
  expiresIn: '$.data.ttl',
  refreshBeforeMs: 30_000,
};

describe('readToken (ADR-0031)', () => {
  it('reads an OAuth access token and its lifetime', () => {
    expect(
      readToken(OAUTH, { access_token: 'abc', token_type: 'Bearer', expires_in: 3600 }),
    ).toEqual({ token: 'abc', expiresInMs: 3_600_000 });
    expect(readToken(OAUTH, { access_token: 'abc', expires_in: '60' })).toEqual({
      token: 'abc',
      expiresInMs: 60_000,
    });
    // A lifetime it can't read is no lifetime: the token is used until refused.
    for (const expires of [undefined, 0, -5, 'soon', '', null]) {
      expect(readToken(OAUTH, { access_token: 'abc', expires_in: expires })).toEqual({
        token: 'abc',
        expiresInMs: undefined,
      });
    }
  });

  it('says when an OAuth answer has no token', () => {
    for (const answer of [{}, { access_token: '' }, { access_token: 3 }, null, 'abc']) {
      expect(readToken(OAUTH, answer)).toEqual({
        problem: 'the token endpoint answered without an access_token',
      });
    }
  });

  it('reads the token, and its lifetime, where the profile says', () => {
    expect(readToken(LOGIN, { data: { jwt: 'eyJ', ttl: 2 } })).toEqual({
      token: 'eyJ',
      expiresInMs: 2000,
    });
    expect(readToken({ ...LOGIN, expiresIn: undefined }, { data: { jwt: 'eyJ', ttl: 2 } })).toEqual(
      {
        token: 'eyJ',
        expiresInMs: undefined,
      },
    );
    expect(readToken(LOGIN, { data: { token: 'eyJ' } })).toEqual({
      problem: "the token request's answer has no token at $.data.jwt",
    });
    expect(readToken(LOGIN, { data: { jwt: '' } })).toEqual({
      problem: "the token request's answer has no token at $.data.jwt",
    });
    expect(readToken(LOGIN, { data: { jwt: 42 } })).toEqual({
      problem: "the token request's answer has no token at $.data.jwt",
    });
  });
});

describe('oauthError (ADR-0031)', () => {
  it('reads the error and its description, as RFC 6749 §5.2 gives them', () => {
    expect(oauthError({ error: 'invalid_client', error_description: 'unknown client' })).toBe(
      'invalid_client (unknown client)',
    );
    expect(oauthError({ error: 'invalid_scope' })).toBe('invalid_scope');
    expect(oauthError({ error: 'invalid_scope', error_description: '' })).toBe('invalid_scope');
    for (const answer of [{}, { error: '' }, { error: 400 }, null, 'invalid_client']) {
      expect(oauthError(answer)).toBeUndefined();
    }
  });
});

describe('refreshMargin (ADR-0031)', () => {
  it('replaces a token before refreshBeforeMs remains, or half its lifetime when shorter', () => {
    expect(refreshMargin(3_600_000, 30_000)).toBe(30_000);
    expect(refreshMargin(20_000, 30_000)).toBe(10_000);
    expect(refreshMargin(60_000, 0)).toBe(0);
  });
});

describe('masking secrets (ADR-0031)', () => {
  it('shows each secret as ***, every time, the longest first', () => {
    expect(maskSecrets('token abc in abcdef and abc', ['abc', 'abcdef'])).toBe(
      'token *** in *** and ***',
    );
    expect(maskSecrets('nothing here', ['secret'])).toBe('nothing here');
    expect(maskSecrets('an empty secret masks nothing', [''])).toBe(
      'an empty secret masks nothing',
    );
  });

  it('masks every string of a JSON value, and keeps its shape', () => {
    expect(
      maskDeep(
        { error: 'HTTP 401 for tkn-123', list: ['tkn-123', 1, true, null], nested: { a: 'ok' } },
        ['tkn-123'],
      ),
    ).toEqual({ error: 'HTTP 401 for ***', list: ['***', 1, true, null], nested: { a: 'ok' } });
    const value = { a: 'tkn' };
    expect(maskDeep(value, [])).toBe(value);
  });
});
