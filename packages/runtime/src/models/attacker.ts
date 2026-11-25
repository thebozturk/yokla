// The attacker's next message (ADR-0087): from the reply cache when the same
// request was answered before, else from the attacker model, as the simulated
// customer's is (ADR-0028). A rerun repeats every message while the target
// answers the same. A reply cut at maxTokens is neither sent nor cached
// (ADR-0099).

import { attackerCacheKey, attackerPrompt, type AttackRequest, type OwnModel } from '@yokla/core';
import {
  cachedReply,
  cutReason,
  paidCall,
  replyFile,
  storedReply,
  type OwnMessage,
} from './cached.ts';
import { ModelClient } from './client.ts';

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

  /**
   * The attacker's message for a request about an attack, and the call it
   * took; or, for a reply cut at maxTokens, why there is none.
   */
  async next(
    attack: string,
    language: string,
    seed: string,
    request: AttackRequest,
  ): Promise<OwnMessage> {
    const { model } = this.#options;
    const file = replyFile(
      this.#options.cacheDir,
      attackerCacheKey({ model, attack, language, request, seed }),
    );
    const cached = this.#options.fresh === true ? undefined : cachedReply(file);
    if (cached !== undefined) return cached;
    const reply = await this.#client.complete(attackerPrompt(attack, language, request), seed);
    if (reply.cut === true) {
      return { why: cutReason('attacker', model.maxTokens), call: paidCall(reply, model.price) };
    }
    return storedReply(file, reply, model.price);
  }
}
