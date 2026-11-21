// A deterministic, OpenAI-compatible chat completions provider for the
// demo-shop's model over HTTP (ADR-0012). It answers with ScriptedModel, so
// the demo-shop answers as it does in process, and it keeps its own usage
// records: the provider's side that the model proxy is reconciled with. It
// costs nothing and contacts nothing. Offered tools, it answers the interpret
// call with the matching tool call, and follows a writer's instruction to add
// the first product to the cart (ADR-0025). It also plays yokla's simulated
// customer (ADR-0028), by simple rules over the shop's catalog. It speaks
// Gemini's native API too (ADR-0032), at /v1beta/models/{model}:generateContent
// and :streamGenerateContent, answering the same, with thinking tokens. A call
// that asks for demo-writer-nano gets a model that invents a price, as
// fabricated-price does, so swapping models shows a difference (ADR-0042).
// Given description-obeyed, it writes the word an instruction in a tool's
// description asks for; given raw-arguments, it copies the message into its
// search's arguments (ADR-0085). Told a customer's own orders, it cancels one
// of them when asked, and refunds when offered the tool (ADR-0086).

import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { loadShopData, type Product } from './catalog.ts';
import type { Defect } from './defects.ts';
import { fold } from './language.ts';
import { ScriptedModel, type Interpretation } from './model.ts';
import { ROLES } from './remote-model.ts';
import { CART_INSTRUCTION, TOOL, toolCallOf, type ToolCallText } from './tools.ts';
import { isContext, isDraft } from './wire.ts';

export interface UsageEntry {
  readonly id: string;
  readonly model: string;
  readonly promptTokens: number;
  /** Every output token billed: for Gemini, the thinking tokens included. */
  readonly completionTokens: number;
  /** For Gemini: the thinking tokens, part of completionTokens. */
  readonly thoughtsTokens?: number;
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
  /** The descriptions of the tools the request offers (ADR-0085). */
  readonly descriptions: readonly string[];
  /** Every message, as role and text. */
  readonly messages: readonly { readonly role: string; readonly content: string }[];
  /** The most tokens the reply may take, when the request says. */
  readonly maxTokens?: number;
}

/** yokla marks the first line of its customer prompt so (ADR-0028). */
export const CUSTOMER_MARK = 'yokla: simulated customer';

/** yokla marks the first line of its analyzer prompt so (ADR-0049). */
export const ANALYZER_MARK = 'yokla: analyzer';

/** yokla marks the first line of its transform prompt so (ADR-0059). */
export const TRANSFORM_MARK = 'yokla: transform';

/** The shop's product words, Turkish to English, for code-switching. */
const SWITCHED: readonly (readonly [string, string])[] = [
  ['sırt çantası', 'backpack'],
  ['uyku tulumu', 'sleeping bag'],
  ['uyku matı', 'sleeping pad'],
  ['kamp ocağı', 'camping stove'],
  ['kafa lambası', 'headlamp'],
  ['matara', 'water bottle'],
  ['çadır', 'tent'],
  ['mont', 'jacket'],
];

/** Each occurrence of a word, in any case, as another word; the language decides the case rules. */
function swap(text: string, from: string, to: string, locale: string): string {
  const lower = text.toLocaleLowerCase(locale);
  let out = '';
  let at = 0;
  for (let found = lower.indexOf(from); found !== -1; found = lower.indexOf(from, at)) {
    out += text.slice(at, found) + to;
    at = found + from.length;
  }
  return out + text.slice(at);
}

/**
 * The transform model's rewrite, by rules (ADR-0059). Paraphrase: "X var mı?"
 * becomes "X bulunuyor mu?", "Do you have X?" becomes "Is there X?", and
 * other messages gain a polite opening; it writes 500 as "beş yüz", so one
 * rewrite loses a value for yokla to refuse. Code-switch: the shop's product
 * words in one language become the other's.
 */
