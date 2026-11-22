// The attacker's next message (ADR-0087): from the reply cache when the same
// request was answered before, else from the attacker model, as the simulated
// customer's is (ADR-0028). A rerun repeats every message while the target
// answers the same.

import { attackerCacheKey, attackerPrompt, type AttackRequest, type OwnModel } from '@yokla/core';
import { cachedReply, replyFile, storedReply, type OwnCall } from './cached.ts';
import { ModelClient, ModelClientError } from './client.ts';

export interface AttackerOptions {
  readonly model: OwnModel;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Where cached replies are kept, e.g. <profile dir>/yokla-data/attacker. */
  readonly cacheDir: string;
  /** Ask the model anew, whatever the cache holds; the new reply is cached. */
  readonly fresh?: boolean;
  /** Replaces the model client, for tests. */
  readonly client?: { complete: ModelClient['complete'] };
}

export class AttackerPlayer {
  readonly #options: AttackerOptions;
  readonly #client: { complete: ModelClient['complete'] };

  constructor(options: AttackerOptions) {
    this.#options = options;
    this.#client = options.client ?? new ModelClient(options.model, options.env, 'attacker');
  }

  /** The attacker's message for a request about an attack, and the call it took. */
  async next(
    attack: string,
    language: string,
    seed: string,
    request: AttackRequest,
  ): Promise<{ readonly text: string; readonly call: OwnCall }> {
    const { model } = this.#options;
    const file = replyFile(
      this.#options.cacheDir,
      attackerCacheKey({ model, attack, language, request, seed }),
    );
    const cached = this.#options.fresh === true ? undefined : cachedReply(file);
    if (cached !== undefined) return cached;
    const reply = await this.#client.complete(attackerPrompt(attack, language, request), seed);
    // A reply cut at maxTokens may be empty; a message to send can't be (ADR-0051).
    if (reply.text === '') throw new ModelClientError('the attacker model answered with no text');
    return storedReply(file, reply, model.price);
  }
}
