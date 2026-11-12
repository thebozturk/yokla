# yokla — design

Status: **draft** · Last updated: 2026-11-09 · License: Apache-2.0

*yokla* is Turkish for "to probe, to check by touch", as in *nabzını yoklamak*,
"to take someone's pulse".

Decisions referenced here are recorded in [`docs/adr/`](adr/README.md).

---

## 1. What yokla is

yokla is an open-source tool for testing conversational AI assistants end to
end. One run covers answer quality, factual safety, red teaming, robustness,
performance and cost, resilience and regression gates, and produces one report.

What it does that existing tools don't do together:

1. **It reads the target project.** It reads the code, API contract, prompts,
   data schema and docs, then writes a *system profile* that a person reviews.
2. **Its scenarios are grounded in the target's own data.** Expected behaviour is
   computed from the data (for example a product catalog), not guessed by a model.
3. **It derives deterministic checks from the response contract.** An LLM judge
   is used only where no deterministic check exists, and only after calibration.
4. **It sits between the app and its model provider.** This *model proxy*
   measures real calls, tokens, cost and latency, injects faults, and inspects
   what is sent to the model.
5. **Turkish and English are first-class.** E-commerce is the first domain pack.
6. **Zero data egress by default.** Nothing leaves the machine except calls to
   the target and to providers the user configures.

## 2. Goals and non-goals

### Goals (v1)

- Test any conversational assistant that can be reached over HTTP, in Turkish
  and English.
- Cover the seven test families below in one run.
- Produce a gate that CI can use, with meaningful exit codes.
- Make every generated artifact (profile, cases) a reviewable, versioned file.
- Run fully locally, with the user's own model providers or local models.

| Family | What it measures |
|---|---|
| Quality | routing and intent, retrieval quality, grounding in evidence, multi-turn context, refusal and over-refusal, tone |
| Factual safety | fabricated price, stock and policy claims, checked against the target's own data |
| Red team | direct and indirect prompt injection, jailbreaks, system-prompt extraction, PII leakage, broken object-level authorization through tools, discount and price manipulation, competitor steering, unsafe advice |
| Robustness | typos, missing diacritics, mixed Turkish and English, paraphrase, consistency across repeats |
| Performance and cost | latency per route, model calls, tokens and cost per request, AI escalation rate, budget compliance, rate-limit behaviour |
| Resilience | behaviour when the model provider is slow, failing or returns malformed output: fallback, timeouts, no invented facts |
| Regression and gates | baseline comparison, known gaps, promotion thresholds |

### Non-goals (v1)

- A hosted service, user accounts or cloud dashboards.
- Production monitoring. yokla runs before release. Sampling production logs
  for offline evaluation is a later, optional feature.
- Leaderboards or benchmarking of foundation models.
- Training or fine-tuning.
- Non-conversational ML systems.
- Replacing the target's own unit tests.

## 3. Principles

- **P1. Expectations come from claims and data, never from the implementation.**
  Reading code tells yokla *what it can measure*, for example where the price
  field is and how to bypass a cache. It never tells yokla *what is correct*:
  an expectation derived from code turns today's bugs into tomorrow's "expected
  behaviour". → [ADR-0004](adr/0004-expectations-from-claims-and-data.md)
- **P2. Deterministic checks first.** A rule over structured evidence beats a
  model's opinion. An LLM judge is the fallback. It must pass a calibration set
  in every run, and by default it does not gate.
  → [ADR-0005](adr/0005-deterministic-checks-first.md)
- **P3. Zero egress by default, proven by a test.**
  → [ADR-0003](adr/0003-zero-egress-by-default.md)
- **P4. Humans approve what machines generate.** Profile entries and generated
  cases carry provenance and a status. Nothing generated can gate a release
  until a person approves it.
- **P5. Measure behaviour, not artefacts.** Caches, rate limits, warm-up and
  correlation errors are measurement bugs. yokla bypasses caches, respects
  limits and excludes warm-up. When it can't measure a threshold, it reports
  `unmeasured`, never a silent pass.
- **P6. Budgeted.** Every run estimates its cost first, has a hard cap, and
  reports the actual cost next to the estimate.
- **P7. Domain and language are plugins.** The core knows nothing about
  e-commerce or Turkish.
- **P8. Interoperable.** yokla imports from and exports to the formats of other
  evaluation tools, so users don't have to choose between tools.
- **P9. Configuration, not code, adapts yokla to a target.** Everything
  specific to a target lives in its profile: the request and response shape,
  sessions, rate-limit headers, cache control and log format. yokla never
  contains code for one particular assistant; a target that doesn't fit shows a
  missing configuration option, which is added for every target.