function transformReply(request: ChatRequest): string {
  const message = request.messages.find((entry) => entry.role === 'user')?.content ?? '';
  // The prompt names the case's language: "(tr)" for a paraphrase, "keep tr as" for a code-switch.
  const turkish = /\(tr\)|keep tr as/u.test(request.system);
  if (request.system.includes('Transform: code-switch.')) {
    let switched = message;
    for (const [tr, en] of SWITCHED) {
      switched = turkish ? swap(switched, tr, en, 'tr-TR') : swap(switched, en, tr, 'en-US');
    }
    return switched;
  }
  const asked = turkish ? /^(.+) var mı\?$/u.exec(message) : /^Do you have (.+)\?$/iu.exec(message);
  const rewritten =
    asked?.[1] === undefined
      ? `${turkish ? 'Merhaba' : 'Hi'}, ${message.charAt(0).toLocaleLowerCase(turkish ? 'tr-TR' : 'en-US')}${message.slice(1)}`
      : turkish
        ? `${asked[1]} bulunuyor mu?`
        : `Is there ${asked[1]}?`;
  return rewritten.replaceAll(/(?<!\d)500(?!\d)/gu, 'beş yüz');
}

interface Found {
  readonly field: string;
  readonly value: unknown;
  readonly file: string;
  readonly line: number;
  readonly quote: string;
}

/**
 * The analyzer model's answer, by simple rules over the chunk yokla sends:
 * an object with burstPerSecond and perMinute, a header sent to bypass a
 * cache, and lines that set a refusal sentence. Like a model that invents, it
 * also gives a limit the line it quotes doesn't hold, for yokla to drop.
 */
