// The demo-shop's model over HTTP: both calls of a turn go to an
// OpenAI-compatible chat completions endpoint, such as the fake provider or a
// model proxy in front of it. The request carries the app's own key, and the
// trace id of the turn when there is one. It retries once after a 429 or 503,
// gives up after a timeout, and refuses empty output and output that repeats
// its system prompt: the app then falls back. Retrieved products go into the
// user message, never the system message. The interpret call offers the
// shop's lookups as tools, and the call that writes about products offers the
// cart; the app runs what the model asks for (ADR-0025).

import type {
  AnswerDraft,
  ChatModel,
  ConversationContext,
  Interpretation,
  ModelCall,
} from './model.ts';
import type { Product } from './catalog.ts';
import type { Defect } from './defects.ts';
import {
  CART_INSTRUCTION,
  cartProductOf,
  INTERPRET_TOOLS,
  interpretationOf,
  TOOL,
  WRITE_TOOLS,
  type ToolCallText,
} from './tools.ts';
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
  /** A canary planted in every system prompt, so a test can see it leak. */
  readonly canary?: string;
}

/** The system message names the job on its first line, so a provider can tell the two calls apart. */
export const ROLES = {
  interpret: 'demo-shop:interpret',
  write: 'demo-shop:write',
  summarize: 'demo-shop:summarize',
} as const;

/** The instructions in every system prompt; output that repeats them is a leak. */
export const INSTRUCTIONS =
  'You are the demo-shop assistant. Answer only from the data in the user message.';

export function systemPrompt(role: string, canary?: string): string {
  return [role, INSTRUCTIONS, ...(canary === undefined ? [] : [`Canary: ${canary}`])].join('\n');
}

/** What the model answered: its text, possibly empty, and the tool calls it asked for. */
interface Completion {
  readonly content: string;
  readonly toolCalls: readonly ToolCallText[];
}

function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined;
}

function firstChoice(body: unknown, key: 'message' | 'delta'): unknown {
  const choices = field(body, 'choices');
  return field(Array.isArray(choices) ? choices[0] : undefined, key);
}

function completionOf(body: unknown): Completion {
  const message = firstChoice(body, 'message');
  const content = field(message, 'content');
  const calls = field(message, 'tool_calls');
  const toolCalls = (Array.isArray(calls) ? calls : []).flatMap((call: unknown) => {
    const name = field(field(call, 'function'), 'name');
    const args = field(field(call, 'function'), 'arguments');
    return typeof name === 'string'
      ? [{ name, arguments: typeof args === 'string' ? args : '' }]
      : [];
  });
  if (typeof content !== 'string' && toolCalls.length === 0) {
    throw new Error('the model answered without content');
  }
  return { content: typeof content === 'string' ? content : '', toolCalls };
}

/** The text and tool calls of a chat completions event stream, pieces joined by index. */
function streamed(text: string): Completion {
  let content = '';
  const calls = new Map<number, { name: string; arguments: string }>();
  for (const line of text.split('\n')) {
    if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
    const delta = firstChoice(JSON.parse(line.slice(6)), 'delta');
    const piece = field(delta, 'content');
    if (typeof piece === 'string') content += piece;
    const pieces = field(delta, 'tool_calls');
    for (const call of Array.isArray(pieces) ? pieces : []) {
      const index = field(call, 'index');
      const at = typeof index === 'number' ? index : 0;
      const entry = calls.get(at) ?? { name: '', arguments: '' };
      const name = field(field(call, 'function'), 'name');
      const args = field(field(call, 'function'), 'arguments');
      if (typeof name === 'string') entry.name = name;
      if (typeof args === 'string') entry.arguments += args;
      calls.set(at, entry);
    }
  }
  const toolCalls = [...calls.entries()]
    .toSorted(([a], [b]) => a - b)
    .map(([, call]) => call)
    .filter((call) => call.name !== '');
  return { content, toolCalls };
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

  async #complete(
    role: string,
    payload: unknown,
    call: ModelCall | undefined,
    products: readonly Product[] = [],
    tools: readonly unknown[] = [],
  ): Promise<Completion> {
    const stream = this.#options.stream === true;
    const system = [
      systemPrompt(role, this.#options.canary),
      // The products-in-system defect: retrieved data gets the system's authority.
      ...(this.#options.defect === 'products-in-system' && products.length > 0
        ? [`Products: ${JSON.stringify(products)}`]
        : []),
      // The unrequested-cart defect: the writer is told to fill the cart, unasked.
      ...(this.#options.defect === 'unrequested-cart' && role === ROLES.write && products.length > 0
        ? [CART_INSTRUCTION]
        : []),
    ].join('\n');
    const body = JSON.stringify({
      model: this.#options.model ?? 'demo-writer-1',
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: JSON.stringify(payload) },
      ],
      ...(tools.length === 0 ? {} : { tools, tool_choice: 'auto' }),
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
    const completion = stream
      ? streamed(await response.text())
      : completionOf(await response.json());
    const { content } = completion;
    if (
      content.trim() === '' &&
      completion.toolCalls.length === 0 &&
      this.#options.defect !== 'unchecked-model-output'
    ) {
      throw new Error('the model answered with empty content');
    }
    if (content.includes(INSTRUCTIONS) && this.#options.defect !== 'no-leak-guard') {
      throw new Error('the model answered with its system prompt');
    }
    return completion;
  }

  async interpret(
    message: string,
    context: ConversationContext | undefined,
    call?: ModelCall,
  ): Promise<Interpretation> {
    const payload = { message, context: context ?? null };
    let completion = await this.#complete(ROLES.interpret, payload, call, [], INTERPRET_TOOLS);
    // The repeated-search defect: the app asks for the same search a second time.
    if (
      this.#options.defect === 'repeated-search' &&
      completion.toolCalls[0]?.name === TOOL.search
    ) {
      completion = await this.#complete(ROLES.interpret, payload, call, [], INTERPRET_TOOLS);
    }
    const [asked] = completion.toolCalls;
    const parsed: unknown =
      asked === undefined ? JSON.parse(completion.content) : interpretationOf(asked);
    if (!isInterpretation(parsed))
      throw new Error('the model answered with an invalid interpretation');
    return parsed;
  }

  async summarize(answer: string, call?: ModelCall): Promise<string> {
    return (await this.#complete(ROLES.summarize, { answer }, call)).content;
  }

  async write(draft: AnswerDraft, call?: ModelCall): Promise<string> {
    const payload = {
      draft,
      ...(call?.question === undefined ? {} : { question: call.question }),
      ...(call?.reference === undefined ? {} : { reference: call.reference }),
    };
    const shown =
      draft.kind === 'cheapest' ? [draft.product] : 'products' in draft ? draft.products : [];
    const completion = await this.#complete(
      ROLES.write,
      payload,
      call,
      shown,
      shown.length > 0 ? WRITE_TOOLS : [],
    );
    // The app runs the cart calls the model asks for, without asking the user.
    for (const asked of completion.toolCalls) {
      const product = cartProductOf(asked);
      if (product !== undefined) call?.addToCart?.(product);
    }
    return completion.content;
  }
}