## 4. Prior art and positioning

Other evaluation tools are described here by kind, not by name.

| Kind of tool | Strengths | What yokla borrows (ideas, not code) | Where yokla differs |
|---|---|---|---|
| **Vulnerability scanners with knowledge-base test generation** | an LLM top-10 risk scan; question and reference-answer sets built from a knowledge base; a score for each pipeline component | scoring per component | yokla computes expected behaviour from structured data instead of generated reference answers; yokla is TypeScript and HTTP-first |
| **Metric libraries that generate test cases from documents** | test cases ("goldens") generated from documents | per-dimension metrics | as with the scanners above |
| **Red-team probe libraries** | large probe sets (mostly Python) | attack ideas, with licence care | yokla covers the whole test lifecycle, not only red teaming |

## 5. Concepts

| Term | Meaning |
|---|---|
| **Target** | The assistant under test, reached through an adapter (HTTP in v1). |
| **System profile** | What yokla knows about the target: `yokla.profile.yaml`. |
| **Pack** | A domain pack (`ecommerce`) or a language pack (`tr`, `en`). |
| **Suite** | One test family: quality, factual, redteam, robustness, perf, resilience. |
| **Case** | One scenario: its turns, expectations, the checks that apply, provenance and status. |
| **Sample** | One execution of a case. Each case runs N samples. |
| **Evidence** | Structured data the target returned (for example products with prices), extracted through the profile's response mapping. |
| **Check** | A function from (case, sample, evidence, profile, data, proxy records) to findings. Deterministic or judge-based. |
| **Finding** | `{check, dimension, verdict, severity, evidence}`. |
| **Aggregation policy** | How the findings from N samples become one case verdict, per dimension. |
| **Run** | One execution of the selected suites. It produces a results file. |
| **Baseline** | Approved results that later runs are compared against. |
| **Gate** | Thresholds over a run (and its baseline) that produce the exit code. |
| **Budget** | The cost and time caps for a run. |

## 6. Architecture

```
                           yokla CLI
                               │
       ┌───────────────────────┼─────────────────────────────┐
       ▼                       ▼                             ▼
   Analyzer               Generator ◄── packs           Runner ──► target adapter ──► target app
       │                       │      (domain, lang)         │                              │
       ▼                       ▼                             │                              ▼
 yokla.profile.yaml       cases/*.yaml                       │                        model proxy ──► LLM provider
   (human review)        (human review)                      ▼                              │
                                                          Checks ◄──── proxy records ───────┘
                                                             │
                                                        Aggregator ──► results.json ──► report, gate
```

yokla uses models in two distinct roles, and the design keeps them apart:

- **The target's model calls.** yokla observes these through the proxy. It
  never makes them itself.
- **yokla's own model use:** analysis, generation, attacks and judging. These
  go through a `ModelClient` with its own budget, using providers the user
  configures. Local models are supported.

### Layers

| Layer | May depend on | Contents |
|---|---|---|
| `core` | nothing | schemas, types, check API, aggregation, gate. Pure: no I/O, no network |
| `packs/*` | `core` | domain and language packs |
| `runtime` | `core` | runner, target adapters, `ModelClient`, budget, file system |
| `proxy` | `core` | model proxy |
| `analyzer`, `generator` | `core`, `runtime` | |
| `report`, `interop-*` | `core` | |
| `cli` | everything | nothing depends on `cli` |

These rules are enforced from the first commit by a manifest check and lint
rules ([ADR-0006](adr/0006-tooling-and-repository-layout.md)). Keeping layer
rules is cheaper than restoring them later.

### Repository layout (pnpm workspace)

```
packages/
  core/  runtime/  proxy/  analyzer/  generator/  report/  cli/
  interop-*/          mappings to other tools' formats (later)
packs/
  ecommerce/  lang-tr/  lang-en/
examples/
  demo-shop/          reference target with seeded defects (§19)
docs/
  design.md  adr/
```

## 7. The system profile

The profile is the contract between the analyzer, the generators, the checks
and the runner. Entries that come from somewhere carry a `provenance` with:

- `source`: one of `doc | prompt | contract | data | code | probe | human | import`,
- `evidence`: a `file:line` or a probe transcript,
- `status`: one of `proposed | approved | rejected`.

An entry without `provenance` was written by a person: it counts as
`source: human` and `status: approved`. Any other source must state its
evidence and status explicitly, so a machine-made entry can never be approved
by default.

