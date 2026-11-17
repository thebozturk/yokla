// The rewrites of yokla run's model transforms (ADR-0059): one per message,
// asked of models.transform before the run, cached, and capped by the run's
// --max-cost with yokla's other own calls (ADR-0028). A rewrite that fails
// core's check is not sent: the message goes as written, and why is kept.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  callCost,
  checkRewrite,
  estimateTokens,
  transformPrompt,
  TRANSFORM_PROMPT_VERSION,
  type CustomerPrompt,
  type ModelTransform,
  type OwnModel,
  type RewriteAsk,
} from '@yokla/core';
import { ModelClient, type OwnReply } from './client.ts';

/** What makes a model's call: the model client, or a stand-in for it. */
export interface RewriteCaller {
  complete(prompt: CustomerPrompt, seed: string): Promise<OwnReply>;
}

/** One written message to rewrite, by the run's model kinds in order. */
export interface RewriteJob {
  /** The case's id and the turn's index. */
  readonly key: string;
  readonly message: string;
  readonly language: string;
  /** The profile's other language, for code-switch; undefined with one language. */
  readonly other: string | undefined;
  readonly keep: readonly string[];
  readonly kinds: readonly ModelTransform[];
}

export interface RewriteResult {
  /** The message to send: the last rewrite that passed its check, else as written. */
  readonly text: string;
  readonly changedBy: readonly ModelTransform[];
  /** Each kind that left the message as it was, and why. */
  readonly refused: readonly { readonly kind: ModelTransform; readonly why: string }[];
}

/** What the rewrites will take, before any is asked. */
export interface RewritePlan {
  readonly model: string;
  readonly url: string;
  readonly messages: number;
  /** The calls the cache can't answer, at most. */
  readonly calls: number;
  readonly cached: number;
  /** Each uncached call's prompt and its maxTokens at the model's price; null without one. */
  readonly upperUsd: number | null;
}

/** yokla's own spend over a run, shared with the customer's calls (ADR-0028). */
export interface OwnSpendCount {
  calls: number;
  cached: number;
  costUsd: number;
  unknown: boolean;
}

interface Cached {
  readonly text: string;
  readonly model: string;
}

function isCached(value: unknown): value is Cached {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof Reflect.get(value, 'text') === 'string' &&
    typeof Reflect.get(value, 'model') === 'string'
  );
}

export class Rewriter {
  readonly #model: OwnModel;
  readonly #cacheDir: string;
  readonly #caller: RewriteCaller;

  constructor(options: {
    readonly model: OwnModel;
    readonly env: Readonly<Record<string, string | undefined>>;
    readonly cacheDir: string;
    readonly caller?: RewriteCaller;
  }) {
    this.#model = options.model;
    this.#cacheDir = options.cacheDir;
    this.#caller = options.caller ?? new ModelClient(options.model, options.env, 'transform');
  }

  /** A rewrite's cache file: by the model's settings, the prompt's version and what is asked. */
  #path(ask: RewriteAsk): string {
    const model = this.#model;
    const key = createHash('sha256')
      .update(
        JSON.stringify([
          { kind: model.kind, url: model.url, model: model.model, temperature: model.temperature },
          TRANSFORM_PROMPT_VERSION,
          ask,
        ]),
      )
      .digest('hex');
    return join(this.#cacheDir, `${key}.json`);
  }

  #cached(ask: RewriteAsk): Cached | undefined {
    const path = this.#path(ask);
    if (!existsSync(path)) return undefined;
    try {
      const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
      return isCached(value) ? value : undefined;
    } catch {
      return undefined;
    }
  }

  static #ask(job: RewriteJob, kind: ModelTransform, message: string): RewriteAsk {
    return {
      kind,
      message,
      language: job.language,
      other: kind === 'code-switch' ? job.other : undefined,
      keep: job.keep,
    };
  }

  /** How many calls the rewrites take at most, and what they can cost, sending nothing. */
  plan(jobs: readonly RewriteJob[]): RewritePlan {
    let calls = 0;
    let cached = 0;
    let inputTokens = 0;
    for (const job of jobs) {
      let message = job.message;
      // Past a step the cache can't answer, the next step's message is unknown: it counts as a call.
      let known = true;
      for (const kind of job.kinds) {
        if (kind === 'code-switch' && job.other === undefined) continue;
        const ask = Rewriter.#ask(job, kind, message);
        const hit = known ? this.#cached(ask) : undefined;
        if (hit === undefined) {
          calls += 1;
          known = false;
          const prompt = transformPrompt(ask);
          inputTokens +=
            estimateTokens(prompt.system) + estimateTokens(prompt.messages[0]?.content ?? '');
          continue;
        }
        cached += 1;
        const checked = checkRewrite(message, hit.text, job.keep);
        if (checked.ok) message = checked.text;
      }
    }
    const { price } = this.#model;
    return {
      model: this.#model.model,
      url: this.#model.url,
      messages: jobs.length,
      calls,
      cached,
      // Each call's prompt, counted as ADR-0051 counts, and maxTokens of output.
      upperUsd:
        price === undefined
          ? null
          : (inputTokens * price.input + calls * this.#model.maxTokens * price.output) / 1_000_000,
    };
  }

  /** Each job's message as the kinds rewrite it, under the cap; spend counts every call. */
  async run(
    jobs: readonly RewriteJob[],
    spend: OwnSpendCount,
    maxCostUsd: number | undefined,
  ): Promise<Map<string, RewriteResult>> {
    const results = new Map<string, RewriteResult>();
    for (const job of jobs) {
      let text = job.message;
      const changedBy: ModelTransform[] = [];
      const refused: { kind: ModelTransform; why: string }[] = [];
      for (const kind of job.kinds) {
        if (kind === 'code-switch' && job.other === undefined) {
          refused.push({ kind, why: 'the profile has one language' });
          continue;
        }
        const ask = Rewriter.#ask(job, kind, text);
        let reply = this.#cached(ask)?.text;
        if (reply === undefined) {
          const capped = maxCostUsd !== undefined && (spend.unknown || spend.costUsd >= maxCostUsd);
          if (capped) {
            refused.push({ kind, why: 'the cost cap was reached' });
            continue;
          }
          const answer = await this.#caller.complete(transformPrompt(ask), job.key);
          spend.calls += 1;
          const cost = callCost(
            { ...answer.usage, cachedInput: null, cacheWrite: null, reasoning: null },
            this.#model.price,
          );
          if (cost === null) spend.unknown = true;
          else spend.costUsd += cost;
          if (answer.cut === true) {
            refused.push({ kind, why: 'the reply stopped at maxTokens' });
            continue;
          }
          reply = answer.text;
          mkdirSync(this.#cacheDir, { recursive: true });
          writeFileSync(
            this.#path(ask),
            `${JSON.stringify({ text: reply, model: answer.model })}\n`,
          );
        } else {
          spend.calls += 1;
          spend.cached += 1;
        }
        const checked = checkRewrite(text, reply, job.keep);
        if (checked.ok) {
          text = checked.text;
          changedBy.push(kind);
        } else {
          refused.push({ kind, why: checked.why });
        }
      }
      results.set(job.key, { text, changedBy, refused });
    }
    return results;
  }
}
