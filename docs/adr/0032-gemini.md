# 0032. Gemini: the model proxy and yokla's own calls

Status: Accepted · Date: 2026-11-15

## Context

The model proxy reads two families of APIs (ADR-0012): OpenAI-compatible
ones, and Anthropic's Messages API. yokla's own model calls take the same two
(ADR-0028).

An app on Google's Gemini models can reach them in two ways:

- **Through Gemini's OpenAI-compatible endpoint.** The proxy reads it already,
  as `openai-compatible`.
- **Through the native API,** which Google's own SDKs use:
  - on AI Studio, `generativelanguage.googleapis.com`, with an API key;
  - on Vertex AI, `aiplatform.googleapis.com`, with an OAuth token.

The native API differs from both families the proxy knows:

- the model is in the url, not the body;
- streaming is a separate method;
- messages are `contents` of `parts`, and tools are `functionDeclarations`;
- usage is `usageMetadata`, with thinking tokens apart from the output.

Through the proxy, such an app's calls are forwarded but can't be read: no
model, no tokens, no prompts, no tool calls.

v0.3 plans a Gemini protocol adapter, for AI Studio and Vertex.

## Decision

### An upstream of kind `gemini`

```yaml
modelProxy:
  upstreams:
    - id: gemini
      kind: gemini
      upstream: https://generativelanguage.googleapis.com
```

- **One kind for AI Studio and Vertex.** Both speak the same protocol, and
  only their paths and credentials differ:
  - AI Studio: `/v1beta/models/{model}:generateContent`;
  - Vertex AI: `/v1/projects/{project}/locations/{location}/publishers/google/models/{model}:generateContent`.
- **The app's credentials pass through,** as for every upstream: an
  `x-goog-api-key` header, a `key` query parameter, or an `Authorization`
  bearer token. Records never hold one. They keep the path without its query,
  so not even a `key` parameter.
- **The app points its SDK at the proxy** through its base url option, at
  `http://127.0.0.1:<port>/<id>`.

### What the proxy reads

- **Model calls.** `generateContent` answers with JSON. `streamGenerateContent`
  answers with server-sent events (`alt=sse`), or else with a JSON array of
  the same answers. Any other call, such as `countTokens` or `embedContent`,
  is forwarded and recorded with its usage unmeasured.
- **The model.** `modelVersion` from the answer, or else the model in the url.
- **Usage, from `usageMetadata`;** in a stream, from the last event that has
  it.

  | yokla | Gemini |
  |---|---|
  | input | `promptTokenCount`, plus `toolUsePromptTokenCount` |
  | cached input | `cachedContentTokenCount`, part of the input |
  | output | `candidatesTokenCount`, plus `thoughtsTokenCount` |
  | reasoning | `thoughtsTokenCount`, part of the output |
  | cache write | not reported: null |

  - Input and output hold every token billed as such, as for the other
    kinds.
  - A count the answer doesn't give is null, never 0.
- **Prompts (ADR-0015).**
  - `systemInstruction` is the system message.
  - Each of `contents` is a message: role `user` stays `user`, and `model`
    becomes `assistant`.
  - A message's text is that of its `text` parts. Other parts, such as inline
    data, add none.
- **Tools (ADR-0025, ADR-0026).**
  - The tools a call offers are the names of `tools[].functionDeclarations`.
  - The tools the answer asks for are its `functionCall` parts, with `args`
    as the arguments' JSON text.
  - A `functionResponse` part is a tool message that names its tool, with its
    `response` as the text. `modelProxy.toolResults` reads it as it reads the
    other kinds' tool results.

### Faults (ADR-0013)

Every fault applies to a `gemini` upstream, in its shapes:

- **An error status** has Gemini's error body:
  `{"error": {"code", "message", "status"}}`, with `RESOURCE_EXHAUSTED`,
  `INTERNAL` or `UNAVAILABLE`.
- **Empty content** empties the `text` parts of the candidates.
- **Invalid tool-call arguments** turn a `functionCall`'s `args` into text
  that isn't a JSON object.
- **Latency, a timeout, malformed JSON and a cut stream** apply as they do for
  any upstream.

### yokla's own calls

`models.customer` (ADR-0028) takes `kind: gemini`:

```yaml
models:
  customer:
    kind: gemini
    url: https://generativelanguage.googleapis.com/v1beta
    model: gemini-2.5-flash
    apiKeyEnv: GEMINI_API_KEY
```

- **The call.** `{url}/models/{model}:generateContent`, with the persona and
  goal as `systemInstruction`.
- **The settings.** `temperature`, `maxOutputTokens`, and the sample's seed as
  `seed`.
- **The key.** It goes in `x-goog-api-key`. With `auth: bearer`, it goes as an
  `Authorization` bearer token instead, as Vertex AI takes it, with a url such
  as `https://aiplatform.googleapis.com/v1/projects/P/locations/global/publishers/google`.
- **Its usage** is read as the proxy reads it.

### The demo-shop

- **The fake provider speaks Gemini too,** at
  `/v1beta/models/{model}:generateContent` and `:streamGenerateContent`.
  - It answers as it does over chat completions.
  - It reports `thoughtsTokenCount`, so the reasoning mapping is tested.
  - It records its usage in the same log.
  - It plays the simulated customer there too.
- **The demo-shop's model client takes `--model-protocol gemini`.** It then
  calls the native API instead of chat completions, with the same tools.
- **The tests.**
  - The proxy end-to-end test runs the acceptance with the model over HTTP in
    Gemini's protocol, with JSON answers and with streams. The proxy's
    measurement reconciles with the provider's records, call for call and
    token for token.
  - The tool cases and one resilience matrix run in Gemini's protocol too.
  - The simulated customer's test runs once with a `gemini` customer model.

## Consequences

- **An app on Gemini's native API is measured** like one on the other two
  families: cost, tokens, prompts, tool calls and faults.
- **One kind serves both AI Studio and Vertex.** A new hosting of the same
  protocol needs no new kind.
- **Thinking tokens count as output,** as Google bills them, and show apart
  as reasoning.
- **Embeddings on Gemini stay unmeasured** until their usage is read; their
  calls are recorded.
- **Prices are per upstream id and model,** so `prices.gemini.gemini-2.5-flash`
  as for any other kind.

## Alternatives considered

- **Only the OpenAI-compatible endpoint.** It works today, but apps on Google's
  SDKs use the native API, and Vertex's native paths aren't
  OpenAI-compatible. Rejected.
- **A kind each for AI Studio and Vertex.** The protocol is the same; only the
  paths and credentials differ, and the proxy passes credentials through.
  Rejected.
- **Google's SDK in yokla.** yokla needs one call and a usage block, and an SDK
  adds supply-chain surface. Rejected.
- **The Live API and other realtime sessions.** They run over WebSockets, and
  no target needs them yet. Deferred.
