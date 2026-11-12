# Changelog

Notable changes per version. Versions follow the roadmap in
[design §20](docs/design.md#20-roadmap); a version ships when its exit criteria
hold.

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
