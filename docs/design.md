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
- Testing an MCP server on its own. An MCP server is a tool server, not a
  conversational assistant. An assistant's MCP tools show up as tool calls
  through the model proxy (ADR-0025), and D7 (§20) changes their results.

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

Other evaluation tools are described here by kind, not by name. One tool can
be of several kinds. The descriptions follow the tools' public documentation
as of November 2026.

| Kind of tool | Strengths | What yokla borrows (ideas, not code) | Where yokla differs |
|---|---|---|---|
| **Vulnerability scanners with knowledge-base test generation** | an LLM top-10 risk scan; question and reference-answer sets built from a knowledge base; a score for each pipeline component | scoring per component | yokla computes expected behaviour from structured data instead of generated reference answers; yokla is TypeScript and HTTP-first |
| **Metric libraries that generate test cases from documents** | test cases ("goldens") generated from documents | per-dimension metrics | as with the scanners above |
| **Configuration-driven evaluation and red-team command-line tools** | test files in YAML; many model providers; large catalogs of red-team plugins and attack strategies, some for e-commerce (order fraud, price manipulation); CI integration; traces received from targets instrumented with OpenTelemetry | test files that live in the target's repository; attack ideas for e-commerce | yokla checks every price, stock and policy claim against the target's own data, not only attacks on them; the model proxy sees the target's model calls without instrumentation in the target (ADR-0012), and spans are the fallback (ADR-0029); nothing leaves the machine by default (ADR-0003) |
| **Red-team probe libraries and attack orchestration frameworks** | large probe sets (mostly Python); converters that encode or rephrase an attack; multi-turn attack orchestration; scorers measured against labelled sets (precision, recall, agreement) | attack ideas, with licence care; how to measure the judge's calibration (ADR-0005) | yokla covers the whole test lifecycle, not only red teaming |
| **Simulated-user test frameworks and agent benchmarks** | a model plays a user with a goal over many turns; a benchmark grades the final state of a database; pass^k, success in every one of k trials, as a measure of reliability | pass^k, which a case's worst-of-N over k samples already measures (§13); expanding a scenario's variables pairwise, for generators (§9) | yokla's simulated customer is judged turn by turn by deterministic checks and repeats from a seed (ADR-0028); expectations come from the target's own data, not from outcomes marked by hand |
| **Fault-injection proxies for agents** | faults between an agent and its model or tool servers; timing patterns such as intermittent faults and bursts; poisoned tool descriptions; fault, contract and replay results folded into one weighted score for CI | fault timing patterns; faults in tool descriptions | a turn under a fault is judged by the same checks as any turn, so a fault that leads to an invented price fails `price-grounded`; the verdict comes from checks, each pass, fail or unmeasured, never from a weighted score |
| **Observability platforms with evaluation features** | traces of production traffic; datasets built from traces; judge scores and human annotation; experiments compared side by side | two runs compared side by side (0.6); cases built from recorded traffic (Later) | yokla runs before release, locally, with no server to host (§2); its gate is deterministic first (ADR-0005) |

**Where yokla sits.** §1 lists what yokla does that these kinds of tool don't
do together. Two differences run through the whole table: what an answer
must say is computed from the target's own data, and a verdict is a set of
checks, each pass, fail or unmeasured, never a weighted score.

## 5. Concepts

| Term | Meaning |
|---|---|
| **Target** | The assistant under test, reached through an adapter: HTTP, or WebSocket (ADR-0024). |
| **System profile** | What yokla knows about the target: `yokla.profile.yaml`. |
| **Pack** | A domain pack (`ecommerce`) or a language pack (`tr`, `en`). |
| **Suite** | One test family: quality, factual, redteam, robustness, perf, resilience. |
| **Case** | One scenario: its turns, expectations, the checks that apply, provenance and status. |
| **Sample** | One execution of a case. Each case runs N samples. |
| **Evidence** | Structured data the target returned (for example products with prices), extracted through the profile's response mapping. |
| **Check** | Runs on each turn, from the turn's context (the case, the turn and the turns before it, the profile, the language pack) to an outcome: not applicable with a reason, findings, or a dimension it can't measure. A domain pack binds its data to its checks. Deterministic; judge-based checks come with v0.5. |
| **Finding** | `{dimension, verdict, severity, message, evidence?}`, grouped per check as `{check, applicable, findings, unmeasured?}`. |
| **Aggregation policy** | How the findings from N samples become one case verdict, per dimension. |
| **Run** | One execution of the selected suites. It produces a results file. |
| **Baseline** | Approved results that later runs are compared against. |
| **Gate** | Thresholds over a run (and its baseline) that produce the exit code. |
| **Budget** | The cost and latency bounds of a run: per-turn budgets, gate thresholds and a cost cap (ADR-0014). |

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
- **yokla's own model use:** a simulated customer today (ADR-0028); analysis,
  generation, attacks and judging later.
  - These go through a `ModelClient` in `runtime`, using providers the user
    configures in `yokla.config.yaml`, local models included, and never
    through the model proxy.
  - Their cost is counted apart from the target's, and `--max-cost` caps
    both.

### Layers

| Layer | May depend on | Contents |
|---|---|---|
| `core` | nothing | schemas, types, check API, aggregation, gate. Pure: no I/O, no network |
| `packs/*` | `core` | domain and language packs |
| `runtime` | `core` | runner, target adapter, proxy control, cost cap, file system; later the `ModelClient` |
| `proxy` | `core` | model proxy |
| `analyzer`, `generator` | `core`, `runtime` | the analyzer (ADR-0047); `generator` later |
| `report`, `interop-*` | `core` | `interop-*` later |
| `cli` | everything | nothing depends on `cli` |
| `examples/demo-shop` | no `@yokla/*` package | the system under test |

These rules are enforced from the first commit by a manifest check and lint
rules ([ADR-0006](adr/0006-tooling-and-repository-layout.md)). Keeping layer
rules is cheaper than restoring them later.

### Repository layout (pnpm workspace)

```
packages/
  core/  runtime/  proxy/  report/  cli/  analyzer/
  generator/          (later)
  interop-*/          mappings to other tools' formats (later)
packs/
  ecommerce/  lang-tr/  lang-en/
examples/
  demo-shop/          reference target with seeded defects (§19)
docs/
  design.md  adr/  guide/
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

A profile `yokla analyze` proposes keeps these in one `provenance` map at its
top, keyed by JSON Pointer to each entry (ADR-0047). A profile with a
`proposed` or `rejected` entry there doesn't run.

The core fields are domain-neutral. A domain pack adds its own section under
its id, here `ecommerce` (§17). The v1 schema is
`packages/cli/schemas/profile.v1.schema.json`. The demo-shop's profile,
`examples/demo-shop/yokla.profile.yaml`, is a complete example, and
[the profile guide](guide/profile.md) describes every field.

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

modelProxy:                                 # the app's model calls go through yokla proxy (§12)
  port: 8787
  correlation: serial                       # serial | header
  upstreams:
    - id: openai
      kind: openai-compatible               # openai-compatible | anthropic | gemini
      appBaseUrlEnv: OPENAI_BASE_URL        # how the app is pointed at the proxy
      upstream: https://api.openai.com/v1
  prompts: { store: sizes }                 # sizes | hashed | redacted | full (ADR-0015)
  settle: { quietMs: 250 }                  # wait for calls after the answer (ADR-0016)
```

The commented lines show a streamed answer and session setup. The example
leaves out rate-limit headers, log observation and the inspection fields; the
guide shows them.

## 8. Analyzer

Built in two steps for v0.4. The first is done (ADR-0047): `yokla analyze`
inventories the repository, proposes what the target's data and a few probes
give, and measures the proposal against a profile, at no model cost.
- **From data:** the domain pack's data analyzer. The e-commerce pack finds
  the catalog and its fields, its type separator, the languages of its
  names, and the policies' sources. Data kept outside the repository, such
  as a database export, is given with `--data` (ADR-0065).
