// yokla's own model calls (ADR-0028), such as the simulated customer's: a
// chat completion from the model the configuration names, OpenAI-compatible,
// Anthropic, or Gemini's native API (ADR-0032). They go only to that model's url, never through the model
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
  /** What the model is for, as errors name it: the customer, the analyzer. */
  readonly #role: string;

  constructor(
    config: OwnModel,
    env: Readonly<Record<string, string | undefined>>,
    role = 'customer',
  ) {
    this.#config = config;
    this.#role = role;
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
    const call =
      config.kind === 'anthropic'
        ? this.#anthropic(prompt)
        : config.kind === 'gemini'
          ? this.#gemini(prompt, seed)
          : this.#openAi(prompt, seed);
    let result;
    try {
      result = await this.#http.send({
        url: `${base}/${call.path}`,
        method: 'POST',
        headers: { 'content-type': 'application/json', ...call.headers },
        body: JSON.stringify(call.body),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new ModelClientError(
        error instanceof HttpError ? `${error.kind}: ${message}` : message,
      );
    }
    if (result.status < 200 || result.status > 299) {
      throw new ModelClientError(`the ${this.#role} model answered ${String(result.status)}`);
    }
    const read = call.read(result.json);
    if (typeof read.text !== 'string' || read.text.trim() === '') {
      throw new ModelClientError(`the ${this.#role} model answered with no text`);
    }
    const model = field(result.json, 'model') ?? field(result.json, 'modelVersion');
    return {
      text: read.text.trim(),
      model: typeof model === 'string' && model !== '' ? model : config.model,
      usage: read.usage,
      durationMs: Math.round(result.latencyMs * 100) / 100,
    };
  }

  #auth(header: string, value: (key: string) => string = (key) => key): Record<string, string> {
    return this.#key === undefined ? {} : { [header]: value(this.#key) };
  }

  #openAi(prompt: CustomerPrompt, seed: string): Call {
    const config = this.#config;
    return {
      path: 'chat/completions',
      headers: this.#auth('authorization', (key) => `Bearer ${key}`),
      body: {
        model: config.model,
        messages: [{ role: 'system', content: prompt.system }, ...prompt.messages],
        max_tokens: config.maxTokens,
        temperature: config.temperature,
        seed: providerSeed(seed),
      },
      read: (json) => ({
        text: field(json, 'choices', 0, 'message', 'content'),
        usage: {
          input: count(field(json, 'usage', 'prompt_tokens')),
          output: count(field(json, 'usage', 'completion_tokens')),
        },
      }),
    };
  }

  #anthropic(prompt: CustomerPrompt): Call {
    const config = this.#config;
    return {
      path: 'messages',
      headers: { 'anthropic-version': '2023-06-01', ...this.#auth('x-api-key') },
      body: {
        model: config.model,
        system: prompt.system,
        messages: prompt.messages,
        max_tokens: config.maxTokens,
        temperature: config.temperature,
      },
      read: (json) => {
        const content = field(json, 'content');
        const blocks: unknown[] = Array.isArray(content) ? content : [];
        const input = count(field(json, 'usage', 'input_tokens'));
        return {
          text: blocks
            .map((block) => (field(block, 'type') === 'text' ? field(block, 'text') : undefined))
            .filter((piece): piece is string => typeof piece === 'string')
            .join(''),
          usage: {
            // Every input token, cached and cache-write ones included, as the proxy counts them.
            input:
              input === null
                ? null
                : input +
                  (count(field(json, 'usage', 'cache_read_input_tokens')) ?? 0) +
                  (count(field(json, 'usage', 'cache_creation_input_tokens')) ?? 0),
            output: count(field(json, 'usage', 'output_tokens')),
          },
        };
      },
    };
  }

  /** Gemini's native API (ADR-0032), with the key as AI Studio or Vertex AI takes it. */
  #gemini(prompt: CustomerPrompt, seed: string): Call {
    const config = this.#config;
    return {
      path: `models/${encodeURIComponent(config.model)}:generateContent`,
      headers:
        config.auth === 'bearer'
          ? this.#auth('authorization', (key) => `Bearer ${key}`)
          : this.#auth('x-goog-api-key'),
      body: {
        systemInstruction: { parts: [{ text: prompt.system }] },
        contents: prompt.messages.map((message) => ({
          role: message.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: message.content }],
        })),
        generationConfig: {
          temperature: config.temperature,
          maxOutputTokens: config.maxTokens,
          seed: providerSeed(seed),
        },
      },
      read: (json) => {
        const parts = field(json, 'candidates', 0, 'content', 'parts');
        const list: unknown[] = Array.isArray(parts) ? parts : [];
        const usage = (name: string) => count(field(json, 'usageMetadata', name));
        const prompted = usage('promptTokenCount');
        const candidates = usage('candidatesTokenCount');
        const thoughts = usage('thoughtsTokenCount');
        return {
          // A thought summary is the model's thinking, not its reply.
          text: list
            .map((part) => (field(part, 'thought') === true ? undefined : field(part, 'text')))
            .filter((piece): piece is string => typeof piece === 'string')
            .join(''),
          usage: {
            input: prompted === null ? null : prompted + (usage('toolUsePromptTokenCount') ?? 0),
            // Thinking is billed as output, as the proxy counts it.
            output:
              candidates === null && thoughts === null ? null : (candidates ?? 0) + (thoughts ?? 0),
          },
        };
      },
    };
  }
}

/** One provider's request, and how its answer is read. */
interface Call {
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
  readonly read: (json: unknown) => { text: unknown; usage: OwnReply['usage'] };
}