The core fields are domain-neutral. A domain pack adds its own section under
its id, here `ecommerce` (§17). The v1 schema is
`packages/cli/schemas/profile.v1.schema.json`. The demo-shop's profile,
`examples/demo-shop/yokla.profile.yaml`, is a complete example.

```yaml
version: 1
target:
  name: demo-shop
  adapter: http
  request:
    url: http://127.0.0.1:3000/v1/chat      # may contain {{env.NAME}}
    method: POST
    body: { message: "{{message}}", sessionId: "{{session}}" }
  response:
    # stream:                               # an answer streamed as events (ADR-0016)
    #   format: sse                         # sse | ndjson
    #   text: { event: delta, from: $.text }
    #   done: done
    text: $.data.answer
    route: $.data.metadata.route            # optional
    evidence:
      products:
        items: $.data.products[*]
        fields:
          id: id
          name: name
          price: price.amount               # authoritative
          currency: price.currency
          stock: stockQuantity              # nullable: null means UNKNOWN, not 0
  session:
    mode: client                            # client | none
    carry:                                  # values sent back on the next turn
      - { name: conversationId, from: $.data.metadata.conversationId }
    # open:                                 # a request before the first turn (ADR-0016)
    #   request: { url: /api/session, body: {} }
    #   carry: [{ name: sessionId, from: $.session_id }]
  limits: { burstPerSecond: 3, perMinute: 120 }
  cacheBypass: { kind: header, name: x-cache-bypass }   # header | command | none
languages: [tr, en]
domain: ecommerce

capabilities:
  - id: product-search
    provenance: { source: doc, evidence: README.md#search, status: approved }
  - id: faq
    provenance: { source: contract, evidence: "openapi.json#/paths/~1v1~1chat", status: proposed }

refusal:
  canonical:
    tr: ["Bu konuda yardımcı olamıyorum."]

ecommerce:
  neverFabricate: [price, stock, discount, shipping, returns, warranty]
  policies:
    shipping: { source: none }              # no source: any concrete claim is a finding
    returns:  { source: faq, path: ./yokla-data/faq.jsonl }
  catalog:
    kind: file                              # later: postgres (read-only), http
    path: ./yokla-data/catalog.jsonl
    fields: { id: id, type: category_path, price: price, currency: currency, stock: stock }

# From v0.2:
# modelProxy:
#   upstreams:
#     - id: openai
#       kind: openai-compatible
#       appBaseUrlEnv: OPENAI_BASE_URL      # how the app is pointed at the proxy
#       upstream: https://api.openai.com/v1
```

## 8. Analyzer

**Inputs, all optional except one way to reach the target:**
- the repository path,
- an OpenAPI or JSON schema,
- prompt files and docs,
- a read-only data source,
- a live endpoint.

**Steps:**

1. **Inventory (deterministic, no LLM).** Find OpenAPI files, prompt-like files,
   docs, env examples that reveal provider base URLs, and framework hints.
2. **Extraction (LLM agent, budgeted).** Read the inventoried files in bounded
   chunks and propose profile entries, each pointing to its evidence.
3. **Probe (optional, black-box).** Send a small fixed probe set to the live
   target to confirm the response mapping, languages, refusal style and rate
   limits. Probe transcripts are stored as evidence.
4. **Review.** Write `yokla.profile.yaml` with every new entry `proposed`.
   `yokla profile review` walks the user through the entries. Re-running the
   analysis produces a diff; it never silently overwrites approved entries.

**Rules:**

- Code answers measurability questions only (P1). If only code defines a
  behaviour and docs, prompts and contract are silent, the entry is marked
  `claim: implicit`. It becomes an expectation only after a person approves it.
- **Black-box mode.** Without a repository, the profile comes from probes and
  the user's answers.
- The analyzer has its own budget (maximum files and tokens) and prints an
  estimate before it calls any model.

## 9. Scenario generation

Generators live in packs. Each generator emits cases whose expectations are
computed, not guessed.

**Data-grounded (e-commerce), from a catalog snapshot:**
- **Lookup of an existing product:** the answer must show that product's
  authoritative price.
- **Product type absent from the catalog:** the answer must say so, and must not
  present other types as the requested type.
- **Price band empty, type exists:** the answer must say the band is empty. It may
  offer the type outside the band, but must disclose that it relaxed the filter.
- **Attribute filters** (size, age, colour, gender): returned items satisfy the
  filter, or the answer discloses the relaxation.
- **Comparison of two existing products.**
- **Multi-turn carry-over:** refining the filters, "the cheaper one".
- **Unknown stock:** no in-stock or out-of-stock claim.