- **From probes:** a greeting, read by `yokla init`'s rules, then a type
  question and a cart request. Where the products are in an answer is found
  by matching its values to the catalog's, read as the profile reads a
  field: as a number, or from a fallback of two paths (ADR-0067). A field
  that fits two ways is left undecided, its ways named (ADR-0068).
- **The proposal:** `yokla.profile.proposed.yaml`, with a `provenance` map
  (§7). It never overwrites `yokla.profile.yaml`.
- **The measure:** each entry `same`, `different`, `new` or `missed` against
  a profile, with precision and recall. On the demo-shop: 49 entries
  proposed, all the hand-written ones; recall 71.0 %. A response contract
  counts leaf by leaf, so both are also given without it: recall 60.0 %
  (ADR-0065).
- **The response contract (ADR-0057, ADR-0058):** from an OpenAPI 3
  operation or a JSON Schema document, at the deepest object the answer's
  text and evidence share, proposed only when every probe answer matches
  it. A contract the target breaks is named, never proposed. No model.
- **With a model (ADR-0049):** `models.analyzer` reads the docs, prompts and
  code, never data, environment or test files, under a token budget and a
  required cost cap, with an estimate first. It proposes only what can be
  checked word for word against the line it quotes: the rate limits, the
  cache bypass and the canonical refusals. What fails the check is listed
  and never proposed. On the demo-shop, with the fake provider: 56 entries,
  recall 81.2 %. Files that name a field asked go first, the shortest
  first, so a large repository's budget reaches the code that sets them
  (ADR-0072, ADR-0073).
- **Replies it can't read (ADR-0051):** a reply cut at `maxTokens`, as each
  provider kind reports it, or not the JSON asked for, gives no value, is
  named in the summary and the report, and is never cached. Tokens are
  counted as one per two characters, so the estimate stays above code's
  count.
- **Left to the person, or later ADRs:** the capabilities, `neverFabricate`
  and `everyAnswer`.

The plan for the whole analyzer:

**Inputs, all optional except one way to reach the target:**
- the repository path,
- an OpenAPI or JSON schema,
- prompt files and docs,
- a read-only data source,
- a live endpoint.

**Steps:**

1. **Inventory (deterministic, no LLM; done, ADR-0047).** Find OpenAPI files,
   prompt-like files, docs, env examples that reveal provider base URLs, and
   framework hints.
2. **Extraction (LLM, budgeted; the verifiable fields done, ADR-0049).** Read
   the inventoried files in bounded chunks and propose profile entries, each
   pointing to its evidence, checked against it.
3. **Probe (black-box).** Send a small fixed probe set to the live target to
   confirm the response mapping, languages, refusal style and rate limits.
   ADR-0047 sends three, for the response mapping and the evidence.
4. **Review.** Write the proposal with every new entry `proposed`; ADR-0047
   writes it to a file of its own, and compares it with a profile.
   `yokla profile review` walks the user through the entries later.
   Re-running the analysis never silently overwrites approved entries.

**Rules:**

- Code answers measurability questions only (P1). If only code defines a
  behaviour and docs, prompts and contract are silent, the entry is marked
  `claim: implicit`. It becomes an expectation only after a person approves it.
- **Black-box mode.** Without a repository, the profile comes from probes and
  the user's answers.
- The analyzer has its own budget (maximum files and tokens) and prints an
  estimate before it calls any model.

## 9. Scenario generation

Data generators came in v0.4 (ADR-0055); attack generation is planned for
v0.5. A person approves every case a generator writes.

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
- **Done (ADR-0055, ADR-0056):** `yokla generate` writes these as proposed
  cases, from the catalog, before anything is sent: `lookup`,
  `absent-type` (words the person gives, each checked absent), `empty-band`,
  `attribute`, `comparison`, `refine`, `cheaper` and `unknown-stock`, in each
  language the pack has phrasings for. The products they name are in stock,
  except `unknown-stock`'s (ADR-0062), each by a name no other product
  holds, and `cheaper` names one with a cheaper product in stock of its type
  (ADR-0063) and asks for something cheaper than it (ADR-0064).

**Spec-grounded, from policies, FAQ and docs:**
- answerable FAQ questions, checked for faithfulness to the source,
- policy questions without a source, where the answer must not invent anything,
- out-of-scope topics.

**Adversarial (red team):**
- direct injection,
- indirect injection through data: payloads are written into the tool results
  the model is sent, by the model proxy (ADR-0043), or seeded into a *test copy* of
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
- **At no model cost (ADR-0045).** `yokla run --transform` sends each written
  message without diacritics, in lower case, without punctuation, or with one
  typo, drawn from the case, sample and turn. The language pack removes
  diacritics and lower-cases.
- **What stays as written:** words with a digit, `@` or `/`, money amounts,
  and the values the turn's expectations quote, such as a canary.
- **Judging:** the case keeps its definition, so `yokla compare
  --expect-same` and the gate set it beside the run as written.
- **With a model (ADR-0059):** `--transform paraphrase` and `code-switch`,
  written by `models.transform` before the run, one rewrite per message,
  cached and capped. A rewrite that loses a text no transform changes, adds
  a sentence, or, for a code-switch, leaves its language is not sent: the
  message goes as written, and the run says why (ADR-0060).

**Freshness.** Data-grounded cases are either re-derived from the snapshot at
run time, or pinned to the data facts they depend on. If the snapshot no longer
satisfies a case's precondition, the case is `fixture-missing`, not `fail`.
Snapshot provenance (time, row count, hash) is written to the results.
- **Done (ADR-0053, ADR-0054):** the domain pack derives the facts from the
  expectations. The e-commerce pack checks `absentType` (no product's type
  is it, under it, or has it as a level) and `productType` (a product's
  type is one of them, or under one). A case with an unmet fact sends
  nothing, and its result names the facts in `fixture`. `run.data` lists
  each file the packs read, with its hash, rows and modification time.
  Explore's own turns are re-derived from the catalog of each run.

**Approval.** Every generated case is written as a file with `status: proposed`.
Only `approved` cases count towards the gate.

**Shrinking (ADR-0035, ADR-0036).** `yokla shrink` cuts a failing case down
to the fewest turns that still fail the same check, in every sample, with no
new failure on that turn. The original runs several times first; a failure
that comes and goes is reported as flaky, not shrunk. Messages are cut to
fewer words only on request, because a cut message can stop asking what its
expectations describe. The result is a proposed case.

**Searching for untried paths (ADR-0044).** `yokla explore` runs the written
cases once, then small conversations built from them, and keeps those that
reach a route, tool, argument shape or fault state no run reached before, or
that a check fails on.
- **Generic operators:** a fault on the last turn, the last turn asked
  again, and the first turn of another case after a case's turns.
- **Domain intents:** turns a pack builds from the target's own data. The
  e-commerce pack asks for a catalog product by name, a type and the type
  under a price, and each declared policy; after products, it adds them to
  the cart one by one and asks for a cheaper one.
- **Judging:** the candidates state no expectation, so the checks that need
  none judge them.
- **Output:** kept candidates are written as proposed cases, with the
  coverage map in the results.
- **Later:** a model-written next turn is left to a later ADR.

## 10. Checks (oracles)

A check runs once per turn: `run(ctx) → outcome`. Its context `ctx` is
`{case, turnIndex, turn, history, profile, lang}`. The turn carries the
answer, the evidence, the fields observed in the target's logs and the turn's
model calls. `history` holds the turns before it. A domain pack binds its data,
such as the catalog and the policy sources, when it prepares its checks. The
outcome is not applicable with a reason, findings, or a dimension the check
applies to but can't measure (ADR-0014).

### Built-in deterministic checks

The [checks guide](guide/checks.md) gives each check's exact conditions.

