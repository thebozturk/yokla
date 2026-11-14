// yokla's own model calls (ADR-0028), such as the simulated customer's: a
// chat completion from the model the configuration names, OpenAI-compatible
// or Anthropic. They go only to that model's url, never through the model
// proxy, which records the target's calls. The key is read from the
// environment and never written anywhere.

import { createHash } from 'node:crypto';
import type { CustomerPrompt, OwnModel } from '@yokla/core';
import { HttpClient, HttpError } from '../http/client.ts';

export interface OwnReply {
  readonly text: string;
  readonly model: string;
  readonly usage: { readonly input: number | null; readonly output: number | null };
  readonly durationMs: number;
}

export class ModelClientError extends Error {
  override readonly name = 'ModelClientError';
}

function field(value: unknown, ...path: (string | number)[]): unknown {
  let current = value;
  for (const key of path) {
    if (typeof current !== 'object' || current === null) return undefined;
    current = Reflect.get(current, key);
  }
  return current;
}

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

/** A provider seed from the sample's seed: a stable non-negative 31-bit integer. */
export function providerSeed(seed: string): number {
  return Number.parseInt(createHash('sha256').update(seed).digest('hex').slice(0, 8), 16) % 2 ** 31;
}

export class ModelClient {
  readonly #config: OwnModel;
  readonly #key: string | undefined;
  readonly #http: HttpClient;

  constructor(config: OwnModel, env: Readonly<Record<string, string | undefined>>) {
    this.#config = config;
    this.#key = config.apiKeyEnv === undefined ? undefined : env[config.apiKeyEnv];
    if (config.apiKeyEnv !== undefined && this.#key === undefined) {
      throw new ModelClientError(`environment variable ${config.apiKeyEnv} is not set`);
    }
    this.#http = new HttpClient({ allowedOrigins: [config.url], timeoutMs: config.timeoutMs });
  }

  /** The model's reply to a prompt. */
  async complete(prompt: CustomerPrompt, seed: string): Promise<OwnReply> {
    const config = this.#config;
    const base = config.url.replace(/\/$/u, '');
    const anthropic = config.kind === 'anthropic';
    const body = anthropic
      ? {
          model: config.model,
          system: prompt.system,
          messages: prompt.messages,
          max_tokens: config.maxTokens,
          temperature: config.temperature,
        }
      : {
          model: config.model,
          messages: [{ role: 'system', content: prompt.system }, ...prompt.messages],
          max_tokens: config.maxTokens,
          temperature: config.temperature,
          seed: providerSeed(seed),
        };
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (anthropic) {
      headers['anthropic-version'] = '2023-06-01';
      if (this.#key !== undefined) headers['x-api-key'] = this.#key;
    } else if (this.#key !== undefined) {
      headers['authorization'] = `Bearer ${this.#key}`;
    }
    let result;
    try {
      result = await this.#http.send({
        url: `${base}/${anthropic ? 'messages' : 'chat/completions'}`,
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new ModelClientError(
        error instanceof HttpError ? `${error.kind}: ${message}` : message,
      );
    }
    if (result.status < 200 || result.status > 299) {
      throw new ModelClientError(`the customer model answered ${String(result.status)}`);
    }
    const json = result.json;
    const content = field(json, 'content');
    const blocks: unknown[] = Array.isArray(content) ? content : [];
    const text = anthropic
      ? blocks
          .map((block) => (field(block, 'type') === 'text' ? field(block, 'text') : undefined))
          .filter((piece): piece is string => typeof piece === 'string')
          .join('')
      : field(json, 'choices', 0, 'message', 'content');
    if (typeof text !== 'string' || text.trim() === '') {
      throw new ModelClientError('the customer model answered with no text');
    }
    const input = count(field(json, 'usage', 'input_tokens'));
    const usage = anthropic
      ? {
          // Every input token, cached and cache-write ones included, as the proxy counts them.
          input:
            input === null
              ? null
              : input +
                (count(field(json, 'usage', 'cache_read_input_tokens')) ?? 0) +
                (count(field(json, 'usage', 'cache_creation_input_tokens')) ?? 0),
          output: count(field(json, 'usage', 'output_tokens')),
        }
      : {
          input: count(field(json, 'usage', 'prompt_tokens')),
          output: count(field(json, 'usage', 'completion_tokens')),
        };
    const model = field(json, 'model');
    return {
      text: text.trim(),
      model: typeof model === 'string' ? model : config.model,
      usage,
      durationMs: Math.round(result.latencyMs * 100) / 100,
    };
  }
}