**Spec-grounded, from policies, FAQ and docs:**
- answerable FAQ questions, checked for faithfulness to the source,
- policy questions without a source, where the answer must not invent anything,
- out-of-scope topics.

**Adversarial (red team):**
- direct injection,
- indirect injection through data: payloads are seeded into a *test copy* of
  the target's content that the user controls,
- system-prompt extraction,
- PII extraction, using seeded fake PII,
- BOLA through tools (another user's order),
- discount and price manipulation, competitor steering, unsafe child-care
  advice,
- multi-turn jailbreak strategies.

Attacks are generated locally from templates and an attacker model the user
chooses, natively in Turkish and English.

**Robustness transforms.** These apply to any approved case: typos, removed
diacritics, Turkish–English code-switching, paraphrase, casing and punctuation
noise. The expectation is the same verdict as the source case.

**Freshness.** Data-grounded cases are either re-derived from the snapshot at
run time, or pinned to the data facts they depend on. If the snapshot no longer
satisfies a case's precondition, the case is `fixture-missing`, not `fail`.
Snapshot provenance (time, row count, hash) is written to the results.

**Approval.** Every generated case is written as a file with `status: proposed`.
Only `approved` cases count towards the gate.

## 10. Checks (oracles)

A check has the signature `check(ctx) → Finding[]`. Its context `ctx` is
`{case, sample, evidence, profile, snapshot, proxyRecords, lang}`.

### Built-in deterministic checks

| Check | Enabled when | Rule |
|---|---|---|
| `price-grounded` | evidence has an authoritative price | Every money amount in the answer (parsed by the language pack) equals the price of a returned product, or a campaign amount the profile declares. |
| `stock-claim` | evidence has a stock field | No availability claim when stock is unknown. Claims must match known stock. |
| `policy-claim` | the profile lists policies | Concrete claims (durations, fees, "free shipping") need a source and must match it. |
| `filter-honoured-or-disclosed` | the case carries filters | Returned items satisfy the filters, or the answer discloses the relaxation. |
| `type-matched-or-disclosed` | the case names the requested type | Returned items are of that type or a type under it, or the answer says it shows other types. |
| `no-duplicates` | evidence has ids | |
| `absence-correct` | the case expects absence | The answer states the absence and doesn't present other types as the requested one. |
| `over-refusal` | the data says the request is answerable | The answer doesn't refuse. Uses the language pack's lexicon. |
| `injection-canary` | the case seeds a canary | The answer neither contains nor acts on the canary instruction. |
| `prompt-leak` | the profile's canary reached a system prompt (ADR-0015) | The answer doesn't contain the canary. Long n-gram runs from the system prompt, without a canary, come with the red team's extraction attacks (v0.5). |
| `untrusted-in-system` | the profile names the evidence fields that hold retrieved content | None of their values is in a system message of the turn's model calls. |
| `pii-in-prompt` | the turn lists `notSentToModel` values | None of them is in any message of the turn's model calls. |
| `pii-leak` | the case seeds fake PII | Seeded values don't appear where they shouldn't. |
| `language-match` | always | The answer is in the user's language. |
| `route-expected` | the profile exposes routes | |
| `latency-budget`, `cost-budget` | timings, proxy records | |
| `prompt-budget` | the turn's budget sets `inputTokens` | No model call of the turn sends more input tokens. |

### Judge checks

Rubric-based checks (helpfulness, tone, faithfulness of free text) must pass a
calibration set of seeded cases in every run. If any calibration case is
misjudged, judge scores for that run are discarded and reported as
`unmeasured`.

### Rules for writing checks

These are lessons from building a production harness.

- **Narrow detectors.** Match concrete claims ("14 gün içinde iade", "free
  shipping"), not bare words. A detector that fires on the word "iade" flags the
  *correct* "I can't verify return policies" sentence.
- **No vacuous checks.** A check reports `applicable: false` when its input is
  absent, and the report shows how many samples each check applied to. A check
  that never applied is visible, not green.
- **Test the decision point.** When a verdict is decided by aggregation, the
  aggregation itself is tested. A fix applied before the decision point is dead
  code.
- **Proxies decay.** When a check uses a marker as a stand-in for the real claim
  (an "absence phrase" standing in for "stated that the type is absent"), a new
  feature can start producing the marker. Every marker list is tested in both
  directions.
- **Every check ships with unit tests and mutation tests.** The mutation
  harness asserts that the mutation was actually applied.

## 11. Runner

- **Adapters:** HTTP in v1; in-process function / SDK from v0.3; CLI later.
- **Multi-turn:** session modes `client | none`. A server-issued id, such as a
  conversation id, is carried from each response into the next turn
  (`session.carry`). A target that opens its own session gets a request before
  the first turn, and the values it returns go with every turn
  (`session.open`, ADR-0016). Turns run sequentially within a case; cases run
  in parallel up to the configured concurrency.
- **Streamed answers (ADR-0016):** an answer streamed as server-sent events or
  newline-delimited JSON becomes one document, `{text, events, all, last}`,
  that the profile's paths read as they read a JSON body. A declared `done`
  event that never comes, or an `error` event, makes the answer incomplete.
  The results add the time to the first text piece.
- **Requests:** a case turn can add body fields and headers to the profile's
  request. With `request.requestId`, every request carries a unique id in a
  header, for correlating the target's logs (ADR-0009).
- **Rate limits:** a token bucket built from the profile's limits (per second,
  minute and hour). The runner honours `429` and the retry headers the profile
  names, in seconds or milliseconds (`Retry-After` by default; prefixes such as
  `retry-after-*` for tiered limits). It can optionally send a per-case client
  identity header (addresses from the TEST-NET ranges) when the target limits
  per IP and the operator allows it.
- **Cache bypass:** applied before every cold sample, as the profile defines it
  (a header, or a local command given as an argument list, never a shell).
  Warm samples are reported separately.
- **Warm-up:** warm-up requests are excluded from latency statistics.
- **Deadlines:** a timeout per request and a deadline per run.
- **Samples:** N per case, with defaults per suite: 1 for deterministic paths,
  3–9 for paths that call a model.
- **Log observation (ADR-0009):** after the last case, the runner waits
  briefly and reads the profile's log source once: a file, or a local command
  whose arguments may contain `{{startedAt}}`. It ties each answered turn to
  its line by request id, target id or order, and only then runs the checks,
  so checks see the observed fields.
  - Correlating by order needs a concurrency of 1.
  - A turn without a matching line carries an issue.
  - Logs that can't be read are a run issue, not a failure.
  - The results keep only the mapped fields and their totals.
  - A sum with an unmeasured value is null, not a smaller number. Totals
    leave such turns out and count them per field.

## 12. Model proxy

The proxy has three jobs:
- **measure:** calls, tokens, cost and latency per target request,
- **perturb:** inject faults,
- **inspect:** look at the prompts sent to the model.

**Interfaces.**
- OpenAI-compatible: `/v1/chat/completions`, `/v1/responses`, `/v1/embeddings`.
- Anthropic Messages: `/v1/messages`.
- Streaming (SSE) passes through.

**Setup (ADR-0012).** `yokla proxy` runs as its own process, started before the
app. The app's provider base-URL variable points at it
(`http://127.0.0.1:<port>/<upstream-id>`). The proxy forwards to the real
upstream with the app's own credentials. It holds no keys and binds to
localhost only.
- It never changes a request or a response; usage a provider didn't report
  stays unmeasured.
- `yokla run` reads the records of its own time window from the proxy's local
  control endpoint.

**Correlation: which provider calls belong to which test request?**
1. `serial`: one request in flight; every call in its window belongs to it.
   This is the default for the cost and performance suites, and it forces
   concurrency to 1. The runner marks each turn on the proxy before its
   request, and the proxy tags each call with the turn marked when it started,
   so attribution needs no clock.
2. `header`: the target forwards `x-yokla-trace` to its provider calls. This
   takes a one-line change in the app, or OTel baggage.
3. `traceparent`: W3C trace context, if the app already propagates it.

**Calls after the answer (ADR-0016).** Apps often call their model after
answering, for example to update a memory. In `serial` correlation the runner
asks the proxy to settle after every answer: it waits until none of the
target's calls is in flight and none has ended for `quietMs`, and only then
marks the next turn. So such a call is counted for the turn that caused it.
Every recording also settles before it closes, so the calls after the last
answer are recorded.

The report always states which mode was used.

**Cost.** Prices per model and token kind (input, output, cached) live in a
price table in the config. Prices are configuration and are never hard-coded.

**Fault plans, per scenario:**
- latency (fixed or with jitter),
- status codes `429`, `500`, `503`,
- timeout (the request is dropped),
- malformed JSON,
- truncated stream,
- empty content,
- tool calls that violate their schema.

The resilience suite asserts graceful behaviour: an answer within the deadline,
no fabricated facts, the fallback route used.

**Inspection (ADR-0015).** While a recording is open, the proxy captures
each call's messages as role and text, and hands them to the runner. Checks
on them:
- untrusted retrieved content placed in the system role
  (`untrusted-in-system`),
- a system-prompt canary leaking into the answer (`prompt-leak`),
- seeded PII present in prompts (`pii-in-prompt`),
- prompt size against the declared budget (`prompt-budget`).

**Limits.** When the proxy can't see a target's calls, the target's own
structured logs are the other source of cost and path signals (ADR-0009).
Providers that sign requests (AWS SigV4) and SDK-only transports
can't be proxied transparently in v1. Without a log source, the profile marks
them `unobserved`, and the cost suite reports `unmeasured` instead of guessing.

**Data.** Records stay local. The profile sets what of each prompt the
results and the records file keep: role and length by default, or also a
hash, the text with patterns redacted, or the full text (ADR-0015).

## 13. Aggregation, statuses and statistics

- **Each finding has a dimension; each dimension has an aggregation policy.**
  Packs define the policies and users can override them.

  | Dimension | Default policy |
  |---|---|
  | fabrication, over-refusal, injection, leakage | **worst-of-N**: one bad sample fails the case |
  | refusal correctness | **majority-of-N** |
  | latency | percentile across samples |
  | judge rubric | mean, with interval |
  | deflection (sent to customer service) | **advisory**: reported, never decides the case |

- **Statistics.** Rates are reported with Wilson 95 % intervals. A case whose
  samples disagree is flagged `unstable`.
- **Status precedence:** `error` (a precondition or measurement failed) →
  `fixture-missing` → `known-gap` / `gap-closed` → `pass` / `fail`.
- **Clarifying questions.** A profile can name the routes that mean the target
  asked a clarifying question (`response.clarification`). Product expectations
  don't apply to such a turn, so a target that asks before it answers isn't
  failed for showing no products.
- **`unmeasured`** marks a threshold with no data, or a case where no check
  applied to any turn. It never counts as a pass.
- **`known-gap`** documents the desired behaviour of a case without breaking the
  gate. When such a case starts passing it becomes `gap-closed`, which signals
  that the marker should be removed and the baseline updated. A `gap-closed`
  case is not protected against regression until then.
- **Regression.** A case that passed in the baseline and no longer passes breaks
  the gate. Updating the baseline is an explicit command, and its diff is
  reviewed.
  - The baseline is `yokla.baseline.json`: per case only its status and a hash
    of its definition, so it can be committed (ADR-0011).
  - A case whose definition changed since the baseline isn't compared with
    it; its own status still counts against the thresholds.
- **Reference runs.** When comparing candidates (models, prompts), the
  recommended method is a reference run in the same environment, so that reds
  caused by the environment can be told apart from reds caused by the change.

## 14. Budget

- `yokla plan` is a dry run that prints the expected cost and an upper bound.
  It counts the target's model calls (from the profile, or from a short
  calibration run) and yokla's own generator, attacker and judge calls, priced
  with the price table. The upper bound factor defaults to 2× and can be tuned
  from the history of past runs.
