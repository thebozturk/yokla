# 0029. Model calls read from OpenTelemetry spans

Status: Accepted · Date: 2026-11-14

## Context

The model proxy sees a target's model calls when the app's client can be
pointed at it (ADR-0012). Some targets can't do that:

- an SDK whose endpoint is fixed;
- a managed agent service;
- a call made from a process yokla doesn't start.

Many apps already describe their model calls as OpenTelemetry spans. The
GenAI conventions give each call:

- its operation;
- its provider;
- its model;
- its token counts;
- its duration.

v0.3 plans to read model calls from those spans, for targets the proxy can't
see. Its exit criterion: on the demo-shop, calls read from spans match the
proxy's records.

Design §12 plans a third correlation, `traceparent`: W3C trace context, when
the app propagates it. results.v1 already has it as a correlation value.

## Decision

### Receiving spans

- **Where they arrive.** `yokla proxy` accepts OTLP/HTTP trace exports at
  `/_yokla/otlp/v1/traces` on its port.
  - It reads both JSON and protobuf, gzipped or not.
  - It keeps spans only while a recording is open, as it does calls.
- **How a profile turns them on.** It sets `modelProxy.spans`. `upstreams`
  may then be empty, for a target whose calls only spans show.

  ```yaml
  modelProxy:
    upstreams: []
    spans: { quietMs: 6000, maxWaitMs: 20000 }
  ```

- **What the app sets.** It points its exporter at the proxy, for example with
  `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://127.0.0.1:8787/_yokla/otlp/v1/traces`.
- **gRPC is left for later.** Most SDKs also export over HTTP.

### Which spans are model calls

- **A span is a model call when it has `gen_ai.operation.name`.** yokla reads
  only these attributes:

  | Field | Read from |
  |---|---|
  | provider | `gen_ai.provider.name`, else `gen_ai.system` |
  | model | `gen_ai.response.model`, else `gen_ai.request.model` |
  | input and output tokens | `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens` |
  | cache reads and writes | `gen_ai.usage.cache_read.input_tokens`, `gen_ai.usage.cache_creation.input_tokens` |
  | duration | the span's start and end |
  | failure | an `ERROR` status, or `error.type` |

  - A count the span doesn't give is `null`, never 0.
  - Older and newer attribute names are both read: the conventions are still
    being settled.
- **Message contents are never read or stored,** in attributes or in events.

### Tying spans to turns

- **`traceparent`.** When spans are on, the runner sends each turn a W3C
  `traceparent` header with a new trace id.
  - A span belongs to the turn whose trace id it carries.
  - The app must pass the incoming context on to its model calls. OpenTelemetry's
    HTTP server instrumentation does.
  - A span from any other trace is unattributed, and counted.
- **Any concurrency.** Unlike `serial`, it allows several cases at once.
- **HTTP targets only.** A WebSocket target sends its headers once
  (ADR-0024).
- **Alongside the proxy.** With both on, the proxy keeps its own correlation
  for its calls, and spans use `traceparent`.

### Waiting for spans

- **Spans come late.** Exporters send spans in batches, five seconds apart by
  default.
- **The run waits once, at its end.** It waits until no new span has come for
  `spans.quietMs` (6000 ms by default), or until `spans.maxWaitMs` (20000 ms)
  runs out. It says when it ran out.
- **A shorter wait.** An app can export sooner with `OTEL_BSP_SCHEDULE_DELAY`,
  and the profile can then lower `quietMs`.

### What the results and checks get

- **Each turn keeps the calls of its spans,** as `spans`, next to `proxy`.
  Each call has:
  - its provider and model;
  - its duration and token counts;
  - its cost, priced by `prices.<provider>.<model>`.
- **The run keeps a summary of the spans,** as it does of the proxy's calls.
- **When spans stand in for the proxy.** A turn without proxy calls gives the
  checks the calls of its spans instead. `cost-budget` and `prompt-budget`'s
  token limit can then judge it.
- **What still needs the proxy.**
  - Prompt inspection (ADR-0015), because spans carry no prompts here.
  - Tool calls (ADR-0025).
- **The cost cap and `yokla plan`.**
  - They count the costs of spans where the proxy has none.
  - A span that comes after the cap was checked is counted at the next check.

### The demo-shop

- **It exports spans.** With `--otel-url` and the model over HTTP, it sends a
  GenAI span for each model call.
  - The span continues the incoming `traceparent`.
  - `--otel-protocol json`, the default, or `protobuf`, selects the encoding.
- **It needs no dependency.** Its exporter is written for it. yokla's reader
  is written apart, so each checks the other.
- **The test.** The proxy end-to-end test runs the acceptance cases with the
  model over HTTP, through the proxy, with spans on, once per protocol. For
  every turn, the calls read from spans match the proxy's records: the same
  count, models and token counts, in the same order.

## Consequences

- **The proxy can't reach a target's model calls, but spans can show them.**
  Such a target gets its cost, token budgets and latency of model calls
  measured, from spans.
- **No context, no attribution.** A target that doesn't propagate
  `traceparent` gets every span unattributed. The run says so, rather than
  guessing by time.
- **Spans are a thinner view.** They show no prompts or tool calls here, so
  those checks stay with the proxy.
- **A run with spans ends later,** by up to `maxWaitMs`.
- **The conventions may change.** The reader takes both the current and the
  older names, and a new name needs a small change.

## Alternatives considered

- **A separate receiver process.** `yokla proxy` already is yokla's local
  listener during a recording. A second process would be one more thing to
  start. Rejected.
- **gRPC export.** It needs HTTP/2 and the service definitions, and most SDKs
  also export over HTTP. Deferred.
- **Reading span files that a collector writes.** Like the target's logs
  (ADR-0009), it would work without a live receiver. Deferred until a target
  needs it.
- **Tying spans to turns by time.** ADR-0012 rejected clock-based attribution
  for calls, and batching makes time even less reliable for spans. Rejected.
- **OpenTelemetry's own libraries.** The part yokla reads is small. A
  dependency for it would add supply-chain surface. Rejected.
