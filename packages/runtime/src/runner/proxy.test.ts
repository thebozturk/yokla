import type { ProxyRecord } from '@yokla/core';
import { describe, expect, it } from 'vitest';
import { attributeCalls } from './proxy.ts';

const T0 = Date.parse('2026-11-10T12:00:00.000Z');

function record(id: string, atMs: number, change: Partial<ProxyRecord> = {}): ProxyRecord {
  return {
    id,
    upstream: 'fake',
    kind: 'openai-compatible',
    method: 'POST',
    path: '/chat/completions',
    model: 'm',
    startedAt: new Date(T0 + atMs).toISOString(),
    durationMs: 5,
    status: 200,
    stream: false,
    usage: { input: 100, output: 20, cachedInput: null, cacheWrite: null, reasoning: null },
    trace: null,
    ...change,
  };
}

const turns = [
  { key: 'a', window: { start: T0, end: T0 + 100, trace: 'trace-a' } },
  { key: 'b', window: { start: T0 + 200, end: T0 + 300, trace: 'trace-b' } },
];
const prices = { fake: { m: { input: 1, output: 10 } } };

describe('attributeCalls', () => {
  it('ties a call to the turn in flight when it started, in serial correlation', () => {
    const { byTurn, summary } = attributeCalls(
      [record('1', 0), record('2', 100), record('3', 250), record('4', 150), record('5', 301)],
      turns,
      'serial',
      prices,
    );
    expect(byTurn.get('a')?.calls.map((call) => call.id)).toEqual(['1', '2']);
    expect(byTurn.get('b')?.calls.map((call) => call.id)).toEqual(['3']);
    expect(summary).toMatchObject({
      correlation: 'serial',
      records: 5,
      attributed: 3,
      unattributed: 2,
    });
    expect(byTurn.get('a')).not.toHaveProperty('trace');
  });

  it('gives a call in the millisecond one turn ends and the next starts to the later turn', () => {
    const touching = [
      { key: 'a', window: { start: T0, end: T0 + 100, trace: undefined } },
      { key: 'b', window: { start: T0 + 100, end: T0 + 200, trace: undefined } },
    ];
    const { byTurn } = attributeCalls(
      [record('1', 100), record('2', 99)],
      touching,
      'serial',
      prices,
    );
    expect(byTurn.get('a')?.calls.map((call) => call.id)).toEqual(['2']);
    expect(byTurn.get('b')?.calls.map((call) => call.id)).toEqual(['1']);
  });

  it('ties a call to the turn whose trace it carried, in header correlation', () => {
    const { byTurn, summary } = attributeCalls(
      [
        record('1', 250, { trace: 'trace-a' }),
        record('2', 0, { trace: 'trace-b' }),
        record('3', 50, { trace: null }),
        record('4', 50, { trace: 'someone-else' }),
      ],
      turns,
      'header',
      prices,
    );
    expect(byTurn.get('a')).toMatchObject({ trace: 'trace-a', calls: [{ id: '1' }] });
    expect(byTurn.get('b')).toMatchObject({ trace: 'trace-b', calls: [{ id: '2' }] });
    expect(summary).toMatchObject({ attributed: 2, unattributed: 2 });
  });

  it('prices each call, and a turn costs null when any of its calls has no cost', () => {
    const { byTurn } = attributeCalls(
      [record('1', 0), record('2', 10, { model: 'unpriced' }), record('3', 210)],
      turns,
      'serial',
      prices,
    );
    // 100 input at 1 $/MTok and 20 output at 10 $/MTok: 0.0003 $.
    expect(byTurn.get('a')?.calls.map((call) => call.costUsd)).toEqual([0.0003, null]);
    expect(byTurn.get('a')?.costUsd).toBeNull();
    expect(byTurn.get('b')?.costUsd).toBeCloseTo(0.0003, 12);
  });

  it('gives a turn without calls zero cost, a measurement, not a gap', () => {
    const { byTurn } = attributeCalls([], turns, 'serial', prices);
    expect(byTurn.get('a')).toEqual({ correlation: 'serial', calls: [], costUsd: 0 });
  });

  it('totals every recorded call, and counts the values it had to leave out', () => {
    const { summary } = attributeCalls(
      [
        record('1', 0),
        record('2', 999, { model: 'unpriced' }),
        record('3', 210, {
          usage: { input: 50, output: null, cachedInput: 10, cacheWrite: null, reasoning: 0 },
        }),
      ],
      turns,
      'serial',
      prices,
    );
    expect(summary.totals).toEqual({
      calls: 3,
      inputTokens: 250,
      outputTokens: 40,
      cachedInputTokens: 10,
      reasoningTokens: 0,
      costUsd: 0.0003,
    });
    expect(summary.missing).toEqual({
      outputTokens: 1,
      cachedInputTokens: 2,
      cacheWriteTokens: 3,
      reasoningTokens: 2,
      costUsd: 2,
    });
  });
});
