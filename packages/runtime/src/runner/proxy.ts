// Ties the model proxy's records of a run to its turns (ADR-0012) and totals
// them. serial: before each request the runner marks its turn as in flight on
// the proxy, and a call belongs to the turn marked when it started. header: a
// call belongs to the turn whose x-yokla-trace it carried. Neither needs a
// clock. Calls tied to no turn are counted as unattributed, never dropped.

import { createHash } from 'node:crypto';
import {
  callCost,
  type SpanCall,
  storeOutput,
  storePrompt,
  storeToolCalls,
  type PromptStorage,
  type ProxyRecord,
  type Results,
  type YoklaConfig,
} from '@yokla/core';

type TurnResult = Results['cases'][number]['samples'][number]['turns'][number];
export type TurnProxy = NonNullable<TurnResult['proxy']>;
export type RunProxy = NonNullable<Results['run']['proxy']>;
export type Correlation = RunProxy['correlation'];

/** What ties a turn's calls to it: the mark set while it was in flight, or the trace it sent. */
export interface TurnTag {
  readonly id: string;
  /** The W3C trace id the turn's traceparent carried, when spans are on (ADR-0029). */
  readonly traceId?: string;
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
      ...(record.prompt === undefined ? {} : { prompt: record.prompt }),
      ...(record.tools === undefined ? {} : { tools: record.tools }),
      ...(record.toolCalls === undefined ? {} : { toolCalls: record.toolCalls }),
      ...(record.output === undefined ? {} : { output: record.output }),
      ...(record.replay === undefined ? {} : { replay: record.replay }),
      ...(record.asked === undefined ? {} : { asked: record.asked }),
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

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * A turn's calls as the results keep them: the checks see the prompts' text,
 * the results only what the profile's `prompts.store` keeps (ADR-0015).
 */
export function storeTurnProxy(proxy: TurnProxy, storage: PromptStorage): TurnProxy {
  return {
    ...proxy,
    calls: proxy.calls.map((call) => ({
      ...call,
      ...(call.prompt === undefined ? {} : { prompt: storePrompt(call.prompt, storage, sha256) }),
      // Tool-call arguments are kept as prompt text is (ADR-0025).
      ...(call.toolCalls === undefined
        ? {}
        : { toolCalls: storeToolCalls(call.toolCalls, storage, sha256) }),
      // The model's answer text is kept as prompt text is (ADR-0033).
      ...(call.output === undefined ? {} : { output: storeOutput(call.output, storage, sha256) }),
    })),
  };
}

export type TurnSpans = NonNullable<TurnResult['spans']>;
export type RunSpans = NonNullable<Results['run']['spans']>;

/**
 * Ties the model calls OpenTelemetry spans showed to turns, by the trace id of
 * each turn's traceparent (ADR-0029), prices them by provider and model, and
 * totals them. A span of any other trace is unattributed, and counted.
 */
export function attributeSpans<K>(
  spans: readonly SpanCall[],
  turns: readonly { readonly key: K; readonly traceId: string }[],
  prices: YoklaConfig['prices'],
  settled: boolean,
): { byTurn: Map<K, TurnSpans>; summary: RunSpans } {
  const costed = spans
    .map((span) => ({
      span,
      costUsd: callCost(span.usage, prices[span.provider ?? '']?.[span.model ?? '']),
    }))
    .toSorted((a, b) => a.span.startedAt.localeCompare(b.span.startedAt));
  const owners = new Map(turns.map((turn) => [turn.traceId, turn.key]));
  const byTurn = new Map<K, TurnSpans>();
  let attributed = 0;
  for (const turn of turns) {
    const calls = costed
      .filter(({ span }) => span.traceId === turn.traceId)
      .map(({ span, costUsd }) => ({
        spanId: span.spanId,
        provider: span.provider,
        model: span.model,
        durationMs: span.durationMs,
        usage: span.usage,
        costUsd,
        error: span.error,
      }));
    attributed += calls.length;
    byTurn.set(turn.key, { calls, costUsd: sum(calls.map((call) => call.costUsd)) });
  }
  const totals: Record<string, number> = { calls: spans.length };
  const missing: Record<string, number> = {};
  const add = (name: string, value: number | null) => {
    if (value === null) missing[name] = (missing[name] ?? 0) + 1;
    else totals[name] = (totals[name] ?? 0) + value;
  };
  for (const { span, costUsd } of costed) {
    for (const [name, field] of Object.entries(TOTALS)) add(name, span.usage[field]);
    add('costUsd', costUsd);
  }
  return {
    byTurn,
    summary: {
      received: spans.length,
      attributed,
      unattributed: costed.filter(({ span }) => !owners.has(span.traceId)).length,
      totals,
      missing,
      settled,
    },
  };
}