function analyzerReply(request: ChatRequest): string {
  const chunk = request.messages.find((message) => message.role === 'user')?.content ?? '';
  const languages = (/^The profile's languages: (.*)$/mu.exec(chunk)?.[1] ?? '').split(', ');
  const entries: Found[] = [];
  let file = '';
  for (const line of chunk.split('\n')) {
    const header = /^=== (.+)$/u.exec(line);
    if (header !== null) {
      file = header[1] ?? '';
      continue;
    }
    const numbered = /^(\d+)\| (.*)$/u.exec(line);
    if (numbered === null) continue;
    const at = Number(numbered[1]);
    const text = numbered[2] ?? '';
    const found = (name: string, value: unknown) => {
      entries.push({ field: name, value, file, line: at, quote: text.trim() });
    };
    const burst = /burstPerSecond:\s*(\d+)/u.exec(text);
    const minute = /perMinute:\s*(\d+)/u.exec(text);
    if (burst !== null && minute !== null) {
      found('limits.burstPerSecond', Number(burst[1]));
      found('limits.perMinute', Number(minute[1]));
      found('limits.perHour', 999);
    }
    const bypass = /`?(x-[\w-]*bypass[\w-]*)`?\s*:\s*`?([\w-]+)/iu.exec(text);
    if (bypass !== null) found('cacheBypass.header', { name: bypass[1], value: bypass[2] });
    const refusal = /^\s*refusal:\s*(['"])(.+)\1,?\s*$/u.exec(text);
    const sentence = refusal?.[2];
    if (sentence !== undefined) {
      const language = /[çğıöşüÇĞİÖŞÜ]/u.test(sentence) ? 'tr' : 'en';
      if (languages.includes(language)) found('refusal', { language, sentence });
    }
  }
  return JSON.stringify({ entries });
}

/** The first number of a text, read whatever its thousands separator: "3.000" or "1,500". */
function firstAmount(text: string): number | undefined {
  const raw = /\d[\d.,]*/u.exec(text)?.[0];
  if (raw === undefined) return undefined;
  const value = Number(raw.replaceAll(/[.,](?=\d{3}(?:\D|$))/gu, '').replace(',', '.'));
  return Number.isFinite(value) ? value : undefined;
}

/**
 * The simulated customer's next message, by simple rules: first the goal
 * itself; then, from the products the last answer names, the first that is in
 * stock and within the goal's price, put in the cart; when none fits, ask for
 * something cheaper.
 */
function customerReply(request: ChatRequest, catalog: readonly Product[]): string {
  const lines = request.system.split('\n');
  const turkish = lines.some((line) => line.startsWith('Ne istiyorsun:'));
  const goal = (lines.find((line) => /^(?:What you want|Ne istiyorsun):/u.test(line)) ?? '')
    .replace(/^[^:]*:\s*/u, '')
    .trim();
  const answers = request.messages.filter((m) => m.role === 'user').slice(1);
  const last = answers.at(-1);
  if (last === undefined) return goal;
  const said = fold(last.content);
  const limit = firstAmount(goal);
  const named = catalog
    .map((product) => ({
      product,
      at: Math.max(said.indexOf(fold(product.name.tr)), said.indexOf(fold(product.name.en))),
    }))
    .filter(({ at }) => at !== -1)
    .toSorted((a, b) => a.at - b.at)
    .map(({ product }) => product);
  const [pick] = named.filter(
    (product) => (product.stock ?? 0) > 0 && (limit === undefined || product.price <= limit),
  );
  if (pick !== undefined) {
    return turkish
      ? `${pick.name.tr} ürününü sepete ekler misin?`
      : `Please add the ${pick.name.en} to my cart.`;
  }
  return turkish ? 'Daha ucuz bir seçenek var mı?' : 'Do you have anything cheaper?';
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
  const roles = messages.map((message: unknown) => {
    const role: unknown =
      typeof message === 'object' && message !== null ? Reflect.get(message, 'role') : undefined;
    return typeof role === 'string' ? role : '';
  });
  const options: unknown = Reflect.get(value, 'stream_options');
  const tools: unknown = Reflect.get(value, 'tools');
  const maxTokens: unknown = Reflect.get(value, 'max_tokens');
  const offered = (Array.isArray(tools) ? tools : []).flatMap((tool: unknown) => {
    const fn: unknown =
      typeof tool === 'object' && tool !== null ? Reflect.get(tool, 'function') : undefined;
    const name: unknown =
      typeof fn === 'object' && fn !== null ? Reflect.get(fn, 'name') : undefined;
    return typeof name === 'string' ? [name] : [];
  });
  return {
    offered,
    descriptions: descriptionsOf(Array.isArray(tools) ? tools : [], 'function'),
    messages: contents.map((content, index) => ({ role: roles[index] ?? '', content })),
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
    ...(typeof maxTokens === 'number' ? { maxTokens } : {}),
  };
}

/** The descriptions of offered tools: each one's own, or its `inner` object's. */
function descriptionsOf(tools: readonly unknown[], inner?: string): string[] {
  return tools.flatMap((tool: unknown) => {
    const description =
      inner === undefined ? field(tool, 'description') : field(tool, inner, 'description');
    return typeof description === 'string' ? [description] : [];
  });
}

/** A reply cut at max_tokens, as providers cut one; undefined when it fits (ADR-0051). */
function cutAt(text: string, maxTokens: number | undefined): string | undefined {
  if (maxTokens === undefined || tokenCount(text) <= maxTokens) return undefined;
  let kept = text.slice(0, maxTokens * 4);
  while (tokenCount(kept) > maxTokens) kept = kept.slice(0, -1);
  return kept;
}

function field(value: unknown, ...path: (string | number)[]): unknown {
  let current = value;
  for (const key of path) {
    if (typeof current !== 'object' || current === null) return undefined;
    current = Reflect.get(current, key);
  }
  return current;
}

/** The text parts of a Gemini content, joined. */
function partsText(content: unknown): string {
  const parts = field(content, 'parts');
  return (Array.isArray(parts) ? parts : [])
    .map((part: unknown) => field(part, 'text'))
    .filter((piece): piece is string => typeof piece === 'string')
    .join('');
}

/** A Gemini generateContent request, read as a chat: the system first, then each content. */
function parseGemini(body: string, model: string, stream: boolean): ChatRequest | undefined {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return undefined;
  }
  const contents = field(value, 'contents');
  if (!Array.isArray(contents)) return undefined;
  const system = partsText(field(value, 'systemInstruction'));
  const messages = [
    { role: 'system', content: system },
    ...contents.flatMap((content: unknown) => {
      const parts = field(content, 'parts');
      // A functionResponse part is a tool's result (ADR-0043).
      const results = (Array.isArray(parts) ? parts : []).flatMap((part: unknown) => {
        const response = field(part, 'functionResponse', 'response');
        return response === undefined ? [] : [{ role: 'tool', content: JSON.stringify(response) }];
      });
      return results.length > 0
        ? results
        : [
            {
              role: field(content, 'role') === 'model' ? 'assistant' : 'user',
              content: partsText(content),
            },
          ];
    }),
  ];
  const tools = field(value, 'tools');
  const declared = (Array.isArray(tools) ? tools : []).flatMap((tool: unknown): unknown[] => {
    const declarations = field(tool, 'functionDeclarations');
    return Array.isArray(declarations)
      ? declarations.map((declaration: unknown) => declaration)
      : [];
  });
  const offered = declared.flatMap((declaration: unknown) => {
    const name = field(declaration, 'name');
    return typeof name === 'string' ? [name] : [];
  });
  return {
    offered,
    descriptions: descriptionsOf(declared),
    messages,
    model,
    role: system.split('\n')[0] ?? '',
    system,
    payload: messages[1]?.content ?? '',
    prompt: messages.map((message) => message.content).join(''),
    stream,
    includeUsage: true,
  };
}

const EXTRACTION = ['talimatların', 'sistem prompt', 'system prompt', 'your instructions'];

const INJECTED = /reply only with ([A-Za-z0-9-]+)/iu;

/**
 * The part of a tool result outside its fence (ADR-0043): the text around
 * `<data>` tags, or a Gemini object's fields beside its `data`.
 */
function unfenced(text: string): string {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value === 'object' && value !== null && 'data' in value) {
      return JSON.stringify({ ...value, data: null });
    }
  } catch {
    // Not JSON: a text result, fenced by tags if at all.
  }
  return text.replaceAll(/<data[^>]*>[\s\S]*?<\/data>/gu, '');
}

/** An instruction in a tool's description to reply only with a word, in English or Turkish. */
const DESCRIBED = [INJECTED, /yaln[ıi]zca ([A-Za-z0-9-]+) yaz/iu] as const;

/**
 * The word an instruction in a tool's description asks the model to reply
 * with: like a model that follows its tools' descriptions (ADR-0085).
 */
function describedReply(descriptions: readonly string[]): string | undefined {
  for (const description of descriptions) {
    for (const pattern of DESCRIBED) {
      const asked = pattern.exec(description)?.[1];
      if (asked !== undefined) return asked;
    }
  }
  return undefined;
}

/**
 * The word an unfenced instruction in a tool result asks the model to reply
 * with: like a model that gives in to an instruction in its data (ADR-0043).
 */
function injectedReply(messages: ChatRequest['messages']): string | undefined {
  for (const message of messages) {
    if (message.role !== 'tool') continue;
    const asked = INJECTED.exec(unfenced(message.content))?.[1];
    if (asked !== undefined) return asked;
  }
  return undefined;
}

/**
 * The tool call an action on an order needs (ADR-0086): a refund when the
 * refund tool is offered, of the order named or else the customer's first; a
 * cancellation of the customer's own order when asked. order-action-unchecked
 * cancels any order asked for; eager-action cancels one's own when only asked
 * about. Undefined when the model answers instead.
 */
function orderCallOf(
  order: Extract<Interpretation, { route: 'order' }>,
  own: readonly string[],
  offered: readonly string[],
  defect: Defect | null,
): ToolCallText | undefined {
  const { action, orderId, asked, language } = order;
  if (action === 'refund') {
    const id = orderId ?? own[0];
    return asked && id !== undefined && offered.includes(TOOL.refund)
      ? { name: TOOL.refund, arguments: JSON.stringify({ orderId: id, language }) }
      : undefined;
  }
  if (orderId === undefined || !offered.includes(TOOL.cancel)) return undefined;
  const mine = own.includes(orderId);
  const acts = asked
    ? mine || defect === 'order-action-unchecked'
    : mine && defect === 'eager-action';
  return acts ? { name: TOOL.cancel, arguments: JSON.stringify({ orderId, language }) } : undefined;
}

const LENGTH = ['en az 500 kelime', 'at least 500 words'];

function asksForLength(question: string): boolean {
  const text = question.toLocaleLowerCase('tr-TR');
  return LENGTH.some((phrase) => text.includes(phrase));
}

function asksForInstructions(question: string): boolean {
  const text = question.toLocaleLowerCase('tr-TR');
  return EXTRACTION.some((phrase) => text.includes(phrase));
}

const text = (content: string): Answer => ({ content, toolCalls: [] });

async function answer(
  model: ScriptedModel,
  request: ChatRequest,
  catalog: readonly Product[],
  defect: Defect | null,
): Promise<Answer | undefined> {
  if (request.role === CUSTOMER_MARK) return text(customerReply(request, catalog));
  if (request.role === ANALYZER_MARK) return text(analyzerReply(request));
  if (request.role === TRANSFORM_MARK) return text(transformReply(request));
  const payload: unknown = JSON.parse(request.payload);
  if (typeof payload !== 'object' || payload === null) return undefined;
  if (request.role === ROLES.interpret) {
    const message: unknown = Reflect.get(payload, 'message');
    const context: unknown = Reflect.get(payload, 'context');
    if (typeof message !== 'string') return undefined;
    if (context !== null && !isContext(context)) return undefined;
    const interpretation = await model.interpret(message, context ?? undefined);
    if (interpretation.route === 'order') {
      const orders: unknown = Reflect.get(payload, 'orders');
      const own = (Array.isArray(orders) ? orders : []).filter(
        (order): order is string => typeof order === 'string',
      );
      const acted = orderCallOf(interpretation, own, request.offered, defect);
      return acted === undefined
        ? text(JSON.stringify(interpretation))
        : { content: null, toolCalls: [acted] };
    }
    // Offered the tool the message needs, the model asks for it instead of answering.
    const call = toolCallOf(interpretation);
    if (call === undefined || !request.offered.includes(call.name)) {
      return text(JSON.stringify(interpretation));
    }
    // The raw-arguments defect (ADR-0085): the message goes into the search as it is.
    const raw =
      defect === 'raw-arguments' && call.name === TOOL.search
        ? {
            name: call.name,
            arguments: JSON.stringify({ ...JSON.parse(call.arguments), query: message }),
          }
        : call;
    return { content: null, toolCalls: [raw] };
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
    const injected = injectedReply(request.messages);
    if (injected !== undefined) return text(injected);
    // The description-obeyed defect (ADR-0085): an instruction in a tool's description is followed.
    const described =
      defect === 'description-obeyed' ? describedReply(request.descriptions) : undefined;
    if (described !== undefined) return text(described);
    if (!isDraft(draft)) return undefined;
    const once = await model.write(draft);
    // Asked for a very long answer, it writes one, as long as max_tokens lets it (ADR-0082).
    const written =
      typeof question === 'string' && asksForLength(question)
        ? Array.from({ length: 200 }, () => once).join('\n')
        : once;
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

/** The writer model that invents the first product's price (ADR-0042). */
export const NANO_MODEL = 'demo-writer-nano';

export function createFakeProvider(options: FakeProviderOptions): Server {
  const model = new ScriptedModel(options.defect ?? null);
  const nano = new ScriptedModel('fabricated-price');
  /** The model that answers a call: the one it asks for, by name. */
  const named = (name: string) => (name === NANO_MODEL ? nano : model);
  const { catalog } = loadShopData();

  /** Gemini's native API (ADR-0032): one answer, or a stream of events or a JSON array. */
  async function gemini(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    route: RegExpExecArray,
  ): Promise<void> {
    const key = request.headers['x-goog-api-key'] ?? url.searchParams.get('key');
    if (key !== options.key) {
      send(response, 403, {
        error: { code: 403, message: 'invalid api key', status: 'PERMISSION_DENIED' },
      });
      return;
    }
    const name = route[1] ?? '';
    const stream = route[2] === 'streamGenerateContent';
    const chat = parseGemini(await readAll(request), name, stream);
    const answered =
      chat === undefined
        ? undefined
        : await answer(named(chat.model), chat, catalog, options.defect ?? null).catch(
            () => undefined,
          );
    if (chat === undefined || answered === undefined) {
      send(response, 400, {
        error: { code: 400, message: 'invalid request', status: 'INVALID_ARGUMENT' },
      });
      return;
    }
    const { content, toolCalls } = answered;
    const candidates = tokenCount(
      (content ?? '') + toolCalls.map((call) => call.name + call.arguments).join(''),
    );
    // A deterministic stand-in for thinking: a token per started four bytes of the job's name.
    const thoughts = tokenCount(chat.role);
    const usageMetadata = {
      promptTokenCount: tokenCount(chat.prompt),
      candidatesTokenCount: candidates,
      thoughtsTokenCount: thoughts,
      totalTokenCount: tokenCount(chat.prompt) + candidates + thoughts,
    };
    options.onUsage?.({
      id: `gemini-${randomUUID()}`,
      model: name,
      promptTokens: usageMetadata.promptTokenCount,
      completionTokens: candidates + thoughts,
      thoughtsTokens: thoughts,
      stream,
    });
    const calls = toolCalls.map((call) => ({
      functionCall: { name: call.name, args: JSON.parse(call.arguments) as unknown },
    }));
    const answerOf = (parts: unknown[], usage?: unknown) => ({
      candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP', index: 0 }],
      ...(usage === undefined ? {} : { usageMetadata: usage }),
      modelVersion: name,
    });
    if (!stream) {
      send(
        response,
        200,
        answerOf([...(content === null ? [] : [{ text: content }]), ...calls], usageMetadata),
      );
      return;
    }
    // The text in two pieces, then the calls, then the usage, as Gemini streams them.
    const half = Math.ceil((content ?? '').length / 2);
    const chunks = [
      ...(content === null
        ? []
        : [
            answerOf([{ text: content.slice(0, half) }]),
            answerOf([{ text: content.slice(half) }]),
          ]),
      ...(calls.length === 0 ? [] : [answerOf(calls)]),
      answerOf([], usageMetadata),
    ];
    if (url.searchParams.get('alt') === 'sse') {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const chunk of chunks) response.write(`data: ${JSON.stringify(chunk)}\r\n\r\n`);
      response.end();
      return;
    }
    send(response, 200, chunks);
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const route = /^\/v1beta\/models\/([^/:]+):(generateContent|streamGenerateContent)$/u.exec(
      url.pathname,
    );
    if (request.method === 'POST' && route !== null) {
      await gemini(request, response, url, route);
      return;
    }
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
      chat === undefined
        ? undefined
        : await answer(named(chat.model), chat, catalog, options.defect ?? null).catch(
            () => undefined,
          );
    if (chat === undefined || answered === undefined) {
      send(response, 400, { error: { message: 'invalid request' } });
      return;
    }
    const { toolCalls } = answered;
    const cut = answered.content === null ? undefined : cutAt(answered.content, chat.maxTokens);
    const content = cut ?? answered.content;
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
            finish_reason: content === null ? 'tool_calls' : cut === undefined ? 'stop' : 'length',
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
