// The demo-shop's model over HTTP: both calls of a turn go to an
// OpenAI-compatible chat completions endpoint, such as the fake provider or a
// model proxy in front of it. The request carries the app's own key, and the
// trace id of the turn when there is one.

import type {
  AnswerDraft,
  ChatModel,
  ConversationContext,
  Interpretation,
  ModelCall,
} from './model.ts';
import { isInterpretation } from './wire.ts';

export interface RemoteModelOptions {
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

  async #complete(role: string, payload: unknown, call: ModelCall | undefined): Promise<string> {
    const stream = this.#options.stream === true;
    const response = await fetch(`${this.#options.url.replace(/\/$/u, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.#options.key}`,
        ...(call?.trace === undefined ? {} : { 'x-yokla-trace': call.trace }),
      },
      body: JSON.stringify({
        model: this.#options.model ?? 'demo-writer-1',
        messages: [
          { role: 'system', content: role },
          { role: 'user', content: JSON.stringify(payload) },
        ],
        ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}),
      }),
    });
    if (!response.ok) throw new Error(`the model answered ${String(response.status)}`);
    return stream ? streamed(await response.text()) : contentOf(await response.json());
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
