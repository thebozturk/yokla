// What the model proxy records per provider call (ADR-0012). The proxy writes
// it and the runner reads it; both depend only on core. Token kinds the
// provider didn't report are null, never 0. Credentials and other headers are
// never part of a record.

import { z } from 'zod';
import { Id } from './common.ts';

const Tokens = z.int().nonnegative().nullable();

export const ProxyUsage = z.object({
  /** Every input token, cached and cache-write ones included. */
  input: Tokens,
  /** Every output token, reasoning ones included. */
  output: Tokens,
  /** The part of `input` read from the provider's cache. */
  cachedInput: Tokens,
  /** The part of `input` written to the provider's cache. */
  cacheWrite: Tokens,
  /** The part of `output` spent on reasoning. */
  reasoning: Tokens,
});
export type ProxyUsage = z.output<typeof ProxyUsage>;

/** Who a prompt message speaks as; `developer` counts as `system`, an embedding's input is `input` (ADR-0015). */
export const PromptRole = z.enum(['system', 'user', 'assistant', 'tool', 'input']);
export type PromptRole = z.output<typeof PromptRole>;

/** What of a prompt is written to results and records files (ADR-0015). */
export const PromptStore = z.enum(['sizes', 'hashed', 'redacted', 'full']);
export type PromptStore = z.output<typeof PromptStore>;

/**
 * One message of a call's prompt (ADR-0015). The proxy hands the runner its
 * text; what is written to files depends on the profile's `prompts.store`.
 */
export const PromptMessage = z.object({
  role: PromptRole,
  /** The length of the text, in UTF-16 code units. */
  chars: z.int().nonnegative(),
  /** The SHA-256 of the text, in hex: kept with `hashed` and `full`. */
  sha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/u)
    .optional(),
  /** The text, or with `redacted` the text with matches of the profile's patterns replaced. */
  text: z.string().optional(),
  /** For a tool result, the tool it answers, by its call's id in the same request (ADR-0026). */
  tool: z.string().optional(),
});
export type PromptMessage = z.output<typeof PromptMessage>;

/**
 * A tool call a model asked for (ADR-0025). The proxy hands the runner its
 * arguments; what is written to files depends on the profile's `prompts.store`.
 */
export const ToolCall = z.object({
  name: z.string(),
  /** The length of the arguments' text, in UTF-16 code units. */
  chars: z.int().nonnegative(),
  /** The SHA-256 of the arguments' text, in hex: kept with `hashed` and `full`. */
  sha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/u)
    .optional(),
  /** The arguments as the model sent them, or with `redacted` their matches replaced. */
  arguments: z.string().optional(),
});
export type ToolCall = z.output<typeof ToolCall>;

/**
 * The text a model answered (ADR-0033). The proxy hands the runner the text;
 * what is written to files depends on the profile's `prompts.store`.
 */
export const ModelOutput = z.object({
  /** The length of the text, in UTF-16 code units. */
  chars: z.int().nonnegative(),
  /** The SHA-256 of the text, in hex: kept with `hashed` and `full`. */
  sha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/u)
    .optional(),
  /** The text, or with `redacted` the text with matches of the profile's patterns replaced. */
  text: z.string().optional(),
});
export type ModelOutput = z.output<typeof ModelOutput>;

/**
 * A model call as a cassette keeps it (ADR-0040): which turn and call it was,
 * a hash of what the app sent, and the answer the provider gave, in full. It
 * holds no request text and no credential.
 */
export const CassetteCall = z.object({
  /** The turn's key, as ADR-0017 seeds jitter: case, sample and turn. */
  turn: z.string().min(1),
  /** The call's position among the turn's calls, from 0, in the order they arrived. */
  position: z.int().nonnegative(),
  upstream: Id,
  /** The path below the upstream base URL, without the query. */
  path: z.string(),
  requestSha256: z.string().regex(/^[0-9a-f]{64}$/u),
  status: z.int(),
  contentType: z.string(),
  /** The answer's body as the provider sent it, decoded; a stream as its text. */
  body: z.string(),
});
export type CassetteCall = z.output<typeof CassetteCall>;

/**
 * A model swap (ADR-0042): each call to `upstream` that asks for `asked` goes
 * to `model` instead, on `to` when given, another upstream of the same kind.
 */
export const ModelSwap = z.strictObject({
  upstream: Id,
  asked: z.string().min(1),
  model: z.string().min(1),
  to: Id.optional(),
});
export type ModelSwap = z.output<typeof ModelSwap>;

/** A model call read from an OpenTelemetry span (ADR-0029). */
export const SpanCall = z.object({
  /** The W3C trace id, in hex: it ties the call to a turn. */
  traceId: z.string(),
  spanId: z.string(),
  /** gen_ai.provider.name, or gen_ai.system. */
  provider: z.string().nullable(),
  model: z.string().nullable(),
  startedAt: z.iso.datetime(),
  durationMs: z.number().nonnegative(),
  usage: ProxyUsage,
  error: z.boolean(),
});
export type SpanCall = z.output<typeof SpanCall>;

export const ProxyRecord = z.object({
  id: z.string().min(1),
  upstream: Id,
  kind: z.enum(['openai-compatible', 'anthropic', 'gemini']),
  method: z.string().min(1),
  /** The path below the upstream base URL, without the query. */
  path: z.string(),
  model: z.string().nullable(),
  startedAt: z.iso.datetime(),
  durationMs: z.number().nonnegative(),
  /** null when no response came back. */
  status: z.int().nullable(),
  stream: z.boolean(),
  usage: ProxyUsage,
  /** The x-yokla-trace header the call carried, or null. */
  trace: z.string().nullable(),
  /** The turn the runner marked as in flight when the call started, or null (serial correlation). */
  mark: z.string().nullable().optional(),
  /** The fault injected into this call, and whether it could apply (ADR-0013). */
  fault: z.object({ kind: z.string(), applied: z.boolean() }).optional(),
  /** false when the proxy answered without calling the provider. */
  forwarded: z.boolean().optional(),
  error: z.string().optional(),
  /** The messages the call sent (ADR-0015); null when the proxy couldn't read the request. */
  prompt: z.array(PromptMessage).nullable().optional(),
  /** The names of the tools the call offered (ADR-0025); null when the request couldn't be read. */
  tools: z.array(z.string()).nullable().optional(),
  /** The tool calls the model asked for, in order (ADR-0025); null when the answer couldn't be read. */
  toolCalls: z.array(ToolCall).nullable().optional(),
  /** The text the model answered (ADR-0033); null when the answer couldn't be read. */
  output: ModelOutput.nullable().optional(),
  /** The call as a cassette keeps it, when the recording captures (ADR-0040). */
  capture: CassetteCall.optional(),
  /** Set when the proxy answered from a cassette, or found no call in it to answer with (ADR-0040). */
  replay: z.object({ diverged: z.boolean() }).optional(),
  /** The model the app asked for, when a swap sent the call to another (ADR-0042). */
  asked: z.string().optional(),
});
export type ProxyRecord = z.output<typeof ProxyRecord>;