| Check | Enabled when | Rule |
|---|---|---|
| `price-grounded` | the answer mentions money, and a product returned or seen in the conversation has a price | Every money amount in the answer (parsed by the language pack) equals the price of a product returned in this turn or an earlier one, or seen by the model in a mapped tool result (ADR-0026), a campaign amount the profile declares, an amount in a policy source, an amount from a declared price source (ADR-0020), a returned price times a quantity stated in the same sentence (ADR-0021), a total of the answer's own grounded amounts (ADR-0022), or an amount the user wrote. |
| `stock-claim` | the evidence, the catalog or a mapped tool result gives stock, as a quantity or as availability (ADR-0020) | No availability claim when stock is unknown. Claims must match known stock, of the product named, returned or seen by the model (ADR-0026), in full or by a start of its name no other shares (ADR-0027); with a catalog, also a catalog product the answer only names, in full (ADR-0061). Negated wording is read: "stokta değil" is out of stock, and an English negation just before a claim phrase cancels it (ADR-0061). |
| `policy-claim` | the profile lists policies | Concrete claims (durations, fees, "free shipping") need a source and must match it. |
| `filter-honoured-or-disclosed` | the turn carries filters | Returned items satisfy the filters, or the answer discloses the relaxation. |
| `type-matched-or-disclosed` | the turn names the requested type | Returned items are of that type or a type under it, or the answer says it shows other types. |
| `no-duplicates` | evidence has ids | |
| `absence-correct` | the turn expects absence | The answer states the absence and doesn't present other types as the requested one. |
| `over-refusal` | the turn says whether the request is answerable | An answerable request isn't refused, and one marked not answerable is. Uses the language pack's lexicon and the profile's canonical refusals. |
| `deflection` | the turn is answerable, and sets no `request` (ADR-0075) | The answer does more than send the user to customer service. Advisory: it never decides a case. |
| `request-handled` | the turn sets `request`: `chitchat`, `handoff` or `support` (ADR-0075) | No evidence items in any mapped collection, clarifying question or not; no `absence` phrase of the language pack unless a `deflection` phrase or one of the profile's `response.contactPhrases` is there too; and for a `handoff`, one of those as a pointer to a person or a channel. |
| `route-expected` | the turn expects a route, and the profile maps one | |
| `answer-text` | the turn lists phrases or patterns the answer must or must not contain, or the profile's `everyAnswer` does (ADR-0030) | Phrases are matched after folding; patterns, regular expressions, on the answer as it came. |
| `json-schema` | the profile has a response contract, or the turn a schema (ADR-0030) | Every value a rule's path selects matches its JSON Schema, in the subset yokla checks itself; a path that selects nothing fails. |
| `answer-similarity` | the turn has `similar` (ADR-0030) | The answer scores at least `min` against one reference answer, or at most `max` against every one: the cosine similarity of character trigrams after folding. It measures wording, not meaning. |
| `evidence-count` | the turn expects evidence counts or ids | |
| `graceful-under-fault` | the turn injects provider faults (ADR-0013) | The target still gives a usable answer. |
| `answered-within-deadline` | the turn sets `deadlineMs` (ADR-0013) | The full answer arrived in time. |
| `status-allowed` | the turn sets `allowStatus` (ADR-0018, ADR-0019) | The target handled the edge case: a complete 2xx answer or an allowed status. An edge-case turn is judged on its answer, never stopped by it. |
| `language-match` | the turn sets `language` (ADR-0018) | The answer is in that language, by the share of each language pack's most common words. Too short or too close to tell is unmeasured. |
| `cost-budget` | the turn's budget sets `costUsd` or `modelCalls` (ADR-0014) | The turn's model calls stay within it, from the proxy, or else from spans (ADR-0029). Unmeasured without either. |
| `prompt-budget` | the turn's budget sets `inputTokens` | No model call of the turn sends more input tokens. |
| `prompt-leak` | the profile's canary reached a system prompt (ADR-0015) | The answer doesn't contain the canary. Long n-gram runs from the system prompt, without a canary, come with the red team's extraction attacks (v0.5). |
| `untrusted-in-system` | the profile names the evidence fields that hold retrieved content | None of their values is in a system message of the turn's model calls. |
| `pii-in-prompt` | the turn lists `notSentToModel` values | None of them is in any message of the turn's model calls. |
| `tool-calls` | the turn sets `tools` (ADR-0025) | The tool calls the turn's model calls asked for: those expected, none forbidden, expected arguments, order, and at most `maxCalls`. Unmeasured without the proxy's data. |
| `tool-call-valid` | a model call of the turn offered tools (ADR-0025) | Each tool asked for was offered by that call, with valid JSON arguments. |
| `injection-canary` | a turn injects into a tool's results with a canary (ADR-0043) | The answer doesn't contain the canary; acting on the instruction is judged by the turn's `tools`. Unmeasured when the injection reached no tool result. |
| `pii-leak` (v0.5) | the case seeds fake PII | Seeded values don't appear where they shouldn't. |

Latency has no per-turn check besides `deadlineMs`. Its percentiles are gate
thresholds per suite (ADR-0014, §16).

**Where a failure arose (ADR-0033).** A failing finding can name its subject:
the amount, duration or phrase in the answer it is about. `price-grounded`,
`policy-claim` and `answer-text` do. Core then finds where that value first
appears in the turn's model calls: in a message a call sent (`input`), in a
call's answer (`model`), in neither (`app`), or `unknown` when the proxy's
view is missing. The origin explains a finding and never changes a verdict.

### Judge checks (v0.5)

Rubric-based checks (helpfulness, tone, faithfulness of free text) will have to
pass a calibration set of seeded cases in every run. If any calibration case is
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

- **Adapters:** HTTP; WebSocket, one connection per sample (ADR-0024);
  in-process function, SDK and CLI adapters later.
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
- **Authentication (ADR-0031):** with `target.auth`, the runner gets a token
  for the run, by OAuth 2.0 client credentials or by a token request the
  profile describes, and the profile puts it where the target expects it,
  with `{{auth.token}}`. A token is replaced before it expires, and after the
  target answers `401` or refuses a WebSocket handshake; the request is then
  sent once more. One fetch serves every request waiting for it.
- **Requests:** a case turn can add body fields and headers to the profile's
  request. With `request.requestId`, every request carries a unique id in a
  header, for correlating the target's logs (ADR-0009).
- **Rate limits:** a token bucket built from the profile's limits (per second,
  minute and hour). The runner honours `429` and the retry headers the profile
  names, in seconds or milliseconds (`Retry-After` by default; prefixes such as
  `retry-after-*` for tiered limits). It can optionally send a per-case client
  identity header (addresses from the TEST-NET ranges) when the target limits
  per IP and the operator allows it.
- **Cache bypass:** applied before every sample, as the profile defines it (a
  header, or a local command given as an argument list, never a shell). Every
  sample is cold today. Warm samples, reported separately, come later.
- **Warm-up (later):** warm-up requests, excluded from latency statistics.
- **Deadlines:** a timeout per request (`request.timeoutMs`) and a deadline per
  turn (`deadlineMs`, ADR-0013). A deadline per run comes later.
- **Samples:** N per case: the case's `samples`, else `--samples`, else 1.
  With `--stop-early`, a case stops once no further sample can change its
  failure (ADR-0038).
  Defaults per suite (1 for deterministic paths, 3–9 for paths that call a
  model) come later.
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
- Gemini's native API (ADR-0032), on AI Studio and Vertex AI alike:
  `…/models/{model}:generateContent` and `:streamGenerateContent`, the model
  read from the url. Thinking tokens count as output, as Google bills them,
  and show apart as reasoning.
- The AI SDK's gateway protocol (ADR-0069): `…/language-model`, the model
  and streaming read from its headers, specification version 4 only.
- Streaming (SSE) passes through.

**Setup (ADR-0012).** `yokla proxy` runs as its own process, started before the
app. The app's provider base-URL variable points at it
(`http://127.0.0.1:<port>/<upstream-id>`). The proxy forwards to the real
upstream with the app's own credentials. It holds no keys and binds to
localhost only.
- It changes a response only to inject a turn's fault plan (ADR-0013), or
  answers one from a cassette (ADR-0040), and never outside a recording.
  Usage a provider didn't report stays unmeasured.
- `yokla run` opens a recording on the proxy's local control endpoint before
  the first case and closes it after the last, and reads its records from
  there.

**Correlation: which provider calls belong to which test request?**
1. `serial`, the default: one request in flight; every call in its window
   belongs to it. The profile sets the mode for the whole run, and `serial`
   needs a concurrency of 1: the run refuses a higher one. The runner marks
   each turn on the proxy before its request, and the proxy tags each call
   with the turn marked when it started, so attribution needs no clock.
