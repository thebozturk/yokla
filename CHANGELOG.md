# Changelog

Notable changes per version. Versions follow the roadmap in
[design §20](docs/design.md#20-roadmap); a version ships when its exit criteria
hold.

## 0.4.3 — 2026-11-20

The analyzer's model step reads what can answer its questions first.

### Changed

- **Files that name a field asked go first (ADR-0072, ADR-0073).** A
  file whose path or text names a rate limit, a cache bypass or a refusal,
  and every prompt, is sent before the rest, the shortest first, so a
  large repository's token budget reaches the code that sets the values.
  The estimate says how many of those files are sent and how many the
  budget leaves out.
- **`models.analyzer.maxTokens` defaults to 2000 (ADR-0072).** The
  customer and transform models keep 400.

### Fixed

- **A number written with digit separators passes its check (ADR-0074).**
  `2_000`, `2,000` and `2.000` hold 2000, read in groups of three with one
  separator.

## 0.4.2 — 2026-11-19

Documentation only. The README's diagrams are images, so the npm page
shows them; it showed them as Mermaid code in 0.4.1.

## 0.4.1 — 2026-11-19

v0.4 in full. The 0.4.0 release stopped halfway: seven packages were
published, but not `@yokla/analyzer`, a new name trusted publishing can't
publish first, nor the CLI, `yokla`, which comes last. 0.4.1 publishes
every package; what v0.4 adds is under 0.4.0 below.

### Added

- **Workflow guides and diagrams.** The README shows how a run works and
  the workflow from a proposed profile to the gate. The guide has three new
  pages: the analyzer, from a finding to its fix, and yokla in CI, with a
  GitHub Actions example.

### Fixed

- **A new package is found before a release starts (ADR-0071).** `pnpm
  pack-check --release` stops when a package's name isn't on the registry,
  and names the steps to reserve it.
- **A release that stopped halfway can run again (ADR-0071).** The release
  workflow skips a version already published with the same tarball, and
  stops at one published with another.

## 0.4.0 — 2026-11-19

Seven of its packages are on npm; `@yokla/analyzer` and the CLI were not
published (ADR-0071). Use 0.4.1.

The analyzer and the steps from a finding to its fix: `yokla analyze`
proposes a profile from a target's repository, data and a few probes;
`yokla generate` writes cases from the catalog; cases the data no longer
holds send nothing; recorded model calls replay at no cost; models compare
through the proxy, and tool results change before the model sees them;
robustness transforms, `yokla explore` and `yokla mcp`.

**Exit criteria.** v0.4 ships with one criterion partly met (ADR-0070).
- **On the demo-shop, the analyzer reproduces the approved entries of the
  hand-written profile,** with precision and recall reported (ADR-0047).
- **On the demo-shop, a transform catches a seeded defect that shows only
  in a message without diacritics, and every other approved case keeps its
  verdict** (ADR-0045); code-switching catches one too (ADR-0059).
- **On the private target, yokla rediscovers the known issue classes:
  partly.** Of four classes (design §19):
  - type absence vs price-band relaxation: rediscovered;
  - fabricated prices and direct prompt injection: not rediscovered, with
    every turn judged;
  - stale data-bound cases: waiting, as the target's data hasn't changed
    since 2026-11-10;
  - indirect injection through a tool result couldn't be tried: the target
    can't be pointed at the model proxy yet (ADR-0069).

  Its repository, analyzed with its catalog, gave a precision of 81.0 %
  and a recall of 34.7 %, with the model step too.

### Added

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
- **Tool results changed by the proxy (ADR-0043).** A case turn's
  `toolResults` inject text into a tool's results before the model sees
  them, and the new core check `injection-canary` fails a turn whose answer
  holds the canary. `yokla run --reverse-items` reverses arrays in a tool's
  results for a whole run, and `yokla compare --expect-same` exits with 1
  when a verdict moved.
- **A search for untried paths (ADR-0044).** `yokla explore` runs the written
  cases once, then conversations built from them: a fault on the last turn,
  the last turn again, another case's first turn, and turns a domain pack
  builds from the target's data. It keeps those that reach a new route, tool,
  argument shape or fault state, or fail a check, and writes them as proposed
  cases with the new provenance source `explore`. The results gain an
  additive `run.coverage`. The e-commerce catalog maps an optional product
  `name`, one field or one per language, which the pack's intents ask by.
- **Robustness transforms of a case's messages (ADR-0045).** `yokla run
  --transform` sends each written message without diacritics, in lower case,
  without punctuation, or with one typo seeded by case, sample and turn.
  Words with a digit, money amounts and the values the expectations quote
  stay as written, and each case keeps its definition, so `yokla compare
  --expect-same` and the gate set it beside the run as written. Language
  packs gain `lowerCase` and `removeDiacritics`; the results gain an
  additive `run.transforms` and a turn's `written`. `yokla compare` names a
  run by its tool changes and transforms too.
- **The analyzer, deterministic first (ADR-0047).** `yokla analyze` lists the
  target's repository, leaving yokla's own files and secrets out, and
  proposes what the target's data and up to three probes give: the
  e-commerce catalog and its fields, its type separator, the languages of its
  names and the policies' sources, and the response's text, route, session
  and product and cart evidence, found by matching the answers' values to
  the catalog's. The proposal goes to `yokla.profile.proposed.yaml` with a
  `provenance` map by JSON Pointer, and a profile with proposed entries
  doesn't run. Compared with a profile, it reports precision and recall; on
  the demo-shop, every entry it proposes is the hand-written one. A new
  package, `@yokla/analyzer`, makes nine. profile.v1 gains `provenance`,
  and `yokla schema analysis` prints the report's schema.
- **Intents that state what they ask, across the catalog's types
  (ADR-0046).** `yokla explore`'s opening turns spread over `--types`
  product types (6 by default), taken in turn from each branch of the type
  tree. For each, the e-commerce pack asks for a product by name, the type,
  the type under its median price, and the type under its lowest price,
  where nothing can match. A turn that asks for a type or a price bound
  carries it as its expectation, from the catalog, so
  `type-matched-or-disclosed` and `filter-honoured-or-disclosed` judge it;
  the proposed case keeps it and names where it came from. The results gain
  an additive `run.exploration.candidates`: every candidate that ran, kept
  or not, with its messages and routes.
- **Intents ask as a shopper names things (ADR-0048).** A type is asked by
  its words, so its expectation and prices cover every catalog type with the
  same words, and `--types` counts distinct words. Amounts are written in
  the language's usual unit ("300 TL", "$300"); one turn per language asks
  with the currency code, where shoppers write it otherwise.
- **A type asked by its catalog label (ADR-0050).** A profile may map
  `catalog.fields.typeLabel`, one field or one per language, to the words a
  shopper uses for a row's type. `yokla explore`'s opening turns then ask
  for a type by its most common label, as the catalog writes it, in place of
  its last level, which may be a facet such as a size. Types with the same
  label are one group, as types with the same words were (ADR-0048).
- **The currency-code turn where a dropped bound shows (ADR-0052).** `yokla
  explore`'s turn that writes an amount with the currency code asks at the
  first type's lower quartile price, not its median, so a target that drops
  the bound shows a product over it. A new demo-shop defect,
  `currency-code-ignored`, drops such a bound. Near types stay a finding:
  the profile's guide says to give them one catalog label.
- **"No exact match" counts as a disclosure.** The Turkish and English
  absence and alternative markers now hold "tam uyan ürün olmadığı", "en
  yakın seçenek", "no exact match", "closest option" and "closest match".
  An answer that offers the closest products with these words no longer
  reads as a silent relaxation; a price bound it doesn't name still fails.
- **The analyzer reads code and docs (ADR-0049).** With `models.analyzer`,
  `yokla analyze` sends the docs, prompts and code, never data, environment
  or test files, in chunks to that model, under `--max-tokens` and a
  required `--max-cost`, with an estimate first and `--estimate` to send
  nothing. It proposes the rate limits, the cache bypass and the canonical
  refusals, each checked against the line it quotes; what fails is listed
  as unverified. Replies are cached, so a rerun is free. The report gains
  `model`, `unverified` and `conflicts`.
- **Replies the analyzer couldn't read are named (ADR-0051).** A reply cut
  at `maxTokens`, as OpenAI-compatible, Anthropic and Gemini report it, or
  not the JSON asked for, gives no value; the summary and `model.unread`
  name its chunk, and it is never cached. `maxTokens` leaves the cache key,
  so raising it asks only the cut chunks anew. Tokens are counted as one per
  two characters, not four. yokla's own models take a `maxTokens` up to
  64,000, up from 4,000: a model that reasons spends output tokens on it.
- **Cases the data no longer holds are `fixture-missing` (ADR-0053,
  ADR-0054).** Before a case runs, the domain pack checks the facts its
  expectations state: for the e-commerce pack, that an `absentType` is in no
  product's type, at any level, and that a `productType` is still in the
  catalog. A case with an unmet fact sends nothing; its result names the
  facts in `fixture`, and `yokla run` and the gate exit with `2`. Results
  gain `run.data`: each file the packs read, with its hash, rows and
  modification time.
- **`yokla generate` writes cases from the catalog (ADR-0055, ADR-0056).**
  Before anything is sent, the e-commerce pack writes proposed cases, source
  `generator`, of eight kinds in each language: `lookup`, `absent-type`
  (from `--absent`, each word checked absent), `empty-band`, `attribute`,
  `comparison`, `refine`, `cheaper` and `unknown-stock`. The profile gains
  `ecommerce.catalog.fields.attributes`. A product id a turn expects is a
  catalog fact, so a lookup of a product that left the catalog is
  `fixture-missing`. The demo-shop shows the products a message names first.
- **The analyzer reads the response contract from a contract file
  (ADR-0057, ADR-0058).** From an OpenAPI 3 operation or a JSON Schema
  document, `yokla analyze` proposes `target.response.schema` at the
  deepest object the answer's text and evidence share, only when every
  probe answer matches it; a contract the target breaks is named by path
  and keyword. The report gains `contracts`. The demo-shop gains
  `openapi.json`, and its analysis rises to recall 71.0 % without a model.
- **Paraphrase and code-switching, written by a model (ADR-0059).**
  `yokla run --transform paraphrase` and `code-switch` ask `models.transform`
  for one rewrite per message before the first request. A rewrite that
  loses a text no transform changes is not sent, and the run's issues say
  why. The run prints an estimate first, `--max-cost` is required while a
  rewrite isn't cached, and the cache makes a rerun free. The demo-shop
  gains a `language-by-words` defect that only code-switching shows.
- **A rewrite adds nothing, and keeps its language (ADR-0060).** The prompt
  asks for the same requests and facts, nothing added or dropped, and a
  code-switch that keeps the case's language. A rewrite with more sentences
  than the message, or a code-switch whose mixed-in language's common
  words outnumber its own, is not sent.
- **Negated stock wording, and products the answer only names (ADR-0061).**
  `stock-claim` reads listed negated forms ("stokta değil", "isn't in
  stock") as out-of-stock claims, and an English negation before a claim
  phrase cancels it. With a catalog snapshot, a claim binds to a catalog
  product the answer names by its full name only.
- **Generated cases name products in stock (ADR-0062).** `lookup`,
  `comparison`, `cheaper` and `attribute` name a product in stock, and a
  case's basis gives the stock it was named by.
- **A generated name names one product (ADR-0063).** A named product's name
  is held by no other product in the case's language. `cheaper` names a
  product with a cheaper one in stock of its type, and its second turn
  expects a product shown.
- **A cheaper follow-up says cheaper than what (ADR-0064).** The second
  turn asks for something cheaper than the product asked about first.
- **Data from outside the repository (ADR-0065).** `yokla analyze --data
  <file>`, repeatable, gives a data file such as a database export. The
  comparison also gives precision and recall without
  `target.response.schema`.
- **A large catalog read whole, and a contract that is a schema
  (ADR-0066).** Data files are read up to 1,000,000 rows, and a file cut
  there is named. A file is a JSON Schema contract only when its `$schema`
  is on `json-schema.org`.
- **An evidence field read as a number, or from a fallback (ADR-0067).**
  The probes' match proposes `{ from: <path>, as: number }` for a value
  sent as a decimal string, and `{ from: [a, b] }` when an answer shows
  `a` null and `b` holding the value.
- **An evidence field left undecided names its candidates (ADR-0068).** A
  field the match fits two or more ways gets no path, and the summary and
  the report's additive `undecided` name the ways, for the person to pick.
- **The model proxy reads an AI SDK gateway (ADR-0069).** A new upstream
  kind, `ai-gateway`, reads the AI SDK's gateway protocol: model, tokens,
  prompts, tools, tool calls and tool results; faults, model swaps and
  tool result changes apply. profile.v1's upstream kind gains the value.

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
