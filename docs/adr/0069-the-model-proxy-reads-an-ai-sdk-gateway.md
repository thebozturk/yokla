# 0069. The model proxy reads an AI SDK gateway

Status: Accepted · Date: 2026-11-18

## Context

The model proxy reads three families of APIs: OpenAI-compatible ones,
Anthropic's Messages (ADR-0012), and Gemini's native API (ADR-0032). For
those it reads the model, the tokens, the prompts, the tools offered, the
tool calls and the tool results; it can answer with a fault (ADR-0013),
swap the model (ADR-0042) and change a tool result (ADR-0043).

Many apps built on the Vercel AI SDK reach their models through Vercel's AI
Gateway with the SDK's own gateway provider. That provider speaks neither
family:

- **One endpoint for every model.** A language model call is
  `POST <base>/language-model`. The model is in the
  `ai-language-model-id` header, and whether to stream in
  `ai-language-model-streaming`.
- **The body is the SDK's own call.** `prompt` is a list of messages with
  `system`, `user`, `assistant` and `tool` roles. A tool message holds
  `tool-result` parts that name their call and tool, with an `output` that
  is text, JSON, an error or a list of parts. `tools` lists the functions
  offered, each with an `inputSchema`.
- **The answer is the SDK's own result.** A plain answer is JSON with
  `content` parts (`text`, `tool-call`, `reasoning`), a `finishReason` and
  `usage`. A streamed one is server-sent events of the SDK's stream parts,
  ending in a `finish` part that holds the usage.

Through the proxy, such an app's calls are forwarded but can't be read. The
private target of design §19 is such an app. Indirect injection through a
tool result (ADR-0043) could not be tested on it for that reason, in
addition to a second one: the target builds its gateway client without a
base url, and the provider reads none from the environment. That one is
the target's to change.

## Decision

### A fourth upstream kind

- **`kind: ai-gateway`** reads the AI SDK gateway protocol. Its
  `upstream` is the gateway's base url, such as
  `https://ai-gateway.vercel.sh/v4/ai`. The app points its gateway
  provider's `baseURL` at `http://127.0.0.1:<port>/<id>`.
- **The app's credentials pass through,** as for the other kinds: the
  `Authorization` header and the gateway's own headers are forwarded, and
  never recorded.
- **Only the language model endpoint is read.** Other endpoints, such as
  `/config`, embeddings or images, are forwarded and recorded with their
  usage unmeasured, as Gemini's other calls are (ADR-0032).

### What it reads

- **The model:** the `ai-language-model-id` header; the answer's
  `response.modelId` when it names one.
- **Streaming:** the `ai-language-model-streaming` header.
- **The prompts:** `system` messages as the system prompt; `user`,
  `assistant` and `tool` messages as the conversation, a `tool-result`
  part as a tool message that names its tool (ADR-0026).
- **The tools offered:** `tools`, each function's name and its
  `inputSchema` (ADR-0025).
- **The tool calls asked for:** the answer's `tool-call` parts, from the
  JSON result or from the stream's `tool-call` parts.
- **The answer's text:** its `text` parts, or the stream's `text-delta`s.
- **The tokens,** from `usage`:
  - input is its total input tokens, and cached input its cache reads;
  - a cache write is its cache writes when reported, else null;
  - output is its total output tokens, reasoning shown apart when
    reported;
  - a field the gateway leaves out is null, never zero (design P5).

### What it changes

- **A fault** takes the gateway's error shape: a JSON body with an
  `error` that has a `message` and a `type`, and the status the fault
  names (ADR-0013).
- **A model swap** rewrites the `ai-language-model-id` header, not the
  body (ADR-0042).
- **A tool result change** (ADR-0043) applies to a `tool-result` part's
  `output`: with `at`, to the JSON value of a `json` output; without it,
  to the text of a `text` output, on a new line. An output of another
  type is left as it is, and the change is reported as not applied.

### The measure

- **Unit tests** for each reading and each change, on bodies and streams
  written for the tests from the protocol as the SDK sends it, with
  input-mutation tests.
- **An end-to-end test:** a client that sends the protocol as the SDK
  does, pointed at the proxy, with a fake gateway upstream. yokla takes no
  dependency on the SDK for it. The proxy reads its model,
  tokens, prompts, tool calls and tool results; a tool result change
  reaches the fake upstream; a fault and a swap apply.
- **The demo-shop doesn't change.** It calls no model through a gateway.
- **The private target** is measured only once it can be pointed at the
  proxy. That is the target's change, outside this repository.

## Consequences

- **An app on the AI SDK's gateway can be tested like any other:** its
  cost, its prompts and tools, its faults, and indirect injection through
  its tool results.
- **The protocol is the SDK's, and it may change.** It carries a version
  header. The proxy reads specification version 4 and records a call of
  another version with its usage unmeasured, so a change is seen, never
  misread.
- **The app must let its base url be set.** Without it, nothing can stand
  between it and the gateway, as for any provider.

## Alternatives considered

- **Point the app at the gateway's OpenAI- or Anthropic-compatible
  endpoints instead.** That changes the app's provider code, not just a
  setting, and tests a path production doesn't take. Rejected.
- **Read the calls from the app's OpenTelemetry spans** (ADR-0029). Spans
  show usage and sometimes prompts, but the proxy can't change a tool
  result or answer with a fault from them. Rejected for what this ADR is
  for; spans stay an alternative for cost.
- **A general "JSON at any path" upstream,** configured by the person.
  Each protocol's streaming and usage need their own reading. Rejected.
