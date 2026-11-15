import { describe, expect, it } from 'vitest';
import { changeAnswer, errorBody } from './faults.ts';
import { geminiFacts } from './gemini.ts';
import { readPrompt } from './prompts.ts';
import { readOffered, readToolCalls } from './tools.ts';
import { readUsage } from './usage.ts';

const json = (value: unknown) => JSON.stringify(value);
const sse = (...events: unknown[]) =>
  events.map((event) => `data: ${json(event)}\r\n\r\n`).join('');

const USAGE = {
  promptTokenCount: 120,
  toolUsePromptTokenCount: 5,
  cachedContentTokenCount: 100,
  candidatesTokenCount: 30,
  thoughtsTokenCount: 12,
  totalTokenCount: 167,
};

const answer = (parts: unknown[], usage: unknown = USAGE, model = 'gemini-2.5-flash-001') => ({
  candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP' }],
  usageMetadata: usage,
  modelVersion: model,
});

describe('Gemini requests (ADR-0032)', () => {
  it('reads the model and the method from the path, on AI Studio and Vertex AI', () => {
    expect(geminiFacts('/v1beta/models/gemini-2.5-flash:generateContent')).toEqual({
      model: 'gemini-2.5-flash',
      stream: false,
    });
    expect(geminiFacts('/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse')).toEqual({
      model: 'gemini-2.5-flash',
      stream: true,
    });
    expect(
      geminiFacts(
        '/v1/projects/p-1/locations/global/publishers/google/models/gemini-2.5-pro:streamGenerateContent',
      ),
    ).toEqual({ model: 'gemini-2.5-pro', stream: true });
    expect(geminiFacts('/v1beta/models')).toEqual({ model: null, stream: false });
  });
});

describe('Gemini usage (ADR-0032)', () => {
  it('counts every token billed as input or output, thinking as output and as reasoning', () => {
    expect(readUsage('gemini', json(answer([{ text: 'Merhaba' }])), false)).toEqual({
      usage: { input: 125, output: 42, cachedInput: 100, cacheWrite: null, reasoning: 12 },
      model: 'gemini-2.5-flash-001',
    });
  });

  it('leaves a count the answer does not give null, never 0', () => {
    expect(
      readUsage(
        'gemini',
        json(answer([], { promptTokenCount: 10, candidatesTokenCount: 4 })),
        false,
      ).usage,
    ).toEqual({ input: 10, output: 4, cachedInput: null, cacheWrite: null, reasoning: null });
    expect(readUsage('gemini', json(answer([], { thoughtsTokenCount: 9 })), false).usage).toEqual({
      input: null,
      output: 9,
      cachedInput: null,
      cacheWrite: null,
      reasoning: 9,
    });
    expect(readUsage('gemini', json(answer([], {})), false).usage).toEqual({
      input: null,
      output: null,
      cachedInput: null,
      cacheWrite: null,
      reasoning: null,
    });
    expect(readUsage('gemini', json({ error: { code: 400 } }), false)).toEqual({
      usage: { input: null, output: null, cachedInput: null, cacheWrite: null, reasoning: null },
      model: null,
    });
  });

  it('reads a stream, as events or a JSON array, by its last usage', () => {
    const first = answer([{ text: 'Mer' }], { promptTokenCount: 120 });
    const last = answer([{ text: 'haba' }], { promptTokenCount: 120, candidatesTokenCount: 8 });
    const expected = {
      usage: { input: 120, output: 8, cachedInput: null, cacheWrite: null, reasoning: null },
      model: 'gemini-2.5-flash-001',
    };
    expect(readUsage('gemini', sse(first, last), true)).toEqual(expected);
    expect(readUsage('gemini', json([first, last]), true)).toEqual(expected);
    expect(readUsage('gemini', 'not json', false).model).toBeNull();
  });
});

describe('Gemini tools (ADR-0032)', () => {
  const declared = json({
    contents: [],
    tools: [
      { functionDeclarations: [{ name: 'search_products' }, { name: 'get_policy' }] },
      { googleSearch: {} },
    ],
  });

  it('reads the tools a request offers: declared functions, and built-in tools by name', () => {
    expect(readOffered('gemini', declared)).toEqual([
      'search_products',
      'get_policy',
      'googleSearch',
    ]);
    expect(readOffered('gemini', json({ contents: [] }))).toEqual([]);
  });

  it('reads the functionCall parts an answer asks for, its args as JSON text', () => {
    const asked = answer([
      { text: 'Bakıyorum.' },
      { functionCall: { name: 'search_products', args: { query: 'çadır', maxPrice: 3000 } } },
      { functionCall: { name: 'get_policy', args: {} } },
    ]);
    const calls = [
      { name: 'search_products', arguments: '{"query":"çadır","maxPrice":3000}' },
      { name: 'get_policy', arguments: '{}' },
    ];
    expect(readToolCalls('gemini', json(asked), false, 200)).toEqual(calls);
    expect(readToolCalls('gemini', sse(answer([{ text: 'x' }]), asked), true, 200)).toEqual(calls);
    expect(readToolCalls('gemini', json([asked]), true, 200)).toEqual(calls);
    expect(readToolCalls('gemini', json(answer([{ text: 'x' }])), false, 200)).toEqual([]);
    expect(readToolCalls('gemini', '{', false, 200)).toBeNull();
    expect(readToolCalls('gemini', json(asked), false, 500)).toEqual([]);
  });
});

