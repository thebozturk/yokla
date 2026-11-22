// The simulated customer's next message (ADR-0028): from the reply cache when
// the same request was answered before, else from the customer model. Each
// reply is cached under the SHA-256 of its request, so a rerun repeats every
// message while the target answers the same.

import {
  customerCacheKey,
  customerPrompt,
  type CaseCustomer,
  type Exchanged,
  type OwnModel,
} from '@yokla/core';
import { cachedReply, replyFile, storedReply, type OwnCall } from './cached.ts';
import { ModelClient, ModelClientError } from './client.ts';

export type { OwnCall } from './cached.ts';

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
    const file = replyFile(
      this.#options.cacheDir,
      customerCacheKey({ model, customer, language, seed, exchanges }),
    );
    const cached = this.#options.fresh === true ? undefined : cachedReply(file);
    if (cached !== undefined) return cached;
    const reply = await this.#client.complete(customerPrompt(customer, language, exchanges), seed);
    // A reply cut at maxTokens may be empty; a customer's turn can't be (ADR-0051).
    if (reply.text === '') throw new ModelClientError('the customer model answered with no text');
    return storedReply(file, reply, model.price);
  }
}
