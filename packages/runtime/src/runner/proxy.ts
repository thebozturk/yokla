// Ties the model proxy's records of a run to its turns (ADR-0012) and totals
// them. serial: before each request the runner marks its turn as in flight on
// the proxy, and a call belongs to the turn marked when it started. header: a
// call belongs to the turn whose x-yokla-trace it carried. Neither needs a
// clock. Calls tied to no turn are counted as unattributed, never dropped.

import { callCost, type ProxyRecord, type Results, type YoklaConfig } from '@yokla/core';

type TurnResult = Results['cases'][number]['samples'][number]['turns'][number];
export type TurnProxy = NonNullable<TurnResult['proxy']>;
export type RunProxy = NonNullable<Results['run']['proxy']>;
export type Correlation = RunProxy['correlation'];

/** What ties a turn's calls to it: the mark set while it was in flight, or the trace it sent. */
export interface TurnTag {
  readonly id: string;
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
  turns: readonly { readonly key: K; readonly tag: TurnTag }[],
  correlation: Correlation,
  prices: YoklaConfig['prices'],
): { byTurn: Map<K, TurnProxy>; summary: RunProxy } {
  const costed = records.map((record) => ({
    record,
    costUsd: callCost(record.usage, prices[record.upstream]?.[record.model ?? '']),
  }));
  const byId = new Map(turns.map((turn) => [turn.tag.id, turn]));
  const owner = (record: ProxyRecord) => {
    const id = correlation === 'header' ? record.trace : record.mark;
    return id === null || id === undefined ? undefined : byId.get(id);
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
      ...(record.fault === undefined ? {} : { fault: record.fault }),
    });
  }

  const byTurn = new Map<K, TurnProxy>(
    turns.map((turn) => {
      const list = calls.get(turn.key) ?? [];
      return [
        turn.key,
        {
          correlation,
          ...(correlation === 'header' ? { trace: turn.tag.id } : {}),
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
