// The judge's verdicts (ADR-0090): from the reply cache when the same
// dimension of the same message and answer was judged before, else from the
// judge model, as the simulated customer's replies are (ADR-0028). A rerun
// repeats every verdict while the target answers the same.

import {
  judgeCacheKey,
  judgePrompt,
  readVerdict,
  type JudgeRequest,
  type OwnModel,
  type Verdict,
} from '@yokla/core';
import { cachedReply, replyFile, storedReply, type OwnCall } from './cached.ts';
import { clientOnFirstCall, type ModelClient } from './client.ts';

export interface JudgeOptions {
  readonly model: OwnModel;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Where cached replies are kept, e.g. <profile dir>/yokla-data/judge. */
  readonly cacheDir: string;
  /** Ask the model anew, whatever the cache holds; the new reply is cached. */
  readonly fresh?: boolean;
  /** Replaces the model client, for tests. */
  readonly client?: { complete: ModelClient['complete'] };
}

export class JudgePlayer {
  readonly #options: JudgeOptions;
  readonly #client: { complete: ModelClient['complete'] };

  constructor(options: JudgeOptions) {
    this.#options = options;
    this.#client = options.client ?? clientOnFirstCall(options.model, options.env, 'judge');
  }

  /** The judge's verdict on a request, undefined when its reply can't be read, and the call. */
  async judge(
    request: JudgeRequest,
  ): Promise<{ readonly verdict: Verdict | undefined; readonly call: OwnCall }> {
    const { model } = this.#options;
    const file = replyFile(this.#options.cacheDir, judgeCacheKey({ model, request }));
    const cached = this.#options.fresh === true ? undefined : cachedReply(file);
    const reply =
      cached ??
      storedReply(
        file,
        await this.#client.complete(judgePrompt(request), request.dimension),
        model.price,
      );
    return { verdict: readVerdict(reply.text), call: reply.call };
  }
}
