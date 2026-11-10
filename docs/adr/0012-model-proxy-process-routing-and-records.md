# 0012. The model proxy: a standalone process, routing, records and correlation

Status: Proposed · Date: 2026-11-10

## Context

v0.2 adds the model proxy (design §12). Its exit criterion: cost on the
demo-shop and on one real target reconciles with the provider's usage
records. Design §12 fixes the interfaces (OpenAI-compatible and Anthropic
Messages, with SSE), the setup (the app's provider base URL points at
`http://127.0.0.1:<port>/<upstream-id>`, the app's own credentials pass
through, localhost only) and the correlation modes. It leaves these open:
- **How the proxy runs.** The app reads its provider base URL when it starts,
  so the proxy's address must be known and reachable before the app starts,
  and between runs.
- **What a record holds**, where it lives, and how a run reads it.
- **How unmeasured values behave.** For example, a stream without usage data.
- **How the demo-shop, whose model is in-process today, can be measured.**

The first real target examined can't be proxied as it is:
- it reaches its models through an AI gateway protocol and a cloud provider's
  own API, neither of them OpenAI-compatible or Anthropic;
- it has no setting that redirects their base URL.

Its cost is observed through its logs (ADR-0009).

## Decision

- **A standalone process.** `yokla proxy --profile <file>` runs until stopped,
  binds to `127.0.0.1` only, and forwards every call, recording or not.
  - The app stays pointed at it, so the app works between runs.
  - `yokla run` talks to it over a local control endpoint on the same port,
    under `/_yokla/`, which is never forwarded. It reads the records of its
    own time window after the run.
  - The proxy lives in `packages/proxy`, which depends only on `core`
    (layer rules). It holds no keys.
- **Routing.** The profile's `modelProxy.upstreams` lists each upstream:
  - an `id`,
  - a `kind` (`openai-compatible` or `anthropic`),
  - the upstream base URL.

  A call to `/<id>/<rest>` goes to `<upstream>/<rest>`. The proxy contacts
  only these URLs (ADR-0003).
- **Transparent by default.** In measuring mode the proxy never changes a
  request or a response. A stream that carries no usage data is recorded with
  `unmeasured` tokens; the proxy doesn't add options to make the provider
  report them.
- **Records.** One JSON line per call, in a local file the proxy appends to:
  - the upstream, kind, model, start time, duration, status, whether it
    streamed,
  - usage: input, output, cached input, cache write and reasoning tokens. A
    token kind the provider didn't report is `null`, never `0`;
  - the trace header the call carried, if any.

  Credentials and other headers are never recorded. Prompts are recorded
  only for inspection checks, and can be redacted or hashed (design §12).
- **Correlation.** `results.v1` gains, per turn, the attributed calls and
  their totals, and `run.correlation` names the mode (design §12):
  - `serial`: concurrency is forced to 1; a call belongs to the turn whose
    request was in flight when the call started. Calls outside every window
    are reported as unattributed.
  - `header`: the app forwards the request id yokla sent, as `x-yokla-trace`,
    to its provider calls.
  - `traceparent` comes later.
- **Cost.** `yokla.config.yaml` gains a price table per upstream and model:
  input, output, cached input and cache write, in USD per million tokens.
  - A call whose model has no price, or whose tokens are unmeasured, has a
    `null` cost.
  - Totals leave such calls out and count them, as ADR-0009's observation
    does.
  - When the target's logs also report a cost, both are shown, and the
    proxy's is the one the cost suite uses.
- **The demo-shop calls a model over HTTP.** It gains an option to put its
  answers into words through an OpenAI-compatible endpoint. The examples gain
  a deterministic fake provider that answers, reports usage and keeps its own
  usage log. "Reconciles with the provider's usage records" is checked against
  that log, at no cost.
- **Out of scope for this ADR.** Fault plans and inspection checks get their
  own ADR. So do other protocols, such as cloud providers' own APIs and AI
  gateways. Until such an adapter exists, targets that use those protocols
  are observed through their logs.

## Consequences

- **Two processes to start.** The proxy is started before the app; the app is
  pointed at it once. The run fails early with exit code `2` when the profile
  declares a proxy that doesn't answer.
- **The proxy sees every call of the app,** including calls outside test
  runs. It records them only while recording is on; outside that, it only
  forwards.
- **v0.2's real target needs an OpenAI-compatible or Anthropic provider with a
  configurable base URL.** The target examined so far needs either:
  - a protocol adapter, and a base-URL setting in the app, or
  - to be replaced, for this criterion, by another target.
- **Unmeasured stays visible.** Missing usage never becomes a lower cost.

## Alternatives considered

- **A proxy started inside `yokla run`.** One process is simpler, but the app's
  model calls would fail whenever no run is active, and the port would have
  to be fixed in the app's configuration anyway.
- **Adding `stream_options.include_usage` to streamed requests.** It would make
  streamed usage measurable, but it changes what the provider sends back to
  the app. It could be an explicit opt-in later.
- **Reading usage only from the target's logs.** That is ADR-0009, for targets
  the proxy can't see. Self-reported numbers can be wrong, and the proxy is the
  independent measure.