describe('Gemini prompts (ADR-0032)', () => {
  it('reads the system instruction, the turns, a function call and its response', () => {
    const body = json({
      systemInstruction: { parts: [{ text: 'demo-shop:interpret' }, { text: 'Talimatlar' }] },
      contents: [
        { role: 'user', parts: [{ text: 'Çadır var mı?' }, { inlineData: { data: 'AAA' } }] },
        {
          role: 'model',
          parts: [{ functionCall: { name: 'search_products', args: { query: 'çadır' } } }],
        },
        {
          role: 'user',
          parts: [
            {
              functionResponse: { name: 'search_products', response: { results: [{ id: 'T1' }] } },
            },
          ],
        },
      ],
    });
    expect(readPrompt('gemini', '/v1beta/models/m:generateContent', body)).toEqual([
      { role: 'system', chars: 30, text: 'demo-shop:interpret\nTalimatlar' },
      { role: 'user', chars: 13, text: 'Çadır var mı?' },
      { role: 'assistant', chars: 17, text: '{"query":"çadır"}' },
      {
        role: 'tool',
        chars: 25,
        text: '{"results":[{"id":"T1"}]}',
        tool: 'search_products',
      },
    ]);
    // A system instruction given as text, as some clients send it.
    expect(readPrompt('gemini', '', json({ systemInstruction: 'Kısa yaz', contents: [] }))).toEqual(
      [{ role: 'system', chars: 8, text: 'Kısa yaz' }],
    );
  });

  it('reads what embeddings send as input, and says when it can not read a body', () => {
    expect(readPrompt('gemini', '', json({ content: { parts: [{ text: 'çadır' }] } }))).toEqual([
      { role: 'input', chars: 5, text: 'çadır' },
    ]);
    expect(
      readPrompt(
        'gemini',
        '',
        json({
          requests: [
            { content: { parts: [{ text: 'a' }] } },
            { content: { parts: [{ text: 'bc' }] } },
          ],
        }),
      ),
    ).toEqual([
      { role: 'input', chars: 1, text: 'a' },
      { role: 'input', chars: 2, text: 'bc' },
    ]);
    expect(readPrompt('gemini', '', json({ messages: [] }))).toBeNull();
    expect(readPrompt('gemini', '', json({ contents: ['x'] }))).toBeNull();
  });
});

describe('Gemini faults (ADR-0032)', () => {
  it('answers an injected status with Gemini’s error body', () => {
    expect(JSON.parse(errorBody('gemini', 429))).toEqual({
      error: {
        code: 429,
        message: 'the model proxy injected a 429 (a yokla fault)',
        status: 'RESOURCE_EXHAUSTED',
      },
    });
    expect(JSON.parse(errorBody('gemini', 500))).toMatchObject({ error: { status: 'INTERNAL' } });
    expect(JSON.parse(errorBody('gemini', 503))).toMatchObject({
      error: { status: 'UNAVAILABLE' },
    });
  });

  it('empties the text of the candidates, in an answer, events or a JSON array', () => {
    const one = answer([{ text: 'Merhaba' }, { functionCall: { name: 't', args: {} } }]);
    const changed = changeAnswer({ kind: 'empty-content' }, 'gemini', json(one), false);
    expect(changed.applied).toBe(true);
    expect(JSON.parse(changed.body)).toEqual(
      answer([{ text: '' }, { functionCall: { name: 't', args: {} } }]),
    );
    const events = changeAnswer(
      { kind: 'empty-content' },
      'gemini',
      sse(one, answer([{ text: 'x' }])),
      true,
    );
    expect(events.applied).toBe(true);
    expect(events.body).not.toContain('Merhaba');
    const array = changeAnswer({ kind: 'empty-content' }, 'gemini', json([one]), true);
    expect(array.applied).toBe(true);
    expect(JSON.parse(array.body)).toEqual([JSON.parse(changed.body)]);
    expect(
      changeAnswer({ kind: 'empty-content' }, 'gemini', json(answer([{ text: '' }])), false)
        .applied,
    ).toBe(false);
    expect(
      changeAnswer({ kind: 'empty-content' }, 'gemini', json([answer([])]), true).applied,
    ).toBe(false);
  });

  it('breaks the args of each function call, and reads them back as invalid', () => {
    const asked = answer([{ functionCall: { name: 'search_products', args: { query: 'x' } } }]);
    const broken = changeAnswer({ kind: 'invalid-tool-call' }, 'gemini', json(asked), false);
    expect(broken.applied).toBe(true);
    expect(readToolCalls('gemini', broken.body, false, 200)).toEqual([
      { name: 'search_products', arguments: '{"broken": ' },
    ]);
    expect(
      changeAnswer({ kind: 'invalid-tool-call' }, 'gemini', json(answer([{ text: 'x' }])), false)
        .applied,
    ).toBe(false);
  });
});
