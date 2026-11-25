// The reply cache of yokla's own models (ADR-0028, ADR-0087): a reply is kept
// under the SHA-256 of what keyed its request, and read back as a call at no
// cost. The cache holds the target's answers: it lives in yokla-data/, out of
// version control. A reply cut at maxTokens is never kept, and never read back
// (ADR-0099).

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { callCost, type OwnModel, type Results } from '@yokla/core';
import type { OwnReply } from './client.ts';

export type OwnCall = NonNullable<
  Results['cases'][number]['samples'][number]['customer']
>['calls'][number];

function isReply(value: unknown): value is OwnReply {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof Reflect.get(value, 'text') === 'string' &&
    typeof Reflect.get(value, 'model') === 'string'
  );
}

/** A role's message and the call it took; or why there is none, and the call (ADR-0099). */
export type OwnMessage =
  | { readonly text: string; readonly call: OwnCall }
  | { readonly why: string; readonly call: OwnCall };

/** Where the reply to a request keyed by `key` is kept. */
export function replyFile(cacheDir: string, key: string): string {
  return join(cacheDir, `${createHash('sha256').update(key).digest('hex')}.json`);
}

/**
 * The cached reply in `file`, as its text and a call at no cost; undefined
 * when none is, or when it was cut, as one kept before ADR-0099 may be.
 */
export function cachedReply(
  file: string,
): { readonly text: string; readonly call: OwnCall } | undefined {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
  if (!isReply(value) || value.cut === true) return undefined;
  return {
    text: value.text,
    call: { model: value.model, durationMs: 0, usage: value.usage, costUsd: 0, cached: true },
  };
}

/** The call a reply took, at its price. */
export function paidCall(reply: OwnReply, price: OwnModel['price']): OwnCall {
  return {
    model: reply.model,
    durationMs: reply.durationMs,
    usage: reply.usage,
    costUsd: callCost(
      { ...reply.usage, cachedInput: null, cacheWrite: null, reasoning: null },
      price,
    ),
    cached: false,
  };
}

/** Keeps a reply in `file`, and gives it as its text and the call it took, at its price. */
export function storedReply(
  file: string,
  reply: OwnReply,
  price: OwnModel['price'],
): { readonly text: string; readonly call: OwnCall } {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, `${JSON.stringify(reply)}\n`);
  return { text: reply.text, call: paidCall(reply, price) };
}

/** Why a role's reply cut at maxTokens is not used, and the setting to raise (ADR-0099). */
export function cutReason(role: 'customer' | 'attacker' | 'judge', maxTokens: number): string {
  return `the ${role}'s reply stopped at maxTokens (${String(maxTokens)}): raise models.${role}.maxTokens`;
}