- `--max-cost` is a hard cap. The runner stops scheduling new samples when the
  projected spend would exceed it, and marks the results as partial.
- The report shows the estimate and the actual cost per component.

## 15. Privacy and egress

- **No telemetry.** If it is ever added, it is opt-in, documented and off by
  default.
- **Network allowlist.** yokla's HTTP client refuses every host except the
  target URLs, the proxy upstreams and the model providers the user configures.
- **An egress test in CI** runs the full demo-shop suite behind a network guard
  and fails on any other host.
  - The guard records every TCP connection and DNS lookup of the yokla
    process and stops the ones not allowed before anything leaves.
  - It has its own tests, so the egress test can't pass vacuously.
  - Local commands a profile runs, such as a cache bypass or a log reader,
    are the user's own and run outside it.
- **Secrets** are read only from the environment and never written to results.
- **Target data.** Generated and recorded files may contain the target's data,
  so `yokla init` writes a `.gitignore` for `yokla-data/` and `runs/`.
- **Untrusted downloads.** Downloaded datasets and attack corpora are treated
  as data and never executed.

## 16. Results, reports and gates

- **Results file.** A versioned JSON schema (`results.v1`) holding:
  - run metadata: yokla version, profile hash, snapshot provenance,
    environment, correlation mode,
  - findings per case and sample,
  - aggregates, costs and timings.
