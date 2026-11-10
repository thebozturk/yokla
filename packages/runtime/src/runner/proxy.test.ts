import type { ProxyRecord } from '@yokla/core';
import { describe, expect, it } from 'vitest';
import { attributeCalls } from './proxy.ts';

function record(id: string, change: Partial<ProxyRecord> = {}): ProxyRecord {
  return {
    id,
    upstream: 'fake',
    kind: 'openai-compatible',
    method: 'POST',
    path: '/chat/completions',
    model: 'm',
    startedAt: '2026-11-10T12:00:00.000Z',
    durationMs: 5,
    status: 200,
    stream: false,
    usage: { input: 100, output: 20, cachedInput: null, cacheWrite: null, reasoning: null },
    trace: null,
    mark: null,
    ...change,
  };
}

const turns = [
  { key: 'a', tag: { id: 'turn-a' } },
  { key: 'b', tag: { id: 'turn-b' } },
];
const prices = { fake: { m: { input: 1, output: 10 } } };

describe('attributeCalls', () => {
  it('ties a call to the turn marked in flight when it started, in serial correlation', () => {
    const { byTurn, summary } = attributeCalls(
      [
        record('1', { mark: 'turn-a' }),
        record('2', { mark: 'turn-a', trace: 'turn-b' }),
        record('3', { mark: 'turn-b' }),
        record('4', { mark: null }),
        record('5', { mark: 'an-earlier-run' }),
        record('6', { mark: undefined }),
      ],
      turns,
      'serial',
      prices,
    );
    expect(byTurn.get('a')?.calls.map((call) => call.id)).toEqual(['1', '2']);
    expect(byTurn.get('b')?.calls.map((call) => call.id)).toEqual(['3']);
    expect(summary).toMatchObject({
      correlation: 'serial',
      records: 6,
      attributed: 3,
      unattributed: 3,
    });
    expect(byTurn.get('a')).not.toHaveProperty('trace');
  });

  it('ties a call to the turn whose trace it carried, in header correlation', () => {
    const { byTurn, summary } = attributeCalls(
      [
        record('1', { trace: 'turn-a', mark: 'turn-b' }),
        record('2', { trace: 'turn-b' }),
        record('3', { trace: null }),
        record('4', { trace: 'someone-else' }),
      ],
      turns,
      'header',
      prices,
    );
    expect(byTurn.get('a')).toMatchObject({ trace: 'turn-a', calls: [{ id: '1' }] });
    expect(byTurn.get('b')).toMatchObject({ trace: 'turn-b', calls: [{ id: '2' }] });
    expect(summary).toMatchObject({ attributed: 2, unattributed: 2 });
  });

  it('prices each call, and a turn costs null when any of its calls has no cost', () => {
    const { byTurn } = attributeCalls(
      [
        record('1', { mark: 'turn-a' }),
        record('2', { mark: 'turn-a', model: 'unpriced' }),
        record('3', { mark: 'turn-b' }),
      ],
      turns,
      'serial',
      prices,
    );
    // 100 input at 1 $/MTok and 20 output at 10 $/MTok: 0.0003 $.
    expect(byTurn.get('a')?.calls.map((call) => call.costUsd)).toEqual([0.0003, null]);
    expect(byTurn.get('a')?.costUsd).toBeNull();
    expect(byTurn.get('b')?.costUsd).toBeCloseTo(0.0003, 12);
  });

  it("keeps a call's fault on the turn", () => {
    const { byTurn } = attributeCalls(
      [
        record('1', { mark: 'turn-a', fault: { kind: 'status', applied: true } }),
        record('2', { mark: 'turn-a' }),
      ],
      turns,
      'serial',
      prices,
    );
    expect(byTurn.get('a')?.calls.map((call) => call.fault)).toEqual([
      { kind: 'status', applied: true },
      undefined,
    ]);
  });

  it('gives a turn without calls zero cost, a measurement, not a gap', () => {
    const { byTurn } = attributeCalls([], turns, 'serial', prices);
    expect(byTurn.get('a')).toEqual({ correlation: 'serial', calls: [], costUsd: 0 });
  });

  it('totals every recorded call, and counts the values it had to leave out', () => {
    const { summary } = attributeCalls(
      [
        record('1', { mark: 'turn-a' }),
        record('2', { model: 'unpriced' }),
        record('3', {
          mark: 'turn-b',
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
