import { FaultPlan } from '@yokla/core';
import { describe, expect, it } from 'vitest';
import {
  armTurn,
  changeAnswer,
  errorBody,
  isChanging,
  jitter,
  jitterSeed,
  nextFault,
} from './faults.ts';

const plan = (value: unknown) => FaultPlan.parse(value);
const json = (value: unknown) => JSON.stringify(value);

describe('nextFault', () => {
  it('applies a plan to every call by default, and only to the listed calls when given', () => {
    const always = armTurn([plan({ fault: { kind: 'malformed-json' } })]);
    expect([nextFault(always, 'a'), nextFault(always, 'a')]).toEqual([
      { kind: 'malformed-json' },
      { kind: 'malformed-json' },
    ]);
    const second = armTurn([plan({ fault: { kind: 'empty-content' }, calls: [2] })]);
    expect([nextFault(second, 'a'), nextFault(second, 'a'), nextFault(second, 'a')]).toEqual([
      undefined,
      { kind: 'empty-content' },
      undefined,
    ]);
  });

  it('counts calls per plan among the upstreams it names, and the first matching plan wins', () => {
    const turn = armTurn([
      plan({ fault: { kind: 'status', status: 503 }, upstream: 'b', calls: [1] }),
      plan({ fault: { kind: 'empty-content' } }),
    ]);
    expect(nextFault(turn, 'a')).toEqual({ kind: 'empty-content' });
    expect(nextFault(turn, 'b')).toEqual({ kind: 'status', status: 503 });
    expect(nextFault(turn, 'b')).toEqual({ kind: 'empty-content' });
    expect(armTurn([]).matched).toEqual([]);
  });
});

describe('jitterSeed', () => {
  it("prefers the armed seed to the turn id, then adds the upstream and each plan's call count", () => {
    const seeded = armTurn([plan({ fault: { kind: 'latency', ms: 1 } })], 'case-a|1|2');
    nextFault(seeded, 'openai');
    expect(jitterSeed(seeded, 'random-turn-id', 'openai')).toBe('case-a|1|2|openai|1');
    expect(jitterSeed(seeded, 'another-turn-id', 'openai')).toBe('case-a|1|2|openai|1');
    nextFault(seeded, 'openai');
    expect(jitterSeed(seeded, 'random-turn-id', 'anthropic')).toBe('case-a|1|2|anthropic|2');
  });

  it('falls back to the turn id for a turn armed without a seed, or not armed', () => {
    const unseeded = armTurn([plan({ fault: { kind: 'latency', ms: 1 } })]);
    expect(jitterSeed(unseeded, 'turn-1', 'openai')).toBe('turn-1|openai|0');
    expect(jitterSeed(undefined, 'turn-1', 'openai')).toBe('turn-1|openai|');
    expect(jitterSeed(undefined, null, 'openai')).toBe('|openai|');
  });
});

describe('jitter', () => {
  it('is the same for the same seed, within 0 and max, and spreads over seeds', () => {
    expect(jitter('turn-1|a|1', 500)).toBe(jitter('turn-1|a|1', 500));
    const values = Array.from({ length: 200 }, (_v, i) => jitter(`seed-${String(i)}`, 1000));
    expect(values.every((value) => value >= 0 && value <= 1000)).toBe(true);
    expect(new Set(values).size).toBeGreaterThan(100);
    expect(Math.min(...values)).toBeLessThan(200);
    expect(Math.max(...values)).toBeGreaterThan(800);
    expect(jitter('x', 0)).toBe(0);
  });
});

describe('errorBody', () => {
  it('has the shape of each provider error', () => {
    expect(JSON.parse(errorBody('openai-compatible', 429))).toMatchObject({
      error: { type: 'rate_limit_exceeded', code: null },
    });
    expect(JSON.parse(errorBody('openai-compatible', 503))).toMatchObject({
      error: { type: 'server_error' },
    });
    expect(JSON.parse(errorBody('anthropic', 503))).toMatchObject({
      type: 'error',
      error: { type: 'overloaded_error' },
    });
    expect(JSON.parse(errorBody('anthropic', 429))).toMatchObject({
      error: { type: 'rate_limit_error' },
    });
    expect(JSON.parse(errorBody('anthropic', 500))).toMatchObject({ error: { type: 'api_error' } });
  });
});