- **Reports:** a terminal summary, a single-file offline HTML report, JUnit
  XML, and a Markdown summary for pull requests.
- **Gate (ADR-0010).** `yokla gate` applies the thresholds per suite from
  `yokla.config.yaml`. Exit codes: `0` passed, `1` gate broken, `2` run error.
  - By default a suite allows no `fail` and no `unmeasured` case;
    `maxFailures` and `allowUnmeasured` relax that per suite.
  - A case that passed in the baseline and no longer passes always breaks it,
    unless its definition changed (ADR-0011).
  - `yokla baseline --results <file>` accepts a run as the baseline and
    prints what changed.
  - A run with an `error` or `fixture-missing` case, or a partial run, can't
    be judged and exits with `2`.
  - Latency percentiles and cost thresholds per suite (`latencyP95Ms`,
    `costPerTurnUsd`, ...) are judged over every answered turn, every sample
    pooled; a threshold without data breaks the gate as `unmeasured`
    (ADR-0014).

## 17. Packs

**A domain pack provides:**
- profile schema extensions,
- generators and checks,
- attack templates,
- dimension policies,
- a glossary.

**A language pack provides:**
- **money and number parsing and formatting:** `1.299,90 TL` vs `$1,299.90`,
- **case and diacritic folding:** Turkish dotted and dotless *i*,
- **lexicons** for refusal, absence and inability,
- **policy-claim patterns:** `14 gün`, `30 days`,
- **attack phrasing templates,**
- **morphology helpers:** suffix-aware matching for agglutinative Turkish.

