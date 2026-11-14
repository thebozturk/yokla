// A deterministic, OpenAI-compatible chat completions provider for the
// demo-shop's model over HTTP (ADR-0012). It answers with ScriptedModel, so
// the demo-shop answers as it does in process, and it keeps its own usage
// records: the provider's side that the model proxy is reconciled with. It
// costs nothing and contacts nothing. Offered tools, it answers the interpret
// call with the matching tool call, and follows a writer's instruction to add
// the first product to the cart (ADR-0025).

import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Defect } from './defects.ts';
import { ScriptedModel } from './model.ts';
import { ROLES } from './remote-model.ts';
import { CART_INSTRUCTION, TOOL, toolCallOf, type ToolCallText } from './tools.ts';
import { isContext, isDraft } from './wire.ts';

export interface UsageEntry {
  readonly id: string;
  readonly model: string;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly stream: boolean;
}

export interface FakeProviderOptions {
  readonly key: string;
  /** A model defect, such as fabricated-price, applied when writing. */
  readonly defect?: Defect | null;
  readonly onUsage?: (entry: UsageEntry) => void;
}

/** A deterministic token count: one token per started four bytes. */
export function tokenCount(text: string): number {
  return Math.ceil(Buffer.byteLength(text, 'utf8') / 4);
}

interface ChatRequest {
  readonly model: string;
  /** The first line of the system message, which names the job. */
  readonly role: string;
  readonly system: string;
  readonly payload: string;
  readonly prompt: string;
  readonly stream: boolean;
  readonly includeUsage: boolean;
  /** The names of the tools the request offers. */
  readonly offered: readonly string[];
}

/** What the model answers: text, tool calls, or both. */
interface Answer {
  readonly content: string | null;
  readonly toolCalls: readonly ToolCallText[];
}

function parse(body: string): ChatRequest | undefined {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null) return undefined;
  const model: unknown = Reflect.get(value, 'model');
  const messages: unknown = Reflect.get(value, 'messages');
  if (typeof model !== 'string' || !Array.isArray(messages)) return undefined;
  const contents = messages.map((message: unknown) => {
    const content: unknown =
      typeof message === 'object' && message !== null ? Reflect.get(message, 'content') : undefined;
    return typeof content === 'string' ? content : '';
  });
  const options: unknown = Reflect.get(value, 'stream_options');
  const tools: unknown = Reflect.get(value, 'tools');
  const offered = (Array.isArray(tools) ? tools : []).flatMap((tool: unknown) => {
    const fn: unknown =
      typeof tool === 'object' && tool !== null ? Reflect.get(tool, 'function') : undefined;
    const name: unknown =
      typeof fn === 'object' && fn !== null ? Reflect.get(fn, 'name') : undefined;
    return typeof name === 'string' ? [name] : [];
  });
  return {
    offered,
    model,
    role: (contents[0] ?? '').split('\n')[0] ?? '',
    system: contents[0] ?? '',
    payload: contents[1] ?? '',
    prompt: contents.join(''),
    stream: Reflect.get(value, 'stream') === true,
    includeUsage:
      typeof options === 'object' &&
      options !== null &&
      Reflect.get(options, 'include_usage') === true,
  };
}

const EXTRACTION = ['talimatların', 'sistem prompt', 'system prompt', 'your instructions'];

function asksForInstructions(question: string): boolean {
  const text = question.toLocaleLowerCase('tr-TR');
  return EXTRACTION.some((phrase) => text.includes(phrase));
}

const text = (content: string): Answer => ({ content, toolCalls: [] });