describe('changeAnswer', () => {
  const chat = json({
    choices: [{ message: { role: 'assistant', content: 'Merhaba' } }],
    usage: {},
  });
  const stream = [
    'data: {"choices":[{"delta":{"content":"Mer"}}]}',
    'data: {"choices":[{"delta":{"content":"haba"}}]}',
    'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2}}',
    'data: [DONE]',
  ].join('\n\n');

  it('cuts a JSON body in half, which no longer parses', () => {
    const changed = changeAnswer('malformed-json', 'openai-compatible', chat, false);
    expect(changed.applied).toBe(true);
    expect(changed.body).toBe(chat.slice(0, Math.floor(chat.length / 2)));
    expect(() => {
      JSON.parse(changed.body);
    }).toThrow(SyntaxError);
    expect(changeAnswer('malformed-json', 'openai-compatible', stream, true).applied).toBe(false);
  });

  it('keeps the first half of a stream and drops its end', () => {
    const changed = changeAnswer('truncated-stream', 'openai-compatible', stream, true);
    expect(changed).toEqual({
      body: 'data: {"choices":[{"delta":{"content":"Mer"}}]}\n\ndata: {"choices":[{"delta":{"content":"haba"}}]}\n\n',
      applied: true,
    });
    expect(changeAnswer('truncated-stream', 'openai-compatible', chat, false).applied).toBe(false);
  });

  it('empties every text part, in JSON and in streams, for both protocols', () => {
    const empty = changeAnswer('empty-content', 'openai-compatible', chat, false);
    expect(JSON.parse(empty.body)).toMatchObject({ choices: [{ message: { content: '' } }] });
    const emptied = changeAnswer('empty-content', 'openai-compatible', stream, true);
    expect(emptied.applied).toBe(true);
    expect(emptied.body).not.toMatch(/Mer|haba/u);
    expect(emptied.body).toContain('"usage":{"prompt_tokens":3');
    const message = json({
      content: [
        { type: 'text', text: 'Hi' },
        { type: 'tool_use', input: {} },
      ],
    });
    expect(
      JSON.parse(changeAnswer('empty-content', 'anthropic', message, false).body),
    ).toMatchObject({
      content: [{ type: 'text', text: '' }, { type: 'tool_use' }],
    });
    const anthropicStream =
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"Hi"}}\n\n';
    const changed = changeAnswer('empty-content', 'anthropic', anthropicStream, true);
    expect(changed.body).toBe(
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":""}}\n\n',
    );
    const responses = json({
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'x' }] }],
    });
    expect(changeAnswer('empty-content', 'openai-compatible', responses, false).body).toContain(
      '"text":""',
    );
    const already = json({ choices: [{ message: { content: '' } }] });
    expect(changeAnswer('empty-content', 'openai-compatible', already, false).applied).toBe(false);
  });

  it('breaks tool-call arguments, and says when there were none', () => {
    const tools = json({
      choices: [
        { message: { tool_calls: [{ function: { name: 'search', arguments: '{"q":"x"}' } }] } },
      ],
    });
    const broken = changeAnswer('invalid-tool-call', 'openai-compatible', tools, false);
    expect(broken.applied).toBe(true);
    // The arguments are a string that is not JSON any more.
    expect(broken.body).toContain('"arguments":"{\\"broken\\": "');
    const anthropic = json({ content: [{ type: 'tool_use', name: 'search', input: { q: 'x' } }] });
    expect(
      JSON.parse(changeAnswer('invalid-tool-call', 'anthropic', anthropic, false).body),
    ).toMatchObject({
      content: [{ input: '{"broken": ' }],
    });
    const call = json({ output: [{ type: 'function_call', arguments: '{}' }] });
    expect(changeAnswer('invalid-tool-call', 'openai-compatible', call, false).applied).toBe(true);
    expect(changeAnswer('invalid-tool-call', 'openai-compatible', chat, false)).toEqual({
      body: chat,
      applied: false,
    });
    expect(changeAnswer('invalid-tool-call', 'openai-compatible', stream, true).applied).toBe(
      false,
    );
  });

  it('leaves a body it cannot read as it is', () => {
    for (const fault of ['empty-content', 'invalid-tool-call'] as const) {
      expect(changeAnswer(fault, 'openai-compatible', 'not json', false)).toEqual({
        body: 'not json',
        applied: false,
      });
    }
    expect(isChanging('status')).toBe(false);
    expect(isChanging('truncated-stream')).toBe(true);
  });
});