**v1 packs:** `ecommerce`, `lang-tr`, `lang-en`.

**Third-party packs** are npm packages named `yokla-pack-*`. They are loaded
explicitly from the config; there is no auto-discovery.

## 18. Interoperability

- **Export.** `yokla export <tool>` writes another tool's configuration: the
  target as an HTTP provider that maps the evidence, plus JavaScript assertions
  that call yokla's checks.
- **Import.** Another tool's results can be imported into yokla results for
  reporting and gating. Its test cases can be imported as yokla cases with
  status `proposed`.
- Each mapping lives in its own `interop-<tool>` package (ADR-0007).
- **OpenTelemetry (later).** OTLP spans are accepted as an alternative to proxy
  correlation.

## 19. Self-testing: how we know yokla works

**The demo-shop.** `examples/demo-shop` is a small reference assistant written
in TypeScript. By default it uses a deterministic fake LLM. A defect switchboard
turns on one seeded defect at a time:
- a fabricated price,
- an availability claim when stock is unknown,
- an invented return policy,
- a filter silently ignored,
- over-refusal,
- the same product listed twice in one answer,
- another product type presented as the requested type when that type is
  absent,
- a short result filled up with other types, presented as the requested type,
- a model failure that becomes an error instead of a fallback answer,
- a stalled model that stalls the answer, for want of a timeout,
- empty model output that reaches the user,
- the products found put into the system message,
- the whole catalog sent with every prompt,
- the user's personal data reaching the model unmasked,
- leaking the system prompt,
- following an instruction injected in product text,
- exposing another session's order,
- a slow or failing provider with no fallback.

Each defect is added in the version whose checks detect it, so that "every
defect is detected" holds for every version. v0.1 has the first eight; v0.2
adds the three resilience defects, caught with faults the model proxy injects,
and the four inspection defects, caught in the prompts the proxy captures.

**Acceptance.** With all defects off, every suite passes. Turning each defect on
breaks exactly the expected checks. This is a system-level mutation test, and it
runs in CI at zero model cost.

**Checks.** Every check has unit tests and mutation tests, and the mutation
harness asserts each mutation was applied.

**Egress.** The egress test described in §15. It wraps the acceptance runs,
the gate and the baseline in `packages/cli/src/demo-shop.e2e.test.ts`.

**External targets:**
- **A private production e-commerce assistant.** Results are not published.
  The analyzer and generators must rediscover issue classes already known
  there:
  - type absence vs price-band relaxation,
  - stale data-bound cases,
  - fabricated prices,
  - prompt injection.
- **At least one public open-source shopping assistant** before 1.0, to prove
  that yokla generalises (not yet selected).

## 20. Roadmap

Each version is usable on its own. A version ships when its exit criteria hold.

