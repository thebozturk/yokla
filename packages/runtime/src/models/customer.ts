// The simulated customer's next message (ADR-0028): from the reply cache when
// the same request was answered before, else from the customer model. Each
// reply is cached under the SHA-256 of its request, so a rerun repeats every
// message while the target answers the same. The cache holds the target's
// answers: it lives in yokla-data/, out of version control.

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  callCost,
  customerCacheKey,
  customerPrompt,
  type CaseCustomer,
  type Exchanged,
  type OwnModel,
  type Results,
} from '@yokla/core';
import { ModelClient, type OwnReply } from './client.ts';

export type OwnCall = NonNullable<
  Results['cases'][number]['samples'][number]['customer']
>['calls'][number];

export interface CustomerOptions {
  readonly model: OwnModel;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Where cached replies are kept, e.g. <profile dir>/yokla-data/customer. */
  readonly cacheDir: string;
  /** Ask the model anew, whatever the cache holds; the new reply is cached. */
  readonly fresh?: boolean;
  /** Replaces the model client, for tests. */
  readonly client?: { complete: ModelClient['complete'] };
}

function isReply(value: unknown): value is OwnReply {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof Reflect.get(value, 'text') === 'string' &&
    typeof Reflect.get(value, 'model') === 'string'
  );
}

export class CustomerPlayer {
  readonly #options: CustomerOptions;
  readonly #client: { complete: ModelClient['complete'] };

  constructor(options: CustomerOptions) {
    this.#options = options;
    this.#client = options.client ?? new ModelClient(options.model, options.env);
  }

  /** The customer's next message after the exchanges so far, and the call it took. */
  async next(
    customer: CaseCustomer,
    language: string,
    seed: string,
    exchanges: readonly Exchanged[],
  ): Promise<{ readonly text: string; readonly call: OwnCall }> {
    const { model } = this.#options;
    const key = createHash('sha256')
      .update(customerCacheKey({ model, customer, language, seed, exchanges }))
      .digest('hex');
    const file = join(this.#options.cacheDir, `${key}.json`);
    if (this.#options.fresh !== true) {
      const cached = this.#read(file);
      if (cached !== undefined) {
        return {
          text: cached.text,
          call: {
            model: cached.model,
            durationMs: 0,
            usage: cached.usage,
            costUsd: 0,
            cached: true,
          },
        };
      }
    }
    const reply = await this.#client.complete(customerPrompt(customer, language, exchanges), seed);
    mkdirSync(this.#options.cacheDir, { recursive: true });
    writeFileSync(file, `${JSON.stringify(reply)}\n`);
    const costUsd = callCost(
      { ...reply.usage, cachedInput: null, cacheWrite: null, reasoning: null },
      model.price,
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

  #read(file: string): OwnReply | undefined {
    try {
      const value: unknown = JSON.parse(readFileSync(file, 'utf8'));
      return isReply(value) ? value : undefined;
    } catch {
      return undefined;
    }
  }
}
