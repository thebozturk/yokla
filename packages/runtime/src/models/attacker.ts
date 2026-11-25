// The attacker's next message (ADR-0087): from the reply cache when the same
// request was answered before, else from the attacker model, as the simulated
// customer's is (ADR-0028). A rerun repeats every message while the target
// answers the same. A reply cut at maxTokens is neither sent nor cached
// (ADR-0099); a reply with no message between its tags is cached and not
// sent (ADR-0101).

import {
  attackerCacheKey,
  attackerMessage,
  attackerPrompt,
  type AttackRequest,
  type OwnModel,
} from '@yokla/core';
import {
  cachedReply,
  cutReason,
  paidCall,
  replyFile,
  storedReply,
  type OwnCall,
  type OwnMessage,
} from './cached.ts';
import { ModelClient } from './client.ts';

/** Why an attacker's reply isn't sent when it holds no message (ADR-0101). */
export const NO_MESSAGE = 'the attacker wrote no message';

/**
 * The attacker's message and its call; for a cut reply, why it is an error
 * (ADR-0099); for a reply with no message, why it isn't sent (ADR-0101).
 */
export type AttackerMessage = OwnMessage | { readonly unsent: string; readonly call: OwnCall };

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
  ): Promise<AttackerMessage> {
    const { model } = this.#options;
    const file = replyFile(
      this.#options.cacheDir,
      attackerCacheKey({ model, attack, language, request, seed }),
    );
    let reply = this.#options.fresh === true ? undefined : cachedReply(file);
    if (reply === undefined) {
      const answered = await this.#client.complete(attackerPrompt(attack, language, request), seed);
      if (answered.cut === true) {
        return {
          why: cutReason('attacker', model.maxTokens),
          call: paidCall(answered, model.price),
        };
      }
      reply = storedReply(file, answered, model.price);
    }
    // Only the text between the tags is sent: a refusal or a note has none (ADR-0101).
    const message = attackerMessage(reply.text);
    return message === undefined
      ? { unsent: NO_MESSAGE, call: reply.call }
      : { text: message, call: reply.call };
  }
}
