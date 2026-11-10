import { describe, expect, it } from 'vitest';
import type { ProfileTarget } from '../schema/profile.ts';
import {
  buildRequest,
  checkTemplates,
  mergeJson,
  TemplateError,
  type TemplateValues,
} from './build.ts';

type Request = ProfileTarget['request'];

const request = (change: Partial<Request> = {}): Request => ({
  url: 'http://127.0.0.1:3000/v1/chat',
  method: 'POST',
  timeoutMs: 30_000,
  body: { message: '{{message}}', sessionId: '{{session}}' },
  ...change,
});

const values = (change: Partial<TemplateValues> = {}): TemplateValues => ({
  message: 'Çadır var mı?',
  session: 's-1',
  requestId: undefined,
  carry: {},
  env: {},
  ...change,
});

function body(built: { body: string | undefined }): unknown {
  return built.body === undefined ? undefined : JSON.parse(built.body);
}

describe('buildRequest', () => {
  it('fills the body template and adds a JSON content type', () => {
    const built = buildRequest(request(), undefined, values());
    expect(built).toMatchObject({ url: 'http://127.0.0.1:3000/v1/chat', method: 'POST' });
    expect(built.headers).toEqual({ 'content-type': 'application/json' });
    expect(body(built)).toEqual({ message: 'Çadır var mı?', sessionId: 's-1' });
  });

  it('leaves out a carried value that does not exist yet, and keeps its type once it does', () => {
    const template = request({
      body: {
        message: '{{message}}',
        conversationId: '{{carry.conversationId}}',
        ids: ['{{carry.page}}', 'x'],
      },
    });
    expect(body(buildRequest(template, undefined, values()))).toEqual({
      message: 'Çadır var mı?',
      ids: ['x'],
    });
    expect(
      body(
        buildRequest(template, undefined, values({ carry: { conversationId: 'c-9', page: 2 } })),
      ),
    ).toEqual({ message: 'Çadır var mı?', conversationId: 'c-9', ids: [2, 'x'] });
  });

  it('treats a carried null as not there yet', () => {
    const template = request({ body: { conversationId: '{{carry.conversationId}}' } });
    expect(
      body(buildRequest(template, undefined, values({ carry: { conversationId: null } }))),
    ).toEqual({});
  });

  it('fails when a value is missing inside a longer string', () => {
    const template = request({ body: { note: 'conversation {{carry.conversationId}}' } });
    expect(() => buildRequest(template, undefined, values())).toThrow(TemplateError);
  });

  it('reads secrets from the environment and fails fast when one is missing', () => {
    const template = request({ headers: { Authorization: 'Bearer {{env.TARGET_TOKEN}}' } });
    expect(
      buildRequest(template, undefined, values({ env: { TARGET_TOKEN: 't0k' } })).headers,
    ).toMatchObject({
      authorization: 'Bearer t0k',
    });
    expect(() => buildRequest(template, undefined, values())).toThrow(/TARGET_TOKEN is not set/u);
  });

  it('rejects unknown placeholders', () => {
    expect(() => buildRequest(request({ body: { m: '{{mesage}}' } }), undefined, values())).toThrow(
      /unknown placeholder \{\{mesage\}\}/u,
    );
  });

  it('URL-encodes values in the url', () => {
    const built = buildRequest(
      request({ url: 'http://h/search?q={{message}}&s={{session}}', body: undefined }),
      undefined,
      values({ message: 'a&b ç' }),
    );
    expect(built.url).toBe('http://h/search?q=a%26b%20%C3%A7&s=s-1');
    expect(built.body).toBeUndefined();
    expect(built.headers).toEqual({});
  });

  it('refuses a header value with a line break', () => {
    const template = request({ headers: { 'x-echo': '{{message}}' } });
    expect(() => buildRequest(template, undefined, values({ message: 'a\r\nx-evil: 1' }))).toThrow(
      /line break/u,
    );
  });

  it('sends the request id header when configured', () => {
    const built = buildRequest(
      request({ requestId: { header: 'X-Request-Id' } }),
      undefined,
      values({ requestId: 'yokla-abc12345' }),
    );
    expect(built.headers['x-request-id']).toBe('yokla-abc12345');
  });

  it('lets turn headers and runtime headers override profile headers, ignoring case', () => {
    const built = buildRequest(
      request({
        headers: {
          'X-Device': 'profile',
          'X-Keep': 'k',
          'Content-Type': 'application/json; charset=utf-8',
        },
      }),
      { request: { headers: { 'x-device': 'turn' } } },
      values(),
      { 'X-Forwarded-For': '192.0.2.7' },
    );
    expect(built.headers).toEqual({
      'x-device': 'turn',
      'x-keep': 'k',
      'content-type': 'application/json; charset=utf-8',
      'x-forwarded-for': '192.0.2.7',
    });
  });

  it('merges a turn body into the profile body', () => {
    const template = request({
      body: { message: '{{message}}', context: { page: 'home', tags: ['a'] }, n: 1 },
    });
    const turn = { request: { body: { context: { viewed: 'P-1', tags: ['b'] }, n: 2 } } };
    expect(body(buildRequest(template, turn, values()))).toEqual({
      message: 'Çadır var mı?',
      context: { page: 'home', viewed: 'P-1', tags: ['b'] },
      n: 2,
    });
  });
});

describe('mergeJson', () => {
  it.each([
    [undefined, { a: 1 }, { a: 1 }],
    [{ a: 1 }, undefined, { a: 1 }],
    [{ a: { b: 1, c: 2 } }, { a: { c: 3 } }, { a: { b: 1, c: 3 } }],
    [{ a: [1, 2] }, { a: [3] }, { a: [3] }],
    [{ a: 1 }, 'x', 'x'],
    [{ a: { b: 1 } }, { a: null }, { a: null }],
  ])('%j + %j', (base, extra, expected) => {
    expect(mergeJson(base, extra)).toEqual(expected);
  });
});

const target = (change: Partial<ProfileTarget> = {}): ProfileTarget => ({
  name: 't',
  adapter: 'http',
  request: request(),
  response: { text: '$.answer' },
  session: { mode: 'client', carry: [] },
  cacheBypass: { kind: 'none' },
  ...change,
});

describe('checkTemplates', () => {
  it('accepts valid templates and lists the environment variables they read', () => {
    const check = checkTemplates(
      target({ request: request({ headers: { authorization: 'Bearer {{env.TOKEN}}' } }) }),
    );
    expect(check).toEqual({ issues: [], env: ['TOKEN'] });
  });

  it('reports placeholders that can never have a value', () => {
    const check = checkTemplates(
      target({
        session: { mode: 'none', carry: [] },
        request: request({
          body: {
            s: '{{session}}',
            r: '{{requestId}}',
            c: '{{carry.conversationId}}',
            u: '{{usr}}',
          },
        }),
      }),
    );
    expect(check.issues).toEqual([
      '{{session}} is used but the session mode is "none"',
      '{{requestId}} is used but request.requestId is not configured',
      '{{carry.conversationId}} is used but session.carry has no "conversationId"',
      'unknown placeholder {{usr}}',
    ]);
  });

  it('also checks turn requests from case files', () => {
    expect(checkTemplates(target(), [{ headers: { 'x-a': '{{env.A}}' } }]).env).toEqual(['A']);
  });
});
