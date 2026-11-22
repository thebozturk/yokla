// The reply cache of yokla's own models (ADR-0028, ADR-0087): a reply is kept
// under the SHA-256 of what keyed its request, and read back as a call at no
// cost. The cache holds the target's answers: it lives in yokla-data/, out of
// version control.

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

/** Where the reply to a request keyed by `key` is kept. */
export function replyFile(cacheDir: string, key: string): string {
  return join(cacheDir, `${createHash('sha256').update(key).digest('hex')}.json`);
}

/** The cached reply in `file`, as its text and a call at no cost; undefined when none is. */
export function cachedReply(
  file: string,
): { readonly text: string; readonly call: OwnCall } | undefined {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
  if (!isReply(value)) return undefined;
  return {
    text: value.text,
    call: { model: value.model, durationMs: 0, usage: value.usage, costUsd: 0, cached: true },
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
  const costUsd = callCost(
    { ...reply.usage, cachedInput: null, cacheWrite: null, reasoning: null },
    price,
  );
  return {
    text: reply.text,
    call: {
      model: reply.model,
      durationMs: reply.durationMs,
      usage: reply.usage,
      costUsd,
      cached: false,
    },
  };
}
