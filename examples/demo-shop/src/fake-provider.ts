// A deterministic, OpenAI-compatible chat completions provider for the
// demo-shop's model over HTTP (ADR-0012). It answers with ScriptedModel, so
// the demo-shop answers as it does in process, and it keeps its own usage
// records: the provider's side that the model proxy is reconciled with. It
// costs nothing and contacts nothing.

import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Defect } from './defects.ts';
import { ScriptedModel } from './model.ts';
import { ROLES } from './remote-model.ts';
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
  readonly role: string;
  readonly payload: string;
  readonly prompt: string;
  readonly stream: boolean;
  readonly includeUsage: boolean;
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
  return {
    model,
    role: contents[0] ?? '',
    payload: contents[1] ?? '',
    prompt: contents.join(''),
    stream: Reflect.get(value, 'stream') === true,
    includeUsage:
      typeof options === 'object' &&
      options !== null &&
      Reflect.get(options, 'include_usage') === true,
  };
}

async function answer(model: ScriptedModel, request: ChatRequest): Promise<string | undefined> {
  const payload: unknown = JSON.parse(request.payload);
  if (typeof payload !== 'object' || payload === null) return undefined;
  if (request.role === ROLES.interpret) {
    const message: unknown = Reflect.get(payload, 'message');
    const context: unknown = Reflect.get(payload, 'context');
    if (typeof message !== 'string') return undefined;
    if (context !== null && !isContext(context)) return undefined;
    return JSON.stringify(await model.interpret(message, context ?? undefined));
  }
  if (request.role === ROLES.write) {
    const draft: unknown = Reflect.get(payload, 'draft');
    return isDraft(draft) ? model.write(draft) : undefined;
  }
  return undefined;
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
    const content =
      chat === undefined ? undefined : await answer(model, chat).catch(() => undefined);
    if (chat === undefined || content === undefined) {
      send(response, 400, { error: { message: 'invalid request' } });
      return;
    }
    const id = `chatcmpl-${randomUUID()}`;
    const usage = {
      prompt_tokens: tokenCount(chat.prompt),
      completion_tokens: tokenCount(content),
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
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage: { ...usage, total_tokens: usage.prompt_tokens + usage.completion_tokens },
      });
      return;
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const half = Math.ceil(content.length / 2);
    for (const piece of [content.slice(0, half), content.slice(half)]) {
      const chunk = {
        id,
        object: 'chat.completion.chunk',
        model: chat.model,
        choices: [{ index: 0, delta: { content: piece } }],
      };
      response.write(`data: ${JSON.stringify(chunk)}\n\n`);
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