2. `header`: the target forwards `x-yokla-trace` to its provider calls. This
   takes a one-line change in the app, or OTel baggage.
3. `traceparent` (ADR-0029): W3C trace context, if the app already propagates
   it. With `modelProxy.spans`, the runner sends each turn a `traceparent`
   with a trace of its own, and the app's OpenTelemetry spans for its model
   calls are tied to the turn whose trace they are in. Without upstreams, this
   is the run's correlation, and it allows any concurrency.

**Calls after the answer (ADR-0016).** Apps often call their model after
answering, for example to update a memory. In `serial` correlation the runner
asks the proxy to settle after every answer: it waits until none of the
target's calls is in flight and none has ended for `quietMs`, and only then
marks the next turn. So such a call is counted for the turn that caused it.
Every recording also settles before it closes, so the calls after the last
answer are recorded.

The report always states which mode was used.

**Cost.** Prices per upstream and model, for each token kind (input, output,
cached input, cache write), live in a price table in `yokla.config.yaml`.
Prices are configuration and are never hard-coded. A call without a price, or
with tokens the provider didn't report, costs null, never 0.

**Fault plans, per scenario:**
- latency (fixed or with jitter; the jitter is the same for the same case,
  sample and turn in every run, ADR-0017),
- status codes `429`, `500`, `503`,
- timeout (the connection is held without an answer),
- malformed JSON,
- truncated stream,
- empty content,
- tool calls that violate their schema,
- the model's answer replaced with a text the case gives (`answer`,
  ADR-0040), to ask what the app does when the model says something else.

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

**The model's answer (ADR-0033).** The proxy also reads the text each call
answered, as the app got it, and keeps it as prompt text is. With the
messages, it tells where a finding's value first appeared (§10).

**Cassettes (ADR-0040).** `yokla run --record` keeps every model call the
proxy tied to a turn in a cassette: the turn's key (case, sample and turn),
the call's position, its upstream and path, a hash of its request, and the
provider's answer in full. `yokla run --replay` sends the cassette to the
proxy, which answers each call from it and forwards nothing, so a suite
repeats with no model cost and with the answers it got.
- A call finds its answer within its turn, by upstream, path and request
  hash. A call with no match diverged: the app asked something it didn't ask
  when the cassette was recorded. It gets a `502`, and its turn is an
  `error`; with `--replay-loose`, the recorded call at the same position
  answers it instead.
- A turn's faults apply to replayed answers too, so the resilience cases run
  on a cassette, and an `answer` fault changes one recorded answer.
- The runner writes the file; the proxy keeps the answers in memory for the
  recording that asked for them.