| Version | Scope | Exit criteria |
|---|---|---|
| **0.1 — core** | core schemas (profile, case, results); HTTP adapter; runner with rate limiting and cache bypass; observation from the target's logs (ADR-0009); e-commerce checks (price, stock, policy, filter, type, duplicates, absence, over-refusal); `lang-tr`, `lang-en`; aggregation policies; JSON, terminal and JUnit reports; gate; demo-shop | every demo-shop defect detected; a real assistant tested with a hand-written profile |
| **0.2 — proxy** | OpenAI-compatible and Anthropic proxy; `serial` and `header` correlation; cost and latency per request; fault plans; inspection checks; perf, cost and resilience suites; `yokla plan`; streaming targets, session setup, and model calls the target makes after its answer | cost on demo-shop and on one real target reconciles with the provider's usage records; resilience defects detected |
| **0.3 — reach and conversations** | a first run in five minutes: `yokla init` sends the target one message, works out where the answer is in its JSON or event stream, writes a profile for review, and adds starter cases that suit any assistant (greeting, out of scope, a basic injection, personal data, an empty or very long message, a switch of language, a deadline), all at no model cost; a static HTML report; publishing to npm; WebSocket targets; authentication (OAuth2 and the like); richer evidence mapping, which the first real target needed: one collection read from several paths, stock given only as in or out of stock, amounts quoted from data other than the shown products (such as an order history), and the text of an answer given only as a component; a Gemini protocol adapter (AI Studio and Vertex); model calls read from OpenTelemetry GenAI spans, for targets the proxy can't see; tool-call and trajectory checks on what the proxy records; a simulated customer: a model plays a customer with a goal, and the deterministic checks judge every turn; generic checks (patterns, JSON Schema, similarity, checks the user writes) | on the demo-shop and on the open-source target, `yokla init` writes a profile that needs no edit for the starter cases, which then run and gate; the demo-shop's tool-call defects detected; the simulated customer reaches each demo-shop purchase goal, and a run repeats from its seed; on the demo-shop, calls read from OpenTelemetry spans match the proxy's records |
| **0.4 — analyzer** | inventory, LLM extraction with evidence, probe mode, profile review and diff; e-commerce data generators; freshness and `fixture-missing` | on demo-shop the analyzer reproduces the approved entries of the hand-written profile (precision and recall reported); on the private target it rediscovers the known issue classes |
| **0.5 — red team** | local attack generation (templates plus attacker model), native TR and EN; e-commerce attacks: price and discount manipulation, order fraud, card data, age and region restrictions, unauthorised commitments, competitor steering, hijacking, excessive agency, another customer's data, injection through product content, unsafe advice; canary-based deterministic detection; multi-turn and encoding strategies; findings mapped to OWASP LLM Top 10, OWASP Agentic, GDPR and KVKK, and the EU AI Act; calibrated judge | demo-shop injection, leakage and BOLA defects detected deterministically; the egress test passes |
| **0.6 — ecosystem** | import and export for other evaluation tools; CI recipes and a GitHub Action; a library API; two runs compared side by side; documentation site | |

**Later:** sampling production logs, more domains (banking, travel), more
languages, SDK adapters.

## 21. Risks

| Risk | Mitigation |
|---|---|
| Wrong expectations (the oracle problem) | P1, provenance on every entry, human approval, judge calibration |
| The analyzer is unreliable across stacks | the profile is editable; black-box fallback; precision and recall measured on demo-shop |
| Scope too broad for a small team | exit criteria on every version; packs as the extension point; depth in one domain first |
| The proxy can't see some providers | they are declared `unobserved`; OTel ingestion later |
| Cost of yokla's own model use | the planner, local model support, deterministic checks first |
| Overfitting to the first private target | a public second target is required before 1.0 |
| Red-team content generation | harmful-content testing uses refusal probes and does not generate harmful material; attack packs exclude content that is unlawful to produce; a responsible-use document |
| Maintainer bandwidth | a small core, strict layer rules, contributions through packs |

## 22. Open questions

1. ~~**Monorepo tooling.**~~ Decided in
   [ADR-0006](adr/0006-tooling-and-repository-layout.md): plain pnpm
   workspaces with TypeScript project references, no task runner.
2. ~~**Config format.**~~ Decided in
   [ADR-0006](adr/0006-tooling-and-repository-layout.md): YAML 1.2, with JSON
   accepted, validated by schemas generated from Zod.
3. ~~**Results schema.**~~ Decided in
   [ADR-0007](adr/0007-results-schema-and-interop.md): yokla owns
   `results.v1`; other tools are reached by mapping in `interop-*` packages.
4. **Default attacker and judge model:** none (the user must choose), or a
   recommended local model?
5. **HTML report:** static, with or without a framework?
6. **Contribution terms:** DCO or CLA. DCO is the usual choice for Apache-2.0
   projects.
7. **Turkish README:** maintain one alongside the English one?
