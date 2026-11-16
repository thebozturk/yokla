# Changelog

Notable changes per version. Versions follow the roadmap in
[design §20](docs/design.md#20-roadmap); a version ships when its exit criteria
hold.

## Unreleased

- **Recorded model calls, replayed (ADR-0040).** `yokla run --record` keeps
  the target's model calls in a cassette, and `--replay` answers them from
  it, calling no provider, so a suite repeats at no model cost. A call the
  cassette has no match for makes its case `error`, or with `--replay-loose`
  is answered by position. A new fault kind, `answer`, replaces the text of
  the model's answer, on a live call or a replayed one.
- **yokla as an MCP server for coding agents (ADR-0041).** `yokla mcp` serves
  `list_cases`, `run_cases`, `explain_finding`, `shrink_case` and
  `verify_fix` over stdio. The person fixes the profile, cases and target at
  start, and a session that can spend needs `--max-cost`, which covers every
  run of the session.
- **Comparing models through the proxy (ADR-0042).** `yokla run --swap-model
  <upstream>:<asked>=<model>` sends the calls that ask for a model to
  another, in the same protocol, and each call keeps the model asked for.
  `yokla compare` sets runs side by side, gates each, and names the cheapest
  that passes.

## 0.3.0 — 2026-11-15

Reach and conversations: a first run in five minutes, more ways to reach a
target and see its model calls, checks on the tools it calls, a simulated
customer, and the first steps from a finding to its fix. yokla is on npm from
this version.

**Exit criteria.**
- **`yokla init` writes a profile that needs no edit for the starter cases,**
  on the demo-shop and on an open-source assistant. The starter cases then
  run and gate.
- **The demo-shop's tool-call defects are detected,** each by its own check.
- **The simulated customer reaches each demo-shop purchase goal,** and a run
  repeats from its seed.
- **On the demo-shop, model calls read from OpenTelemetry spans match the
  proxy's records.**
- **Published to npm,** from CI with trusted publishing and a provenance
  statement for every package (ADR-0034, ADR-0037).

### Added

- **`yokla init` and starter cases (ADR-0018, ADR-0019).** One message to
  the target, and yokla works out where the answer is in its JSON or event
  stream. It writes a profile for review and starter cases that suit any
  assistant: a greeting, out of scope, a basic injection, personal data, an
  empty or very long message, a switch of language and a deadline. It makes
  no model call. An edge-case turn is judged on whether the target handled
  it.
- **Richer evidence mapping (ADR-0020, ADR-0021, ADR-0022, ADR-0027).**
  - One collection can be read from several paths.
  - Stock can be given only as in or out of stock.
  - Amounts may be quoted from price sources other than the shown products,
    such as an order history.
  - The answer text can be read from several paths.
  - A price times a stated quantity, and a total of the answer's own amounts,
    count as grounded.
  - A product can be named by the shortest start of its name that no other
    product shares.
- **An offline HTML report (ADR-0023).** `yokla report --html` shows each
  answer next to its findings, in one file with nothing to fetch.
- **WebSocket targets (ADR-0024).**
- **Tool calls (ADR-0025, ADR-0026).** The proxy reads the tools each model
  call offers and the calls it asks for. A case can say which tools must and
  must not be called, with what arguments, in what order and how often.
  Products the model saw in a tool result count as evidence.
- **The simulated customer (ADR-0028).** A case can give a persona and a goal
  instead of fixed turns. A model of your choice, local or hosted, plays the
  customer, and the deterministic checks judge every answer. The goal counts
  as reached only when the answer shows it. Replies are cached, so a rerun
  repeats the conversation. This is yokla's first model use of its own, with
  its cost counted apart from the target's.
- **Model calls from OpenTelemetry spans (ADR-0029),** for an app whose
  client can't be pointed at the proxy.
- **Generic checks (ADR-0030).** Regular expressions, a JSON Schema for the
  response, similarity to reference answers, and checks the user writes as a
  small module the configuration names.
- **Tokens yokla obtains (ADR-0031).** OAuth 2.0 client credentials or a
  login, refreshed when they expire, and kept out of everything yokla writes.
- **Gemini (ADR-0032).** The proxy reads Gemini's native API, on AI Studio
  and Vertex AI, and yokla's own calls can use it.
- **Where a failure arose (ADR-0033).** A failing finding that names a value
  says where the value first appears: in what the model was sent, in what it
  answered, or only in the app's answer.
- **`yokla shrink` (ADR-0035, ADR-0036).** It cuts a failing case down to the
  fewest turns that still fail the same check, with the samples needed to
  tell a real failure from chance, and writes it as a proposed case. A flaky
  failure is reported as flaky.
- **`yokla run --stop-early` (ADR-0038, ADR-0039).** A case stops its samples
  once no further sample can change its failure. A passing case runs every
  sample.
- **Fault jitter seeded by case, sample and turn (ADR-0017),** so a fault's
  delay repeats across runs.
- **demo-shop.** Tool-call defects, a simulated shopper's goals, spans, a
  WebSocket endpoint, token issuing, Gemini's native protocol, a price defect
  from each origin, a flaky price, and a majority-of-N failure.
- **Packages (ADR-0034).** Every package ships its README, the licence and
  its sources. `pnpm pack-check`, run in CI, installs the packed packages
  into an empty project and runs `yokla` there against the demo-shop.

## 0.2.0 — 2026-11-12

The model proxy: see the model calls an assistant makes, what they cost and
what they send, and how the assistant behaves when its provider fails.

**Exit criteria.**
- **Cost on the demo-shop reconciles with the provider's records.** The
  demo-shop calls a fake provider over HTTP through `yokla proxy`, with serial
  and header correlation, JSON answers and event streams, and a model call
  after every answer. The proxy's calls and tokens equal the provider's own
  usage records, call for call, and the acceptance cases still pass. CI runs
  it on Node.js 24 and 26.
- **Cost on a real target reconciles with the provider's records.** The target
  is an open-source retail assistant that streams its answers, opens its own
  sessions and calls its model after answering. It ran with a hosted model
  gateway as its provider. Over a ten-turn run of 34 model calls, each call's
  tokens and cost equal the gateway's records, to its eight decimals. The
  first trial found that the proxy read only the output count of a streamed
  Anthropic answer. That was fixed before the run.
- **Resilience defects are detected.** The demo-shop has three seeded
  resilience defects. Each is caught by exactly its own check on exactly the
  expected cases, and the defect-free run passes every resilience case. The
  four prompt inspection defects are caught the same way.

### Added

- **Model proxy (ADR-0012).**
  - `yokla proxy` runs a proxy on `127.0.0.1` from the profile's
    `modelProxy`. The app points its OpenAI-compatible or Anthropic client at
    it. Calls pass through unchanged, event streams and compressed bodies
    included.
  - Each call is recorded with its model, timing, status and usage, from chat
    completions, the Responses API, embeddings and Anthropic Messages, as JSON
    or event streams. A token kind the provider didn't report is null, never
    0. No credential or other header is recorded.
  - `serial` correlation ties a call to the turn in flight when it started.
    `header` correlation uses `x-yokla-trace`, in parallel runs too. Calls
    tied to no turn are counted, never dropped.
  - `--records` appends every recorded call to a JSON Lines file.
- **Cost.** `prices` in `yokla.config.yaml`, per upstream and model. Results
  carry each turn's calls and cost and the run's totals. A call without a
  price or with unmeasured tokens costs null.
- **Fault plans (ADR-0013).**
  - A turn declares `faults`: a `429`, `500` or `503` status, latency, a
    timeout, malformed JSON, empty content, a truncated stream or invalid
    tool-call arguments.
  - The proxy applies them only to that turn's calls.
  - `graceful-under-fault` judges the answer under faults, and
    `answered-within-deadline` judges the new `deadlineMs` expectation.
- **Budgets and plan (ADR-0014).**
  - `budget: { costUsd, modelCalls }` per turn, judged by `cost-budget`.
  - Gate thresholds per suite: `latencyP50Ms`, `latencyP95Ms`,
    `costPerTurnUsd` and `costUsd`.
  - A check can report a dimension as `unmeasured`. A threshold without data
    is an unmeasured breach unless the suite allows it.
  - `yokla plan` estimates a run's cost from a calibration run, with an upper
    bound. It contacts nothing, and it refuses to guess without data.
  - `yokla run --max-cost` stops starting samples once the cap is reached.
    The results are partial, and the gate can't judge them.
- **Prompt inspection (ADR-0015).**
  - The proxy captures the messages each call sends.
    `modelProxy.prompts.store` keeps `sizes` (the default), `hashed`,
    `redacted` or `full` prompts.
  - Four checks:
    - `prompt-budget`, on `budget.inputTokens`;
    - `prompt-leak`, with a canary in the system prompt;
    - `untrusted-in-system`, for retrieved content placed in a system message;
    - `pii-in-prompt`, for the `notSentToModel` values.

    Findings never contain prompt text.
- **Streaming targets, session setup and calls after the answer (ADR-0016).**
  - `response.stream` reads answers streamed as server-sent events or
    newline-delimited JSON. The profile's paths read the stream as one
    document. Results add `firstTextMs`.
  - `session.open` sends a request before the first turn. Its values can be
    carried to every turn, in the body or the headers.
  - In serial correlation the runner waits after each answer until the
    target's model calls stop (`modelProxy.settle`). A memory or summary call
    then counts for the turn that caused it.
- **demo-shop.**
  - The model runs over HTTP through a fake provider that keeps its own usage
    records.
  - Resilience behaviour, with three resilience defects.
  - Four prompt inspection defects.
  - Streamed answers, sessions it issues, and a summary call after each
    answer.
- **Egress test (ADR-0003).** The proxy end-to-end tests run behind the
  network guard, which allows only the demo-shops, the proxy and the fake
  provider.

### Fixed

- **`price-grounded` applied without a price to check against.** With no
  priced product in the conversation, as when the profile maps no evidence,
  every amount counted as invented. It now applies only when the evidence has
  a price (design §10).
- **`policy-claim` applied when the profile lists no policies.** Every
  concrete claim then counted as having no source. It now applies only when
  the profile lists policies (design §10).

## 0.1.0 — 2026-11-10

The core: test an assistant over HTTP with a hand-written profile, and judge
its answers deterministically against your data.

**Exit criteria.**
- **Every demo-shop defect is detected.** The demo-shop has eight seeded
  defects. Each is caught by exactly its own check on exactly the expected
  cases, and the defect-free run passes every case. CI runs this matrix on
  Node.js 24 and 26.
- **A real assistant was tested with a hand-written profile.** It is a private
  production e-commerce assistant, tested both without and with model calls.

### Added

- **Schemas.**
  - `profile.v1`, `cases.v1`, `config.v1`, `results.v1` and
    `baseline.v1` are defined in Zod, and their JSON Schemas are generated
    (`yokla schema <name>`).
  - Config files are YAML 1.2, and problems are reported as `file:line:column`.
- **HTTP adapter.**
  - Request templates and a response mapping, with evidence fields, fallbacks
    and conversions.
  - A request id header, and server-issued ids carried between turns.
  - Client sessions.
- **Runner.**
  - A token bucket per second, minute and hour, and `429` handling with
    `Retry-After` and tiered headers in seconds or milliseconds.
  - An optional TEST-NET client identity per case.
  - A cache bypass by header or by a local command (an argument list, never a
    shell).
  - Samples and concurrency.
  - Clarifying questions are recognised by route.
- **Observation from the target's logs (ADR-0009).**
  - Reads a log file or a local command once after the run.
  - Ties each turn to its line by request id, target id or order.
  - Totals the mapped fields. A sum with an unmeasured value is null, not a
    smaller number.
- **Checks.** Deterministic, with `applicable: false` when their input is
  absent.
  - Core: route, answer text, evidence counts.
  - E-commerce:
    - prices,
    - stock claims,
    - policy claims against their sources,
    - over-refusal and refusal correctness,
    - filter honesty,
    - product types,
    - duplicates,
    - absent types,
    - deflection (advisory).
- **Language packs.** Turkish and English: folding, money, durations, and
  refusal, inability, absence, alternative, free and deflection wording.
- **Aggregation.**
  - Policies per dimension: worst of N, majority of N, advisory.
  - Wilson intervals and unstable cases.
  - `unmeasured` never counts as a pass.
- **Reports.** A terminal summary and JUnit XML, from the results file alone
  (`yokla report`, `yokla run --junit`). They never contain the target's
  answers.
- **Gate (ADR-0010, ADR-0011).**
  - `yokla gate` checks thresholds per suite from `yokla.config.yaml`, and
    regressions against a baseline.
  - It exits with `0` passed, `1` broken, or `2` when the run can't be judged.
  - `yokla baseline` writes `yokla.baseline.json`, which can be committed, and
    shows what changed.
  - A case is compared with the baseline only while its definition holds.
- **demo-shop.** A reference target with eight seeded defects and the
  acceptance cases.
- **Egress test (ADR-0003).** The demo-shop suite, the gate and the baseline
  run behind a network guard that allows only the demo-shops. The guard has
  its own tests.