async function answer(model: ScriptedModel, request: ChatRequest): Promise<Answer | undefined> {
  const payload: unknown = JSON.parse(request.payload);
  if (typeof payload !== 'object' || payload === null) return undefined;
  if (request.role === ROLES.interpret) {
    const message: unknown = Reflect.get(payload, 'message');
    const context: unknown = Reflect.get(payload, 'context');
    if (typeof message !== 'string') return undefined;
    if (context !== null && !isContext(context)) return undefined;
    const interpretation = await model.interpret(message, context ?? undefined);
    // Offered the tool the message needs, the model asks for it instead of answering.
    const call = toolCallOf(interpretation);
    return call !== undefined && request.offered.includes(call.name)
      ? { content: null, toolCalls: [call] }
      : text(JSON.stringify(interpretation));
  }
  if (request.role === ROLES.summarize) {
    const written: unknown = Reflect.get(payload, 'answer');
    return typeof written === 'string' ? text(await model.summarize(written)) : undefined;
  }
  if (request.role === ROLES.write) {
    const draft: unknown = Reflect.get(payload, 'draft');
    const question: unknown = Reflect.get(payload, 'question');
    // Like a model that gives in to an extraction request, it repeats its system prompt.
    if (typeof question === 'string' && asksForInstructions(question)) return text(request.system);
    if (!isDraft(draft)) return undefined;
    const written = await model.write(draft);
    const shown =
      draft.kind === 'cheapest' ? [draft.product] : 'products' in draft ? draft.products : [];
    const [first] = shown;
    // Told to, and offered the cart, it adds the first product it writes about.
    const cart =
      first !== undefined &&
      request.offered.includes(TOOL.cart) &&
      request.system.includes(CART_INSTRUCTION)
        ? [{ name: TOOL.cart, arguments: JSON.stringify({ productId: first.id }) }]
        : [];
    return { content: written, toolCalls: cart };
  }
  return undefined;
}

/** Tool calls as chat completions writes them; `index` only in a stream's delta. */
function wireCalls(calls: readonly ToolCallText[], id: string, indexed: boolean) {
  return calls.map((call, index) => ({
    ...(indexed ? { index } : {}),
    id: `${id}-call-${String(index)}`,
    type: 'function',
    function: { name: call.name, arguments: call.arguments },
  }));
}

function send(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

async function readAll(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request)
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  return Buffer.concat(chunks).toString('utf8');
}

export function createFakeProvider(options: FakeProviderOptions): Server {
  const model = new ScriptedModel(options.defect ?? null);

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      send(response, 404, { error: { message: 'not found' } });
      return;
    }
    if (request.headers.authorization !== `Bearer ${options.key}`) {
      send(response, 401, { error: { message: 'invalid api key' } });
      return;
    }
    const chat = parse(await readAll(request));
    const answered =
      chat === undefined ? undefined : await answer(model, chat).catch(() => undefined);
    if (chat === undefined || answered === undefined) {
      send(response, 400, { error: { message: 'invalid request' } });
      return;
    }
    const { content, toolCalls } = answered;
    const id = `chatcmpl-${randomUUID()}`;
    const usage = {
      prompt_tokens: tokenCount(chat.prompt),
      completion_tokens: tokenCount(
        (content ?? '') + toolCalls.map((call) => call.name + call.arguments).join(''),
      ),
    };
    options.onUsage?.({
      id,
      model: chat.model,
      promptTokens: usage.prompt_tokens,
      completionTokens: usage.completion_tokens,
      stream: chat.stream,
    });
    if (!chat.stream) {
      send(response, 200, {
        id,
        object: 'chat.completion',
        model: chat.model,
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content,
              ...(toolCalls.length === 0 ? {} : { tool_calls: wireCalls(toolCalls, id, false) }),
            },
            finish_reason: content === null ? 'tool_calls' : 'stop',
          },
        ],
        usage: { ...usage, total_tokens: usage.prompt_tokens + usage.completion_tokens },
      });
      return;
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const chunk = (delta: unknown) =>
      response.write(
        `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', model: chat.model, choices: [{ index: 0, delta }] })}\n\n`,
      );
    if (content !== null) {
      const half = Math.ceil(content.length / 2);
      for (const piece of [content.slice(0, half), content.slice(half)]) chunk({ content: piece });
    }
    // Each tool call in two pieces: its name and the start of its arguments, then the rest.
    for (const [index, call] of toolCalls.entries()) {
      const [wire] = wireCalls([call], id, true);
      const half = Math.ceil(call.arguments.length / 2);
      chunk({
        tool_calls: [
          {
            ...wire,
            index,
            function: { name: call.name, arguments: call.arguments.slice(0, half) },
          },
        ],
      });
      chunk({ tool_calls: [{ index, function: { arguments: call.arguments.slice(half) } }] });
    }
    if (chat.includeUsage) {
      const last = { id, object: 'chat.completion.chunk', model: chat.model, choices: [], usage };
      response.write(`data: ${JSON.stringify(last)}\n\n`);
    }
    response.end('data: [DONE]\n\n');
  }

  return createServer((request, response) => {
    handle(request, response).catch(() => {
      if (response.headersSent) response.destroy();
      else send(response, 500, { error: { message: 'internal error' } });
    });
  });
}
