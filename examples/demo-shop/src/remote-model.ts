// The demo-shop's model over HTTP: both calls of a turn go to an
// OpenAI-compatible chat completions endpoint, such as the fake provider or a
// model proxy in front of it. The request carries the app's own key, and the
// trace id of the turn when there is one. It retries once after a 429 or 503,
// gives up after a timeout, and refuses empty output and output that repeats
// its system prompt: the app then falls back. Retrieved products go into the
// user message, never the system message. The interpret call offers the
// shop's lookups as tools, and the call that writes about products offers the
// cart; the app runs what the model asks for (ADR-0025). With spans on, each
// request to the provider is a GenAI span in the trace of the turn's
// traceparent, with the model and token counts the provider reported (ADR-0029).

import type {
  AnswerDraft,
  ChatModel,
  ConversationContext,
  Interpretation,
  ModelCall,
} from './model.ts';
import type { Product } from './catalog.ts';
import type { Defect } from './defects.ts';
import { formatMoney } from './language.ts';
import type { ChatSpans, TokenUsage } from './otel.ts';
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

/**
 * The stale-price-in-prompt defect (ADR-0033): the draft the writer gets gives
 * its first product a price 10 % above the catalog's, as a stale cache would.
 */
function stale(product: Product): Product {
  return { ...product, price: Math.round(product.price * 110) / 100 };
}

function staleDraft(draft: AnswerDraft): AnswerDraft {
  if (draft.kind === 'cheapest') return { ...draft, product: stale(draft.product) };
  if ('products' in draft) {
    const [first, ...rest] = draft.products;
    return first === undefined ? draft : { ...draft, products: [stale(first), ...rest] };
  }
  return draft;
}

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
  /** Where each request to the provider becomes a span (ADR-0029). */
  readonly spans?: ChatSpans;
  /**
   * The provider's API: chat completions (default), or Gemini's native API
   * (ADR-0032), with the url ending before /models, e.g. …/v1beta.
   */
  readonly protocol?: ModelProtocol;
}

export type ModelProtocol = 'chat-completions' | 'gemini';

