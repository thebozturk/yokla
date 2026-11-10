// Ties the model proxy's records of a run to its turns (ADR-0012) and totals
// them. serial: a call belongs to the turn whose request was in flight when
// the call started, the later one at a shared millisecond. header: a call
// belongs to the turn whose x-yokla-trace it carried. Calls tied to no turn are
// counted as unattributed, never dropped.

import { callCost, type ProxyRecord, type Results, type YoklaConfig } from '@yokla/core';

type TurnResult = Results['cases'][number]['samples'][number]['turns'][number];
export type TurnProxy = NonNullable<TurnResult['proxy']>;
export type RunProxy = NonNullable<Results['run']['proxy']>;
export type Correlation = RunProxy['correlation'];

export interface TurnWindow {
  /** Wall-clock milliseconds, when the request was sent and answered. */
  readonly start: number;
  readonly end: number;
  readonly trace: string | undefined;
}

const TOTALS = {
  inputTokens: 'input',
  outputTokens: 'output',
  cachedInputTokens: 'cachedInput',
  cacheWriteTokens: 'cacheWrite',
  reasoningTokens: 'reasoning',
} as const;

function sum(values: readonly (number | null)[]): number | null {
  let total = 0;
  for (const value of values) {
    if (value === null) return null;
    total += value;
  }
  return total;
}

export function attributeCalls<K>(
  records: readonly ProxyRecord[],
  turns: readonly { readonly key: K; readonly window: TurnWindow }[],
  correlation: Correlation,
  prices: YoklaConfig['prices'],
): { byTurn: Map<K, TurnProxy>; summary: RunProxy } {
  const costed = records.map((record) => ({
    record,
    costUsd: callCost(record.usage, prices[record.upstream]?.[record.model ?? '']),
  }));
  const owner = (record: ProxyRecord) => {
    if (correlation === 'header') {
      // A record's trace is a string or null, so it never matches a turn without one.
      return turns.find((turn) => turn.window.trace === record.trace);
    }
    // Timestamps are in milliseconds, so one turn may end in the millisecond the
    // next one starts. A call there belongs to the later turn: a call of the
    // earlier one starts at least its own duration before that turn ends.
    const at = Date.parse(record.startedAt);
    let latest: (typeof turns)[number] | undefined;
    for (const turn of turns) {
      if (turn.window.start <= at && at <= turn.window.end) {
        if (latest === undefined || turn.window.start > latest.window.start) latest = turn;
      }
    }
    return latest;
  };

  const calls = new Map<K, TurnProxy['calls'][number][]>(turns.map((turn) => [turn.key, []]));
  let attributed = 0;
  for (const { record, costUsd } of costed) {
    const turn = owner(record);
    if (turn === undefined) continue;
    attributed += 1;
    calls.get(turn.key)?.push({
      id: record.id,
      upstream: record.upstream,
      model: record.model,
      status: record.status,
      durationMs: record.durationMs,
      stream: record.stream,
      usage: record.usage,
      costUsd,
    });
  }

  const byTurn = new Map<K, TurnProxy>(
    turns.map((turn) => {
      const list = calls.get(turn.key) ?? [];
      return [
        turn.key,
        {
          correlation,
          ...(correlation === 'header' && turn.window.trace !== undefined
            ? { trace: turn.window.trace }
            : {}),
          calls: list,
          costUsd: sum(list.map((call) => call.costUsd)),
        },
      ];
    }),
  );

  const totals: Record<string, number> = { calls: records.length };
  const missing: Record<string, number> = {};
  const add = (name: string, value: number | null) => {
    if (value === null) missing[name] = (missing[name] ?? 0) + 1;
    else totals[name] = (totals[name] ?? 0) + value;
  };
  for (const { record, costUsd } of costed) {
    for (const [name, field] of Object.entries(TOTALS)) add(name, record.usage[field]);
    add('costUsd', costUsd);
  }
  return {
    byTurn,
    summary: {
      correlation,
      records: records.length,
      attributed,
      unattributed: records.length - attributed,
      totals,
      missing,
    },
  };
}