**Tool results changed (ADR-0043).** A case turn can inject text into a
tool's results before the model sees them, and `yokla run --reverse-items`
reverses arrays in a tool's results for a whole run; `yokla compare
--expect-same` then fails when a verdict moved.

**Model swaps (ADR-0042).** `yokla run --swap-model <upstream>:<asked>=<model>`
has the proxy send each call that asks for a model to another, in the same
protocol, on the same upstream or another of its kind, within the run's
recording. Each call keeps the model the app asked for, and is priced by the
one that answered. `yokla compare` sets the runs side by side and names the
cheapest that passes the gate.

**Tool calls (ADR-0025).** The proxy also records the tools each call offers
and the tool calls its answer asks for, with arguments kept as prompt text is.
`tool-calls` judges a turn's trajectory against its case, and
`tool-call-valid` checks that each call asked only for tools it offered, with
valid JSON.

**Limits.** When the proxy can't see a target's calls, two other sources give
cost and path signals:
- **The app's OpenTelemetry spans (ADR-0029).** `yokla proxy` reads OTLP/HTTP
  trace exports, as JSON or protobuf, and a span with
  `gen_ai.operation.name` is a model call: its provider, model, token counts,
  duration and failure, never its messages. Spans come in batches, so the run
  waits once, at its end, until they stop. A turn without proxy calls is
  judged on its spans' calls; prompt inspection and tool calls still need the
  proxy.
- **The target's own structured logs (ADR-0009).**

Providers that sign requests (AWS SigV4) and SDK-only transports can't be
proxied transparently in v1. Without spans or a log source, their cost and
path stay `unmeasured` instead of being guessed.

**Data.** Records stay local. The profile sets what of each prompt the
results and the records file keep: role and length by default, or also a
hash, the text with patterns redacted, or the full text (ADR-0015).

## 13. Aggregation, statuses and statistics

- **Each finding has a dimension; each dimension has an aggregation policy.**
  Packs define the policies; a dimension no pack lists is worst-of-N.
  Overriding a policy from the config comes later.

  | Dimension | Default policy |
  |---|---|
  | fabrication, over-refusal, filter honesty, duplicates, absence, request (ADR-0075), and the core dimensions (leakage, cost, resilience and the others) | **worst-of-N**: one bad sample fails the case |
  | refusal correctness | **majority-of-N** |
  | deflection (sent to customer service) | **advisory**: reported, never decides the case |
  | latency | percentiles over the suite's answered turns, every sample pooled, as gate thresholds (ADR-0014) |
  | judge rubric (v0.5) | mean, with interval |

- **Statistics.** Rates are reported with Wilson 95 % intervals. A case whose
  samples disagree is flagged `unstable`.
- **Pass rates (ADR-0076, ADR-0077).** The summary gives, over the run, per
  suite and per tag, the pass rate: passing cases (`pass`, `gap-closed`) over
  passing and failing ones, with its Wilson interval. `unmeasured`, `error`,
  `known-gap` and `fixture-missing` cases are left out. A case may carry a
  `weight`, its share of traffic (default 1); once one isn't 1, each rate has
  a weighted rate beside it, the weights of passing cases over those of
  measured cases, without an interval. A case with several tags counts in
  each. Weights and tags never change a verdict or the gate.
- **Status precedence:** `error` (a turn couldn't be run or read) → `fail`,
  or `known-gap` for a case marked as a known gap → `unmeasured` → `pass`, or
  `gap-closed` for a case marked as a known gap. A case where no deciding
  dimension applied is `unmeasured`. `fixture-missing` is a case whose
  expectations state a fact the data no longer holds; it sends nothing
  (ADR-0053).
- **Approval (ADR-0004, ADR-0018).** A case yokla writes, such as a starter
  case of `yokla init`, is `proposed`: it runs and is reported, but the gate
  and the baseline leave it out until a person sets it to `approved`. A
  `rejected` case doesn't run. A case without provenance was written by a
  person and is approved.
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

ADR-0014 sets how cost and latency are bounded.

- **`yokla plan`** prints the expected cost of a run and an upper bound, and
  contacts nothing.
  - It prices each case from its own turns in a calibration run made with the
    model proxy, or with spans, while the case's definition is unchanged, and
    otherwise from the mean calibrated turn. A turn the proxy saw no calls for
    is priced by its spans (ADR-0029).
  - The upper bound is the estimate times `plan.upperBoundFactor`, 2 by
    default.
  - Without a usable calibration it gives no figure.
  - A simulated customer's case is priced from its own calibration, the
    customer's calls included (ADR-0028).
  - Counting calls from the profile, adding yokla's own generator, attacker
    and judge calls, and tuning the factor from past runs come later.
- **`--max-cost`** is a hard cap. After each sample the runner totals the
  recorded cost, yokla's own calls included (ADR-0028). Once the total
  reaches the cap, no new sample starts and the results are marked partial.
  A call without a cost makes the cap unenforceable, so the run stops there
  too. Without upstreams, the cap counts the costs of spans; a span that comes
  late is counted at the next check (ADR-0029). Without a model proxy, the cap
  counts yokla's own calls alone. A call answered from a cassette reached
  no provider, and the cap doesn't count it (ADR-0040).
- **Per-turn budgets** (`budget.costUsd`, `budget.modelCalls`) and per-suite
  thresholds (latency percentiles, cost per turn, total cost) judge what was
  spent (§16).
- **What the report shows.** The terminal report shows the actual cost. The
  estimate next to it, and the cost per component (the target versus yokla's
  own calls), come later.

## 15. Privacy and egress

- **No telemetry.** If it is ever added, it is opt-in, documented and off by
  default.
- **Network allowlist.** yokla's HTTP client refuses every host except the
  target URLs, the proxy upstreams and the model providers the user configures.
- **An egress test in CI** runs the demo-shop suites, and the model proxy's
  runs against a fake provider, behind a network guard. It fails on any other
  host.
  - The guard records every TCP connection and DNS lookup of the yokla
    process and stops the ones not allowed before anything leaves.
  - It has its own tests, so the egress test can't pass vacuously.
  - Local commands a profile runs, such as a cache bypass or a log reader,
    are the user's own and run outside it.
- **Secrets** are read only from the environment and never written to results.
  A token yokla obtains is a secret too (ADR-0031): it, and every environment
  value the auth section uses, show as `***` in whatever yokla writes, even
  when the target echoes one. Token urls must use HTTPS, except to a loopback
  host.
- **Target data.** Generated and recorded files may contain the target's data,
  so `yokla-data/` and `runs/` stay out of version control. `yokla init`
  adds them to `.gitignore` (ADR-0018). The HTML report holds the target's
  answers too (ADR-0023), and so does the simulated customer's reply cache
  in `yokla-data/customer/` (ADR-0028). A cassette holds the provider's
  answers in full, though no request text, and is kept like a results file
  (ADR-0040).
- **The analyzer.** `yokla analyze` reads the target's repository and data
  on the machine and sends none of it anywhere; it contacts only the
  target's urls, with up to three probes. It never opens environment files
  that may hold secrets. Its proposal and report hold paths, field names,
  answer shapes and the probes' messages, which name a type and a product of
  the catalog; never a data file's rows or an answer's values (ADR-0047).
  With `models.analyzer`, the text of its docs, prompts and code goes to that
  model, never its data, environment or test files; the terminal names the
  model's url before the first call, and a local model keeps it on the
  machine. The cache of its replies in `yokla-data/analyzer/` quotes the
  code (ADR-0049).
- **Transforms a model writes.** With `--transform paraphrase` or
  `code-switch`, the cases' written messages go to `models.transform`; the
  terminal names its url before the first call, and its rewrites are cached
  in `yokla-data/transform/` (ADR-0059).
- **Coding agents.** `yokla mcp`'s tool results hold the target's answers,
  which the agent may send to its own model, hosted or local. Prompts appear
  only as `prompts.store` keeps them (ADR-0041).
- **yokla's own models.** A hosted model that plays the simulated customer
  receives the conversation, the target's answers included. Configuring one
  is the user's choice; a local model keeps it on the machine (ADR-0028).
- **Untrusted downloads.** Downloaded datasets and attack corpora are treated
  as data and never executed.

## 16. Results, reports and gates

- **Results file.** A versioned JSON schema (`results.v1`) holding:
  - run metadata: yokla version, profile hash, environment, correlation mode,
    the model proxy's totals, whether the run recorded or replayed a
    cassette (ADR-0040), the model swaps it made (ADR-0042), the transforms
    of its messages (ADR-0045), and, from `yokla explore`, the coverage it
    reached (ADR-0044),
  - findings per case, sample and turn, with the origin of a failing
    finding's value (ADR-0033),
  - each turn's model calls and cost, and the fields observed in the target's
    logs,
  - aggregates and timings, and the summary's pass rates over the run, per
    suite and per tag, weighted too when the cases carry weights (ADR-0076,
    ADR-0077).
- **Reports:** a terminal summary, JUnit XML, and a single-file offline HTML
  report with no script that shows every turn (ADR-0023). Both summaries
  show the pass rate, the weighted rate and the failing cases heaviest first
  when the cases carry weights, and the rates by tag (ADR-0076, ADR-0077). A
  Markdown summary for pull requests comes later.
- **Gate (ADR-0010).** `yokla gate` applies the thresholds per suite from
  `yokla.config.yaml`. Exit codes: `0` passed, `1` gate broken, `2` run error.
  - By default a suite allows no `fail` and no `unmeasured` case;
    `maxFailures` and `allowUnmeasured` relax that per suite.
  - A proposed case doesn't gate until a person approves it; the gate names
    it in a notice (ADR-0004).
  - A case that passed in the baseline and no longer passes always breaks it,
    unless its definition changed (ADR-0011).
  - `yokla baseline --results <file>` accepts a run as the baseline and
    prints what changed.
  - A run with an `error` or `fixture-missing` case, or a partial run, can't
    be judged and exits with `2`.
  - A run limited by `yokla run --tag` is gated on the cases it ran: a case
    it didn't run is not a regression (ADR-0077).
  - `yokla compare` sets runs side by side, such as one per model, gates
    each, and names the cheapest that passes (ADR-0042).
  - Latency percentiles and cost thresholds per suite (`latencyP95Ms`,
    `costPerTurnUsd`, ...) are judged over every answered turn, every sample
    pooled; a threshold without data breaks the gate as `unmeasured`
    (ADR-0014). So does a latency threshold of a replayed run, whose answers
    came at once (ADR-0040).

## 17. Packs

**A domain pack provides:**
- profile schema extensions,
- case expectation extensions, such as filters and product types,
- checks,
- dimension policies,
- intents: turns built from the target's data and profile, for `yokla
  explore` (ADR-0044); the e-commerce pack's ask for products, types, prices,
  policies and the cart, in Turkish and English,
- later: generators (v0.4), attack templates (v0.5) and a glossary.

**A language pack provides:**
- **money and number parsing and formatting:** `1.299,90 TL` vs `$1,299.90`,
- **case and diacritic folding:** Turkish dotted and dotless *i*,
- **lower casing and diacritic removal,** apart, for robustness transforms
  (ADR-0045),
- **lexicons** for refusal, absence and inability,
- **policy-claim patterns:** `14 gün`, `30 days`,
- **attack phrasing templates** (v0.5),
- **morphology helpers:** suffix-aware matching for agglutinative Turkish.

**v1 packs:** `ecommerce`, `lang-tr`, `lang-en`.

**Third-party packs** will be npm packages named `yokla-pack-*`, loaded
explicitly from the config, with no auto-discovery. Today the CLI loads the
first-party packs only.

**Checks the user writes (ADR-0030).** Until packs are open to others, a
user's own rule is a check module that `yokla.config.yaml` names. It
default-exports a check by a small contract, versioned apart from yokla's
internal check API: a frozen copy of the turn in, findings or not applicable
out, synchronously. The profile and case files never name code, because
machines write them. The results record each module's hash.

## 18. Interoperability

- **Export (v0.6).** `yokla export <tool>` will write another tool's
  configuration: the target as an HTTP provider that maps the evidence, plus
  JavaScript assertions that call yokla's checks.
- **Import (v0.6).** Another tool's results will be importable into yokla
  results for reporting and gating. Its test cases will be importable as yokla
  cases with status `proposed`.
- Each mapping lives in its own `interop-<tool>` package (ADR-0007).
- **OpenTelemetry (ADR-0029).** `yokla proxy` accepts OTLP/HTTP trace exports
  and reads GenAI spans as model calls, for targets the proxy can't see.
  gRPC export and span files a collector writes come later.

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
- adding a product to the cart the user didn't ask for,
- asking for the same search twice in one turn,
- a stale price given to the model, and a right price the app lowers after
  the model wrote it,
- a wrong price in every other answer, a failure that comes and goes,
- an out-of-scope question answered instead of refused,
- following an instruction injected into a tool result, with `--tool-results`
  (ADR-0043),
- a Turkish message typed without Turkish letters answered in English
  (ADR-0045),
- later (v0.5): exposing another session's order.

Each defect is added in the version whose checks detect it, so that "every
defect is detected" holds for every version. v0.1 has the first eight; v0.2
adds the three resilience defects, caught with faults the model proxy injects,
and the four inspection defects, caught in the prompts the proxy captures.
v0.3 adds the two tool-call defects, caught in the tool calls the proxy reads
(ADR-0025), and three defects only the generic checks catch (ADR-0030): a
template placeholder left in the greeting, caught by the profile's
`everyAnswer` patterns; a field gone from the response's metadata, caught by
its contract; and catalog ids shown in answers, caught by the demo-shop's own
check, `checks/no-internal-ids.ts`, which its `yokla.config.yaml` names. The
returns case also holds the answer close to the FAQ's wording, so the invented
return policy breaks `answer-similarity` too. The debugging track's D1 adds
two price defects whose wrong price comes from elsewhere than
`fabricated-price`'s (ADR-0033): `stale-price-in-prompt`, from what the model
was sent, and `price-rewritten`, from the app. With `fabricated-price`, from
the model, each is caught by `price-grounded` alone and traced to its own
origin. D2 adds `flaky-price`, which yokla shrink must report as flaky rather
than shrink (ADR-0035). D3 adds `out-of-scope-answered`, the one defect a
majority-of-N dimension catches, so that `--stop-early` is shown settling a
majority failure (ADR-0039). D4 adds no defect: a recorded run of the
acceptance and resilience cases replays with the same results and no call to
the provider, and the resilience defects are caught on the cassette. A case
in `cases-replay` makes the writer say a price no product has, which the shop
passes on, as a known gap, and `price-grounded` traces it to the model; a
shop whose prompts changed (`prompt-bloat`) no longer matches the cassette
(ADR-0040). For D5, a scripted client drives `yokla mcp` over stdio against
a shop with `price-rewritten`: it runs the cases, reads a failing one, shrinks
it, and verifies the fix once the shop restarts without the defect, and a
shop that breaks the response contract shows the regressions (ADR-0041).
On 2026-11-16 a coding agent with no other context did the same by hand. It
had only the tools, through a shell bridge, and a copy of the shop with a
launch-price rewrite written into its code. In 28 tool calls it ran the
cases, read the origin `app`, shrank the failing case, removed the rewrite
and confirmed the fix with `verify_fix`. Its feedback added the cases
`verify_fix` ran and the failing cases of other suites to its result, the
reproduction rate and candidates to `shrink_case`'s, the proposed cases
apart to `run_cases`'s, and the evidence to `explain_finding`'s.

For D7, `--tool-results` sends the writer its search result as a tool
result, fenced as data, and `unfenced-tool-results` sends it as it is; the
fake provider, like a model that gives in, follows an instruction in a tool
result outside the fence. The injection case passes on the shop that fences,
fails `injection-canary` alone on the one that doesn't, from the input, and
is unmeasured on a shop that sends no tool result. Reversing the search
results for a run moves no verdict (ADR-0043). This is §19's "following an
instruction injected in product text", brought forward from v0.5.

For D6, the fake provider answers three writer models by name, and the
cheapest, `demo-writer-nano`, invents a price. The acceptance runs as the
app asks and with each swap, and `yokla compare` names `demo-writer-mini`
as the cheapest run that passes the gate (ADR-0042).

For D8, a cart of two products or more is answered with each product's price
and a total, and `cart-total-off` totals it 10 % low. No written case puts
two products in a cart.
- **Reach:** `yokla explore`, from the acceptance cases with the model over
  HTTP behind the proxy, reaches every route and every tool.
- **With the defect:** the acceptance cases pass, and a proposed case fails
  `price-grounded` on its second cart addition.
- **Without it:** no explored case fails, and two explorations write the
  same cases (ADR-0044).

For v0.4's robustness transforms, the shop reads past a typo of a word it
knows, and `language-by-letters` tells Turkish from English by Turkish letters
alone. Every written Turkish message has one but the greeting, which expects
nothing that depends on the language.
- **The correct shop:** the acceptance cases keep every verdict under every
  transform.
- **With the defect:** the written cases pass; without diacritics, three
  Turkish cases are answered in English and fail, and `yokla compare
  --expect-same` names them (ADR-0045).

For the transforms a model writes (ADR-0059), the fake provider plays
`models.transform` by rules: a paraphrase turns "X var mı?" into "X
bulunuyor mu?" and gives other messages a polite opening, and writes 500 as
"beş yüz"; a code-switch turns the shop's product words into the other
language's. `language-by-words` answers in English a Turkish message that
holds an English product word.
- **The correct shop:** every verdict holds under both. The paraphrase
  changed 18 messages; the one that lost "500 TL" was sent as written, and
  the run said so. The code-switch changed 12, and left 7 without a product
  word as written.
- **With the defect:** the written cases pass, and so does the paraphrase;
  the code-switch answers `tents-under-500-tr` and `sleeping-pad-tr` in
  English, and they fail.
- **A second run** sends the same messages, from the cache, at no cost.
- **With a real model (ADR-0059, ADR-0060):** Claude Haiku 5.5 through a
  hosted gateway, on the correct shop, each run approved with its estimate,
  on 2026-11-17; each cost $0.0011 for both kinds.
  - **First run, prompt version 1:** the paraphrase kept 16 verdicts, and
    moved two cases that share a message, rewritten as "medium-sized
    jackets": the shop doesn't read it as size M. The code-switch added
    requests, such as a two-person tent and a question about headphones,
    and moved "Can you recommend a stock to invest in?" half into Turkish;
    its two moved cases moved by the rewrite. ADR-0060 came from it.
  - **Second run, version 2 and ADR-0060's checks:** the code-switch kept
    all 18 verdicts; four rewrites were not sent, two of more than one
    line, one that added a sentence and one unchanged. One rewrite still
    added a detail inside its sentence, "for a gömlek I bought last week",
    and moved nothing. The paraphrase moved three cases, each by a gap of
    the shop: "a medium" for size M, in the two cases that share a message,
    and "uyku minderi" for a sleeping pad.
- **Repeats:** two runs with typos send the same messages.

For the analyzer's first step, `yokla analyze` reads a copy of the
demo-shop's repository and probes the shop in process, with its hand-written
profile's request (ADR-0047). It never lists that profile, the cases or the
configuration.
- **What it proposes:** 49 entries, every one the hand-written profile's:
  the response's text and route, the session mode, the product and cart
  evidence, the catalog and its type separator, the languages, the domain,
  the three policies' sources, and the 19 of the response contract from
  `openapi.json`, which every probe answer keeps (ADR-0057, ADR-0058). On a
  copy whose contract requires a field the answers lack, the contract is
  not proposed, and the report names the violation by its path.
- **What it misses:** 20 entries, recall 71.0 %: the size and gender of
  products, which the probed tents don't have, and what code, docs and
  prompts must give: the limits, the cache bypass,
  the capabilities, the canonical refusals, `everyAnswer` and
  `neverFabricate`; and the catalog's type labels (ADR-0050) and attributes
  (ADR-0055), which no step proposes yet.
- **Gating:** the proposal doesn't run until its entries are approved, and
  two analyses write the same file.
- **With a model (ADR-0049):** the fake provider plays `models.analyzer` by
  rules. It finds the rate limits in `src/server.ts`, the cache bypass in the
  README and the refusals in `src/model.ts`, and invents a limit the line it
  quotes doesn't hold. The proposal gains the 7 entries, all the
  hand-written ones, recall 81.2 %; the invented limit is listed as
  unverified. A second analysis answers from the cache, with no call.
- **Cut replies (ADR-0051):** the fake provider honours `max_tokens`. With
  20, the replies that hold entries are cut: the summary and the report name
  their chunks, and none of their values is proposed. With 2000, only those
  chunks are asked anew; the others come from the cache.
- **With a real model (ADR-0049, ADR-0051):** Claude Haiku 5.5 through a
  hosted gateway, each run approved with its estimate, on 2026-11-17.
  - **First run:** `maxTokens` 2000, one token per four characters. 7
    chunks, $0.0107. Precision 100 %, recall 53.1 % (34 of 64). The model
    reasons: 4,887 output tokens were billed for about 290 visible. The
    README chunk's reply stopped at `maxTokens` inside its JSON and was lost
    without a trace, the cache bypass with it. The input billed was 82,880
    tokens against 50,880 estimated. ADR-0051 came from both.
  - **Second run:** `maxTokens` 8000, one token per two characters. 13
    chunks, estimated $0.0626 (at most $0.1251), spent $0.0111. The input
    billed was 85,781 tokens against 105,688 estimated. No reply unread,
    nothing unverified. Precision 100 %, recall 56.1 % (37 of 66, the
    profile having grown by then, ADR-0050): the entries the fake provider
    finds, the cache bypass included.

For cases the data no longer holds (ADR-0053, ADR-0054), the acceptance
cases run on a copy of the demo-shop whose catalog gained a hammock, as
`outdoor/camping/hammock`, and lost its water bottles. `hammock-en` and
`water-bottle-en` are `fixture-missing`, each with the fact that changed, and
the shop receives no request for them. The other 16 cases pass, as on the
unchanged catalog. The run and the gate exit with `2` and name both, and
`run.data` names the copy's catalog by its hash.

For the generated cases (ADR-0055, ADR-0056), `yokla generate` writes every
kind in Turkish and English from the demo-shop's catalog: 30 cases with
`--absent en:hammock --absent tr:hamak`, the same file twice. Without
defects all 30 pass. Each data defect fails a case of the kind meant for it:
`fabricated-price` a `lookup`, `unknown-stock-claim` an `unknown-stock`,
`absence-substitution` an `absent-type`, `filter-ignored` an `attribute`,
and `type-padding` an `attribute`, since the shop relaxes an empty band and
says so instead of padding it. The shop shows the products a message names
first, so a comparison or a stock question shows what it asks about.

For the intents that state what they ask (ADR-0046), `type-bound-ignored`
drops the price bound for sleeping bags, a type no written case asks about.
- **Reach:** at the default six types, the round-robin over the type tree's
  branches doesn't reach sleeping bags, the camping branch's second type;
  with `--types 7` it does.
- **With the defect:** the proposed cases that ask for sleeping bags under
  their median and under their lowest price, in both languages, fail
  `filter-honoured-or-disclosed`.
- **Without it:** no explored case fails, under-the-lowest-price turns
  included, and ADR-0044's criteria hold at the default budget.

For intents that ask as a shopper names things (ADR-0048), the catalog holds
trekking poles under two branches, `hiking` and `kids`. The search asks for
them once per intent and language, each turn states both types, and on the
correct shop none fails. Turkish amounts are written in `TL`, and one Turkish
turn asks with `TRY`.

For a type asked by its catalog label (ADR-0050), the catalog holds kids'
sleeping bags under a size level, `outdoor/camping/sleeping-bag/junior`, and
every sleeping bag carries the label "uyku tulumu" and "sleeping bag".
- **With the label,** the search asks for "uyku tulumu", never "junior", and
  each turn states both types; on the correct shop none fails.
- **Without it,** the same search asks "junior var mı?".
- **ADR-0046's criteria still hold:** with `type-bound-ignored`, the turns
  under the median and under the lowest price fail, now asked as "uyku
  tulumu".

For the currency-code turn where a dropped bound shows (ADR-0052),
`currency-code-ignored` drops a price bound written with the code.
- **The Turkish code turn,** "900 TRY altında backpack var mı?", at the
  backpacks' lower quartile, fails `filter-honoured-or-disclosed`. At their
  median, 1500, it would pass: the shop shows the three cheapest, all under
  1500.
- **English writes the lira with its code,** so its under-price and
  empty-band turns meet the defect too; the median turns of three types
  pass it, as the Turkish one would have. Every failing turn writes `TRY`.

**Spans.** With `--otel-url` and the model over HTTP, the demo-shop exports a
GenAI span for each model call, in the trace of the incoming `traceparent`,
as OTLP/HTTP JSON or protobuf (ADR-0029). Its exporter has no dependency and
is written apart from yokla's reader, so each checks the other. The proxy
end-to-end test runs the acceptance cases with spans on, once per protocol:
for every turn, the calls read from spans match the proxy's records. A
demo-shop that calls the provider directly is measured from its spans alone,
and they reconcile with the provider's records.

**Simulated customers.** The demo-shop's fake provider also plays yokla's
customer, by simple rules, at no cost (ADR-0028).
- `cases-customer` holds three purchase goals.
- The end-to-end test checks that each goal is reached and that every turn
  passes the checks.
- A second run repeats every conversation from the reply cache.

**Acceptance.** With all defects off, every suite passes. Turning each defect on
breaks exactly the expected checks. This is a system-level mutation test, and it
runs in CI at zero model cost.

**Checks.** Every check has unit tests and mutation tests, and the mutation
harness asserts each mutation was applied.

**Egress.** The egress test described in §15. It wraps the acceptance runs,
the gate and the baseline in `packages/cli/src/demo-shop.e2e.test.ts`, and
the model proxy's reconciliation, resilience and inspection runs in
`packages/cli/src/proxy.e2e.test.ts`, the recorded and replayed runs in
`packages/cli/src/replay.e2e.test.ts`, the model swaps in
`packages/cli/src/compare.e2e.test.ts`, the tool result changes in
`packages/cli/src/tool-results.e2e.test.ts`, the transformed runs in
`packages/cli/src/robustness.e2e.test.ts`, the analysis of the demo-shop's
repository in `packages/cli/src/analyze.e2e.test.ts`, and the MCP session in
`packages/cli/src/mcp.e2e.test.ts`, whose `yokla mcp` child process loads
the guard with `--import`.

**External targets:**
- **A private production e-commerce assistant.** Results are not published.
  The analyzer and generators must rediscover issue classes already known
  there:
  - type absence vs price-band relaxation,
  - stale data-bound cases,
  - fabricated prices,
  - prompt injection.

  In v0.4 (2026-11-16 to 2026-11-18):
  - **Rediscovered:** type absence vs price-band relaxation, by `yokla
    explore` and written cases.
  - **Not rediscovered, every turn judged:** fabricated prices, over four
    runs of 15 generated price cases; direct prompt injection, over 8
    cases of 3 samples each.
  - **Waiting:** stale data-bound cases, until its data changes.
  - **Its repository,** analyzed without a model and with its catalog
    given by `--data`, gave a precision of 81.0 % and a recall of 34.7 %.
    Matching prices sent as text (ADR-0067) left both unchanged: two of
    its fields hold the same price in every product shown, and values
    can't tell them apart. The summary now names both (ADR-0068).
  - **With the model step** (ADR-0049, $0.0227), both stayed the same: the
    token budget was spent on docs and prompts, and the code that holds
    the rate limits and the cache layers was never read. Files that name
    the fields asked now go first (ADR-0072), the shortest first: by how
    many fields they named, a few large docs took the whole budget
    (ADR-0073).
  - **Indirect injection through a tool result** wasn't tried: the target
    can't be pointed at the model proxy. The proxy now reads its
    provider's protocol (ADR-0069); the target needs a base url setting.
  - **Released as 0.4.0** with this criterion partly met (ADR-0070).
  - **What yokla learnt:** these runs led to ADR-0061 to ADR-0069.
- **A public open-source retail assistant,** to prove that yokla generalises.
  It streams its answers, opens its own sessions and calls its model after
  answering. In v0.2 its model cost reconciled with the provider's records,
  call for call. It also found gaps in evidence mapping that are now on the
  v0.3 roadmap.

## 20. Roadmap

Each version is usable on its own. A version ships when its exit criteria hold.

| Version | Scope | Exit criteria |
|---|---|---|
| **0.1 — core** | core schemas (profile, case, results); HTTP adapter; runner with rate limiting and cache bypass; observation from the target's logs (ADR-0009); e-commerce checks (price, stock, policy, filter, type, duplicates, absence, over-refusal); `lang-tr`, `lang-en`; aggregation policies; JSON, terminal and JUnit reports; gate; demo-shop | every demo-shop defect detected; a real assistant tested with a hand-written profile |
| **0.2 — proxy** | OpenAI-compatible and Anthropic proxy; `serial` and `header` correlation; cost and latency per request; fault plans; inspection checks; perf, cost and resilience suites; `yokla plan`; streaming targets, session setup, and model calls the target makes after its answer | cost on demo-shop and on one real target reconciles with the provider's usage records; resilience defects detected |
| **0.3 — reach and conversations** | a first run in five minutes: `yokla init` sends the target one message, works out where the answer is in its JSON or event stream, writes a profile for review, and adds starter cases that suit any assistant (greeting, out of scope, a basic injection, personal data, an empty or very long message, a switch of language, a deadline), all at no model cost; a static HTML report; publishing to npm; WebSocket targets; authentication (OAuth2 and the like); richer evidence mapping, which the first real target needed: one collection read from several paths, stock given only as in or out of stock, amounts quoted from data other than the shown products (such as an order history), and the text of an answer given only as a component; a Gemini protocol adapter (AI Studio and Vertex); model calls read from OpenTelemetry GenAI spans, for targets the proxy can't see; tool-call and trajectory checks on what the proxy records; a simulated customer: a model plays a customer with a goal, and the deterministic checks judge every turn; generic checks (patterns, JSON Schema, similarity, checks the user writes) | on the demo-shop and on the open-source target, `yokla init` writes a profile that needs no edit for the starter cases, which then run and gate; the demo-shop's tool-call defects detected; the simulated customer reaches each demo-shop purchase goal, and a run repeats from its seed; on the demo-shop, calls read from OpenTelemetry spans match the proxy's records |
| **0.4 — analyzer** | inventory, LLM extraction with evidence, probe mode, profile review and diff (the deterministic step done, ADR-0047; the extraction of the fields a quote can verify done, ADR-0049, ADR-0051; the response contract from a contract file done, ADR-0057, ADR-0058); e-commerce data generators (done, ADR-0055, ADR-0056); freshness and `fixture-missing` (done, ADR-0053, ADR-0054); robustness transforms of approved cases (§9): typos, removed diacritics, casing and punctuation at no model cost (done, ADR-0045), and paraphrase and Turkish–English code-switching only with a configured, budgeted model (done, ADR-0059) | on demo-shop the analyzer reproduces the approved entries of the hand-written profile (precision and recall reported); on the private target it rediscovers the known issue classes; on the demo-shop, a transform catches a seeded defect that shows only in a message without diacritics, and the transforms of every other approved case keep its verdict |
| **0.5 — red team** | local attack generation (templates plus attacker model), native TR and EN; e-commerce attacks: price and discount manipulation, order fraud, card data, age and region restrictions, unauthorised commitments, competitor steering, hijacking, excessive agency, another customer's data, injection through product content and through tool descriptions, including a description that changes mid-conversation, unsafe advice; canary-based deterministic detection; multi-turn and encoding strategies; findings mapped to OWASP LLM Top 10, OWASP Agentic, GDPR and KVKK, and the EU AI Act; calibrated judge | demo-shop injection, leakage and BOLA defects detected deterministically; the egress test passes |
| **0.6 — ecosystem** | import and export for other evaluation tools; CI recipes and a GitHub Action; a library API; two runs compared side by side; documentation site | |

### The debugging track: from a finding to a fix

A score tells a team that something is wrong. A team needs three more
answers: where the failure arose, the smallest conversation that shows it,
and whether a fix holds. yokla can answer them because it holds both
deterministic oracles and the model proxy's view of what the model was
given. This track runs alongside the versions above and doesn't renumber
them.

- **Order.** The items are built in order, because each one uses the ones
  before it.
- **Approval.** Each item starts with its own ADR. Being listed here doesn't
  approve it.
- **Exit criteria.** Each item is done when they hold on the demo-shop, at no
  model cost unless its ADR says otherwise.

| Item | Scope | Exit criteria |
|---|---|---|
| **D1. Where a failure arose** (done, ADR-0033) | a failing finding that names a value (a price, a duration, a phrase) says where the value first appears: in what the model was sent, in what the model answered, or only in the app's answer; worked out from the proxy's records at check time, never guessed; shown in every report | on the demo-shop, three seeded price defects, one from each origin, are each attributed to their own origin; without proxy data the origin is unknown, not a guess |
| **D2. The smallest failing conversation** (done, ADR-0035, ADR-0036) | `yokla shrink` cuts a failing case down to the fewest turns and the shortest messages that still fail the same check, with the samples needed to tell a real failure from chance; it writes the result as a proposed case | every demo-shop defect's failing case shrinks to a case that still fails only its own check; a flaky failure is reported as flaky, not shrunk |
| **D3. Sampling that stops when the verdict is settled** (done, ADR-0038, ADR-0039) | with `--stop-early`, a case stops its samples once no further sample can change its failure: a worst-of-N failure, a majority-of-N failure the remaining samples can't outvote, or an error; a passing case runs every sample | on the demo-shop, verdicts match fixed-N runs while fewer samples run; a worst-of-N failure stops after one sample, a majority-of-N one after two of three |
| **D4. Recorded model calls, replayed** (done, ADR-0040) | the proxy records the target's model calls into a cassette and can answer from it, so a run repeats with no model cost; a replay can change one recorded answer, to ask what the app does when the model says something else | a recorded demo-shop run replays with identical results and no upstream call; the resilience cases catch each resilience defect on a cassette; a changed answer's price is traced to the model; a changed prompt diverges from the cassette |
| **D5. yokla as a tool for coding agents** (done, ADR-0041) | a local MCP server over stdio: run a case, explain a finding (D1), shrink it (D2), verify a fix against the shrunk case and its neighbours; no egress beyond the run's own | an agent, given only the MCP tools, finds and verifies the fix of a seeded demo-shop defect: in CI a scripted client, at no model cost; once by hand, a real coding agent |
| **D6. Comparing models through the proxy** (done, ADR-0042) | the proxy can send a call to another model than the app asked for, as the command line says; the same cases run once per model, and a report compares verdicts, cost and latency | on the demo-shop, three fake models give the comparison expected of them; the cheapest model that still passes the gate is named |
| **D7. Tool results changed by the proxy** (done, ADR-0043) | the proxy can change a tool result before the model sees it: a canary instruction, for indirect injection without a test copy of the target's data; and changes that must not change the verdict, such as reordered items, for metamorphic checks | the demo-shop's injection defect (v0.5) is caught through a tool result the proxy changed; a metamorphic change gives the same verdicts |
| **D8. A search for untried paths** (done, ADR-0044) | a run that steers new turns towards what the proxy hasn't seen yet: routes, tool sets, argument shapes, fault states; deterministic mutations first, a model-written turn only when configured and budgeted | on the demo-shop, the search reaches every route and every tool, and finds a seeded defect that no written case reaches |

**Later:** sampling production logs, more domains (banking, travel), more
languages, SDK adapters.
- Other ways to reach a target: a chat widget driven in a browser, and
  voice. A widget usually sits on an HTTP or WebSocket API that yokla
  already reaches, so a browser is needed only when that API can't be
  called directly.
- More fault plans: a fault on a seeded share of a turn's calls, rather
  than on the calls a plan names, and a model answer too large for the app.

Checks that understand more of an answer:
- `price-grounded` grounding the price of a product an answer names but
  doesn't return, when the model didn't see it in a mapped tool result
  (ADR-0026), and differences and discounts (ADR-0022);
- text about one item, read with that item (ADR-0021).

## 21. Risks

| Risk | Mitigation |
|---|---|
| Wrong expectations (the oracle problem) | P1, provenance on every entry, human approval, judge calibration |
| The analyzer is unreliable across stacks | the profile is editable; black-box fallback; precision and recall measured on demo-shop |
| Scope too broad for a small team | exit criteria on every version; packs as the extension point; depth in one domain first |
| The proxy can't see some providers | they are declared `unobserved`; the app's OpenTelemetry spans or logs show their calls (ADR-0029, ADR-0009) |
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
5. ~~**HTML report.**~~ Decided in
   [ADR-0023](adr/0023-static-html-report.md): one static file, with no
   framework and no script.
6. **Contribution terms:** DCO or CLA. DCO is the usual choice for Apache-2.0
   projects.
7. **Turkish README:** maintain one alongside the English one?