export function parseModelProtocol(value: string): ModelProtocol | undefined {
  return value === 'chat-completions' || value === 'gemini' ? value : undefined;
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

/** A provider's answer: its completion, or why it has none, with the model and usage it reported. */
interface Answer {
  readonly completion: Completion | Error;
  readonly model: string | undefined;
  readonly usage: TokenUsage;
}

function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined;
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

/** The token counts of a chat completion's usage. */
function usageOf(usage: unknown): TokenUsage {
  return {
    input: count(field(usage, 'prompt_tokens')),
    output: count(field(usage, 'completion_tokens')),
    cacheRead: count(field(field(usage, 'prompt_tokens_details'), 'cached_tokens')),
  };
}

function modelOf(body: unknown): string | undefined {
  const model = field(body, 'model');
  return typeof model === 'string' && model !== '' ? model : undefined;
}

/** A JSON answer: its usage stays readable when its completion isn't. */
function answerOf(body: unknown): Answer {
  let completion: Completion | Error;
  try {
    completion = completionOf(body);
  } catch (error) {
    completion = error instanceof Error ? error : new Error(String(error));
  }
  return { completion, model: modelOf(body), usage: usageOf(field(body, 'usage')) };
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

/**
 * The text and tool calls of a chat completions event stream, pieces joined by
 * index, with the usage its last chunk reports.
 */
function streamed(text: string): Answer {
  let content = '';
  let model: string | undefined;
  let usage: TokenUsage = { input: undefined, output: undefined, cacheRead: undefined };
  const calls = new Map<number, { name: string; arguments: string }>();
  for (const line of text.split('\n')) {
    if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
    const chunk: unknown = JSON.parse(line.slice(6));
    model = modelOf(chunk) ?? model;
    const reported = field(chunk, 'usage');
    if (typeof reported === 'object' && reported !== null) usage = usageOf(reported);
    const delta = firstChoice(chunk, 'delta');
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
  return { completion: { content, toolCalls }, model, usage };
}

/** Gemini's usage, as yokla counts it: thinking is output (ADR-0032). */
function geminiUsage(metadata: unknown): TokenUsage {
  const prompt = count(field(metadata, 'promptTokenCount'));
  const candidates = count(field(metadata, 'candidatesTokenCount'));
  const thoughts = count(field(metadata, 'thoughtsTokenCount'));
  return {
    input:
      prompt === undefined
        ? undefined
        : prompt + (count(field(metadata, 'toolUsePromptTokenCount')) ?? 0),
    output:
      candidates === undefined && thoughts === undefined
        ? undefined
        : (candidates ?? 0) + (thoughts ?? 0),
    cacheRead: count(field(metadata, 'cachedContentTokenCount')),
  };
}

/** Gemini answers, one or a stream's: their text and function calls, and the last usage. */
function geminiAnswer(answers: readonly unknown[]): Answer {
  let content = '';
  const toolCalls: ToolCallText[] = [];
  let model: string | undefined;
  let usage: TokenUsage = { input: undefined, output: undefined, cacheRead: undefined };
  for (const answer of answers) {
    const version = field(answer, 'modelVersion');
    if (typeof version === 'string' && version !== '') model = version;
    const metadata = field(answer, 'usageMetadata');
    if (typeof metadata === 'object' && metadata !== null) usage = geminiUsage(metadata);
    const candidates = field(answer, 'candidates');
    const parts = field(Array.isArray(candidates) ? candidates[0] : undefined, 'content');
    const list: unknown = field(parts, 'parts');
    for (const part of Array.isArray(list) ? list : []) {
      const text = field(part, 'text');
      if (typeof text === 'string') content += text;
      const name = field(field(part, 'functionCall'), 'name');
      const args = field(field(part, 'functionCall'), 'args');
      if (typeof name === 'string') {
        toolCalls.push({ name, arguments: JSON.stringify(args ?? {}) });
      }
    }
  }
  const completion =
    content === '' &&
    toolCalls.length === 0 &&
    answers.every((answer) => field(answer, 'candidates') === undefined)
      ? new Error('the model answered without content')
      : { content, toolCalls };
  return { completion, model, usage };
}

/** The answers of a Gemini event stream. */
function geminiEvents(text: string): unknown[] {
  return text
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line): unknown => JSON.parse(line.slice(6)));
}

/** A tool, as chat completions writes it, as a Gemini function declaration. */
function declaration(tool: unknown): unknown {
  const fn = field(tool, 'function');
  return {
    name: field(fn, 'name'),
    description: field(fn, 'description'),
    parameters: field(fn, 'parameters'),
  };
}

/** A request's outcome: the answer, or the status the provider refused it with. */
type Attempt =
  { readonly answer: Answer } | { readonly status: number; readonly retryAfter: string | null };

export class RemoteModel implements ChatModel {
  readonly #options: RemoteModelOptions;

  constructor(options: RemoteModelOptions) {
    this.#options = options;
  }

  get #gemini(): boolean {
    return this.#options.protocol === 'gemini';
  }

  async #send(body: string, model: string, call: ModelCall | undefined): Promise<Response> {
    const timeout =
      this.#options.defect === 'no-model-timeout' ? undefined : (this.#options.timeoutMs ?? 3_000);
    const base = this.#options.url.replace(/\/$/u, '');
    const stream = this.#options.stream === true;
    const url = this.#gemini
      ? `${base}/models/${model}:${stream ? 'streamGenerateContent?alt=sse' : 'generateContent'}`
      : `${base}/chat/completions`;
    return fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.#gemini
          ? { 'x-goog-api-key': this.#options.key }
          : { authorization: `Bearer ${this.#options.key}` }),
        ...(call?.trace === undefined ? {} : { 'x-yokla-trace': call.trace }),
      },
      body,
      ...(timeout === undefined ? {} : { signal: AbortSignal.timeout(timeout) }),
    });
  }

  /** One request to the provider, a span of its own when spans are on. */
  async #attempt(body: string, model: string, call: ModelCall | undefined): Promise<Attempt> {
    const end = this.#options.spans?.chat(
      model,
      call?.traceparent,
      this.#gemini ? 'gcp.gemini' : 'openai',
    );
    try {
      const response = await this.#send(body, model, call);
      if (!response.ok) {
        await response.body?.cancel();
        end?.({ error: String(response.status) });
        return { status: response.status, retryAfter: response.headers.get('retry-after') };
      }
      const stream = this.#options.stream === true;
      const answer = this.#gemini
        ? geminiAnswer(stream ? geminiEvents(await response.text()) : [await response.json()])
        : stream
          ? streamed(await response.text())
          : answerOf(await response.json());
      end?.({ model: answer.model, usage: answer.usage });
      return { answer };
    } catch (error) {
      end?.({ error: error instanceof Error ? error.name : 'Error' });
      throw error;
    }
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
    const model = this.#options.model ?? 'demo-writer-1';
    const body = JSON.stringify(
      this.#gemini
        ? {
            systemInstruction: { parts: [{ text: system }] },
            contents: [{ role: 'user', parts: [{ text: JSON.stringify(payload) }] }],
            ...(tools.length === 0
              ? {}
              : {
                  tools: [{ functionDeclarations: tools.map(declaration) }],
                  toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
                }),
          }
        : {
            model,
            messages: [
              { role: 'system', content: system },
              { role: 'user', content: JSON.stringify(payload) },
            ],
            ...(tools.length === 0 ? {} : { tools, tool_choice: 'auto' }),
            ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}),
          },
    );
    let attempt = await this.#attempt(body, model, call);
    if ('status' in attempt && (attempt.status === 429 || attempt.status === 503)) {
      // One retry, after the wait the provider asks for, capped at 2 s.
      const seconds = Number(attempt.retryAfter ?? '1');
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(2_000, Math.max(0, seconds * 1000))),
      );
      attempt = await this.#attempt(body, model, call);
    }
    if ('status' in attempt) throw new Error(`the model answered ${String(attempt.status)}`);
    const { completion } = attempt.answer;
    if (completion instanceof Error) throw completion;
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
      draft: this.#options.defect === 'stale-price-in-prompt' ? staleDraft(draft) : draft,
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
    // The price-rewritten defect (ADR-0033): the app lowers the first price after the model wrote it.
    const [first] = shown;
    if (this.#options.defect === 'price-rewritten' && first !== undefined) {
      return completion.content.replace(
        formatMoney(first.price, draft.language),
        formatMoney(Math.round(first.price * 90) / 100, draft.language),
      );
    }
    return completion.content;
  }
}
