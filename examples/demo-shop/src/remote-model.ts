// The demo-shop's model over HTTP: both calls of a turn go to an
// OpenAI-compatible chat completions endpoint, such as the fake provider or a
// model proxy in front of it. The request carries the app's own key, and the
// trace id of the turn when there is one. It retries once after a 429 or 503,
// gives up after a timeout, and refuses empty output: the app then falls back.

import type {
  AnswerDraft,
  ChatModel,
  ConversationContext,
  Interpretation,
  ModelCall,
} from './model.ts';
import type { Defect } from './defects.ts';
import { isInterpretation } from './wire.ts';

export interface RemoteModelOptions {
  /** How long a model call may take, unless the no-model-timeout defect is on. Default 3 s. */
  readonly timeoutMs?: number;
  readonly defect?: Defect | null;
  /** The provider base URL, e.g. http://127.0.0.1:8787/fake/v1. */
  readonly url: string;
  readonly key: string;
  readonly model?: string;
  /** Ask for a server-sent event stream, with usage in its last chunk. */
  readonly stream?: boolean;
}

/** The system message names the job, so a provider can tell the two calls apart. */
export const ROLES = { interpret: 'demo-shop:interpret', write: 'demo-shop:write' } as const;

function contentOf(body: unknown): string {
  const choices: unknown =
    typeof body === 'object' && body !== null ? Reflect.get(body, 'choices') : undefined;
  const first: unknown = Array.isArray(choices) ? choices[0] : undefined;
  const message: unknown =
    typeof first === 'object' && first !== null ? Reflect.get(first, 'message') : undefined;
  const content: unknown =
    typeof message === 'object' && message !== null ? Reflect.get(message, 'content') : undefined;
  if (typeof content !== 'string') throw new Error('the model answered without content');
  return content;
}

/** The text of a chat completions event stream. */
function streamed(text: string): string {
  let content = '';
  for (const line of text.split('\n')) {
    if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
    const chunk: unknown = JSON.parse(line.slice(6));
    const choices: unknown =
      typeof chunk === 'object' && chunk !== null ? Reflect.get(chunk, 'choices') : undefined;
    const first: unknown = Array.isArray(choices) ? choices[0] : undefined;
    const delta: unknown =
      typeof first === 'object' && first !== null ? Reflect.get(first, 'delta') : undefined;
    const piece: unknown =
      typeof delta === 'object' && delta !== null ? Reflect.get(delta, 'content') : undefined;
    if (typeof piece === 'string') content += piece;
  }
  return content;
}

export class RemoteModel implements ChatModel {
  readonly #options: RemoteModelOptions;

  constructor(options: RemoteModelOptions) {
    this.#options = options;
  }

  async #send(body: string, call: ModelCall | undefined): Promise<Response> {
    const timeout =
      this.#options.defect === 'no-model-timeout' ? undefined : (this.#options.timeoutMs ?? 3_000);
    return fetch(`${this.#options.url.replace(/\/$/u, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.#options.key}`,
        ...(call?.trace === undefined ? {} : { 'x-yokla-trace': call.trace }),
      },
      body,
      ...(timeout === undefined ? {} : { signal: AbortSignal.timeout(timeout) }),
    });
  }

  async #complete(role: string, payload: unknown, call: ModelCall | undefined): Promise<string> {
    const stream = this.#options.stream === true;
    const body = JSON.stringify({
      model: this.#options.model ?? 'demo-writer-1',
      messages: [
        { role: 'system', content: role },
        { role: 'user', content: JSON.stringify(payload) },
      ],
      ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}),
    });
    let response = await this.#send(body, call);
    if (response.status === 429 || response.status === 503) {
      // One retry, after the wait the provider asks for, capped at 2 s.
      const seconds = Number(response.headers.get('retry-after') ?? '1');
      await response.body?.cancel();
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(2_000, Math.max(0, seconds * 1000))),
      );
      response = await this.#send(body, call);
    }
    if (!response.ok) throw new Error(`the model answered ${String(response.status)}`);
    const content = stream ? streamed(await response.text()) : contentOf(await response.json());
    if (content.trim() === '' && this.#options.defect !== 'unchecked-model-output') {
      throw new Error('the model answered with empty content');
    }
    return content;
  }

  async interpret(
    message: string,
    context: ConversationContext | undefined,
    call?: ModelCall,
  ): Promise<Interpretation> {
    const parsed: unknown = JSON.parse(
      await this.#complete(ROLES.interpret, { message, context: context ?? null }, call),
    );
    if (!isInterpretation(parsed))
      throw new Error('the model answered with an invalid interpretation');
    return parsed;
  }

  write(draft: AnswerDraft, call?: ModelCall): Promise<string> {
    return this.#complete(ROLES.write, { draft }, call);
  }
}
