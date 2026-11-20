# Commands, configuration and the gate

Run each command as `npx yokla <command>`, or from a checkout of the
repository as `pnpm yokla <command>`. `yokla <command> --help` prints its
options. For a task from start to end, see the workflows:
[the analyzer](analyzer.md), [from a finding to its fix](debugging.md) and
[yokla in CI](ci.md).

| Command | Does |
|---|---|
| `init` | Writes a first profile and starter cases from one message to the target. |
| `analyze` | Proposes a profile from the target's repository, its data and up to three probes. |
| `generate` | Writes cases from the profile's data, as proposed cases. |
| `run` | Runs cases against the profile's target and writes a results file. |
| `report` | Prints the summary of a results file, and optionally writes JUnit XML or an HTML report. |
| `gate` | Judges a results file against thresholds and a baseline. |
| `baseline` | Accepts a run as the baseline. |
| `proxy` | Runs the model proxy until stopped. |
| `plan` | Estimates the cost of a run from an earlier one. |
| `shrink` | Cuts a failing case down to the smallest that still fails. |
| `mcp` | Serves yokla's tools to a coding agent over stdio. |
| `compare` | Sets runs side by side and names the cheapest that passes. |
| `explore` | Searches for paths the written cases never take, and proposes cases for them. |
| `schema <name>` | Prints a JSON Schema: `profile`, `cases`, `config`, `results`, `baseline`, `comparison` or `analysis`. |

## `yokla init`

```sh
pnpm yokla init --url <url> [--body <json>] [--header 'name: value']... \
  [--session-url <url>] [--text <jsonpath>] [--language tr|en]... [--dir <path>] [--force]
```

| Option | Default | Meaning |
|---|---|---|
| `--url <url>` | | The target's chat endpoint. Required. |
| `--body <json>` | `{"message": "{{message}}"}` | The request body, with the profile's placeholders. |
| `--header <name: value>` | | A request header; repeatable. Values may use `{{env.NAME}}`. |
| `--session-url <url>` | | A request that opens the target's session, a path or a URL. Its id goes to every turn as `{{carry.session}}`. |
| `--text <jsonpath>` | | Where the answer text is, for a JSON answer, when init doesn't find it. |
| `--language <tr\|en>` | `en` | A language of the profile; repeatable. The probe is written in the first. |
| `--dir <path>` | `.` | Where to write the files. |
| `--force` | | Overwrite existing files. |

It sends the target one message, and one more with `--session-url`, and
contacts nothing else. yokla makes no model call; the target may make its
own. It writes `yokla.profile.yaml`, `cases/starter.yaml` (proposed cases)
and the `.gitignore` entries, after loading both files as `yokla run` would.
It exits with `0` when the files were written, and with `2` when the probe
failed, the answer couldn't be read, a file exists without `--force`, or an
option is wrong. Then nothing is written. See ADR-0018.

It probes HTTP targets only. For a WebSocket target it exits with `2`: write
the profile by hand (see
[WebSocket targets](profile.md#websocket-targets), ADR-0024).

## `yokla analyze`

```sh
pnpm yokla analyze --dir . --url http://127.0.0.1:3000/v1/chat \
  --body '{"message": "{{message}}", "sessionId": "{{session}}"}' \
  [--header <name: value>]... [--session-url <url>] [--language <tr|en>]... \
  [--out yokla.profile.proposed.yaml] [--profile yokla.profile.yaml] \
  [--json analysis.json] [--max-files 5000] [--data <file>]... [--force]
```

Proposes a profile from the target's repository, its data and up to three
probes, for a person to review (ADR-0047). yokla makes no model call; the
target may make its own, and the analyzer contacts only its urls.

| Option | Default | Meaning |
|---|---|---|
| `--dir <path>` | `.` | The target's repository. |
| `--url`, `--body`, `--header`, `--session-url` | | The request, as for [`yokla init`](#yokla-init). `--url` is required. |
| `--language <tr\|en>` | those of the catalog's names, else `en` | A language of the profile; repeatable. The probes are written in the first. |
| `--out <file>` | `<dir>/yokla.profile.proposed.yaml` | Where to write the proposal. Data paths in it are relative to it. |
| `--profile <file>` | `<dir>/yokla.profile.yaml`, when present | A profile to compare the proposal with. |
| `--json <file>` | | Also write the analysis report, by the schema `yokla schema analysis` prints. |
| `--max-files <n>` | 5000 | List at most this many files. |
| `--data <file>` | | A data file from outside the repository, such as a catalog exported from a database; repeatable. It is read as the repository's data files are, and its path in the proposal is relative to it (ADR-0065). |
| `--force` | | Overwrite the proposal. |

**What it does, in order:**
1. **The inventory.** It lists the repository's files and sorts each into a
   kind: `data`, `contract`, `prompt`, `doc`, `env-example`, `manifest`,
   `code` or `other`. It doesn't enter hidden, dependency or build folders,
   and leaves out binary files, files over 5 MB, environment files that may
   hold secrets, and yokla's own files: profiles, the configuration, the
   baseline, case files, `runs/` and `yokla-data/`. A `contract` is an
   OpenAPI document, or a JSON Schema whose `$schema` is on
   `json-schema.org`; a settings file that names the schema it follows is
   not one (ADR-0066).
2. **The data.** The domain pack reads the data files. The e-commerce pack
   proposes the catalog (a JSON Lines file with a unique id-like column and
   a positive price-like one) and its fields, its type separator, the
   languages of its names, and for each policy topic a FAQ in JSON Lines
   (rows with `topic` and `answer`) or `{ source: none }`. A data file is
   read up to 1,000,000 rows; one cut there is named before anything is
   sent, since the probes' match may then miss a product they show
   (ADR-0066).
3. **The probes.** It prints the messages, then sends a greeting, read by
   `yokla init`'s rules for the answer's text, route and session. With a
   catalog, it then asks for a type and puts the first product shown in the
   cart, in the same session. Where the products and the cart are in the
   answers is found by matching their values to the catalog's. A value sent
   as a decimal string is matched as a number and proposed with
   `as: number`; one that a path holds in some products and another path
   in the rest is proposed as a fallback, `from: [first, second]`, when an
   answer shows both. Two paths that fit equally give no path (ADR-0067):
   the summary names them on an `undecided:` line, and the report under
   `undecided`, for you to pick one (ADR-0068).

**The proposal** is a profile with a [`provenance`](profile.md#provenance)
map at its top: each machine-made entry with its source, its evidence and
the status `proposed`. The request you gave is written as given. Until you
approve its entries, `yokla run` and the other commands that reach the target
refuse it.

**The comparison.** With a profile to compare with, it sorts each entry, a
scalar or a list of scalars by its pointer, into `same`, `different`, `new`
(not in the profile) or `missed` (in the profile, not proposed), and prints
the precision, same ÷ (same + different + new), and the recall, same ÷
(same + different + missed). Your own inputs, the request and the
languages you named, are left out, and so are the profile's entries that
aren't approved. On the demo-shop it proposes 49 entries, all the
hand-written ones: 30 from the data and the probes, and the 19 of the
response contract from `openapi.json`. Precision 100 %, recall 71.0 %.

A response contract counts leaf by leaf, so when either side has one, a
second line gives the precision and the recall without
`target.response.schema` (ADR-0065): on the demo-shop, 100 % and 60.0 %.

**The response contract (ADR-0057).** From the repository's contract files,
it proposes `target.response.schema`, with no model:
- **What it reads:** from an OpenAPI 3 document, the operation your request
  calls, after any path its `servers` hold, and its lowest 2xx JSON response;
  from a JSON Schema document, the whole of it. Swagger 2 is left out.
- **What it makes of it:** references move into `$defs`, OpenAPI 3.0's
  `nullable` becomes a `null` type, and `example` and `x-` extensions are
  left out and listed. A schema `json-schema` can't check is not proposed.
- **Where it applies:** at the deepest object your answer's text and its
  evidence collections share, such as `$.data`, else at `$`.
- **Verified first:** every probe answer must match it. A contract your
  target doesn't keep is not proposed, and the summary names each violation
  by its path and keyword, never a value.
- **One contract:** the first verified, OpenAPI documents before JSON
  Schemas, each by path. The report's `contracts` says what became of each
  file.

**With a model (ADR-0049).** With `models.analyzer` in the configuration, a
model also reads the docs, prompts, contracts, manifests, env examples and
code for three things each project writes its own way: the rate limits, the
cache bypass header and the canonical refusals. Files that name one of them
go first (ADR-0072): a rate limit, throttling, `retry-after` or `429`; a
cache with `bypass`, `no-cache` or `no-store`; a refusal, or any prompt.
Among those, the shortest goes first, so no large doc spends the budget
alone (ADR-0073); the rest follow in the order above.

| Option | Default | Meaning |
|---|---|---|
| `--config <file>` | `yokla.config.yaml`, when present | Where `models.analyzer` is. |
| `--max-cost <usd>` | | Send no further chunk once the step's spend reaches this. Required with `models.analyzer`. |
| `--max-tokens <n>` | 200000 | The most input tokens the model reads; files beyond it aren't sent, and the summary names them. |
| `--chunk-tokens <n>` | 8000 | The most tokens in one call. A file larger than that is cut at line breaks. |
| `--estimate` | | Print the files and the estimate, and send nothing: no probe, no model call. |
| `--fresh-model` | | Ask the model anew, whatever its reply cache holds. |

Tokens are counted as one per two characters (ADR-0051): code takes about
one per 2.5, so the estimate stays above most code's count.

- **What it never reads:** data files, whose rows may hold personal data,
  environment files, and test files: paths in a `test`, `tests` or
  `__tests__` folder, or named like `*.test.*`, `*.spec.*`, `*_test.*` or
  `test_*.py`.
- **Before the first call** it prints the files it sends, the chunks and
  their input tokens, the most output tokens, the estimated cost and twice
  that as the upper bound, and the model's url, where the files' text goes.
  It also says how many marked files are sent and how many the budget
  leaves out. Run with `--estimate` first, and approve that figure.
- **Every value is checked** against the line it quotes: the file and line
  were sent, the quote is on that line or within two lines of it, and the
  value stands alone in the quote. A number may be written with digit
  separators between groups of three, such as `2_000`, `2,000` or `2.000`
  (ADR-0074). What fails is listed as unverified, with
  why, and never proposed. A limit or a cache bypass found with two values is
  a conflict, and neither is proposed; refusals gather into their language's
  list.
- **The provenance** names the file's kind as the source (`doc`, `prompt`,
  `contract`, or `code` for code, manifests and env examples), and the file,
  line and quote as the evidence.
- **A reply it can't read is named (ADR-0051).** A reply that stopped at the
  model's `maxTokens`, or isn't the JSON asked for, gives no value. The
  summary names its chunk's files and why, and, for a cut one, that
  `models.analyzer.maxTokens` is the setting to raise. Its cost counts.
- **Replies are cached** in `yokla-data/analyzer/` next to the proposal, so a
  rerun on unchanged files costs nothing and writes the same file. Only a
  reply that was read is cached, and `maxTokens` isn't in the key: raising
  it asks only the cut chunks anew.
- **The report** adds `model` (calls, cached, tokens, cost, the files sent
  and left, the unread chunks), `unverified` and `conflicts`.

On the demo-shop, with the fake provider playing the model, it adds the two
limits, the cache bypass and the two canonical refusals: 56 entries, all the
hand-written ones, recall 81.2 %. The limit the fake model invents is
dropped as unverified.

It exits with `0` when the proposal was written, and with `2` for a wrong
option, a probe that failed, or a proposal that exists without `--force`.

## `yokla run`

| Option | Default | Meaning |
|---|---|---|
| `--profile <file>` | `yokla.profile.yaml` | The profile. |
| `--cases <path>` | `cases`, next to the profile | A case file or directory; repeatable. |
| `--tag <tag>` | | Run only the cases with this tag; repeatable, a case runs when it has any of them (ADR-0077). No case left is a configuration problem. |
| `--out <file>` | `runs/<run id>.json` | Where to write the results. |
| `--samples <n>` | 1 | Samples per case, when the case doesn't say. |
| `--stop-early` | | Stop a case's samples once no further sample can change its failure (ADR-0038). Not with target logs or spans. |
| `--record <file>` | | Write the run's model calls to a cassette, their answers in full (ADR-0040). Needs a model proxy with upstreams. |
| `--replay <file>` | | Answer the model calls from a cassette, forwarding none to a provider (ADR-0040). Not with `--record`. |
| `--replay-loose` | | With `--replay`, answer a call the cassette has no match for with the recorded call at the same position. |
| `--reverse-items <tool>=<jsonpath>` | | Reverse the arrays the path selects in every result of a tool before the model sees it, through the model proxy (ADR-0043). Repeatable; not with a cassette. |
| `--swap-model <swap>` | | `<upstream>:<asked model>=<model>`: send the calls that ask for a model to another, through the model proxy (ADR-0042). `=<upstream>/<model>` sends them to another upstream of the same kind. Repeatable; not with a cassette. |
| `--transform <kind>` | | Send each written message as users write it: `no-diacritics`, `lowercase`, `no-punctuation` or `typos` (ADR-0045), or `paraphrase` or `code-switch`, which `models.transform` writes (ADR-0059). Repeatable. |
| `--concurrency <n>` | 1 | Cases run in parallel. Serial correlation needs 1, unless spans alone show the model calls. |
| `--target-url <url>` | the profile's | Use this url instead of `target.request.url`. |
| `--junit <file>` | | Also write a JUnit XML report. |
| `--html <file>` | | Also write an HTML report. It holds the target's answers. |
| `--config <file>` | `yokla.config.yaml`, when present | Prices, models, thresholds and check modules. |
| `--proxy-url <url>` | `127.0.0.1` on `modelProxy.port` | Where the model proxy is. |
| `--max-cost <usd>` | | Start no new sample once the model cost, the target's and yokla's own, reaches this. The target's cost comes from the model proxy, or from spans when the proxy has no upstreams. Without a model proxy it caps yokla's own calls alone, and says the target's cost is unknown. |
| `--fresh-customer` | | Ask the customer model anew, whatever its reply cache holds (ADR-0028). |

It exits with `0` when every case ran, whatever the verdicts: the gate judges
them. It exits with `2` for a configuration problem, when `target.auth` can't
get the run's first token, when a cassette can't be read, when a case ended
in `error`, or when a case is `fixture-missing`: the data no longer holds a
fact it states, and it sent nothing (ADR-0053).

**The summary** gives each status's count and the pass rate: passing cases
(`pass`, `gap-closed`) over passing and failing ones, with its 95 % Wilson
interval; `unmeasured`, `error`, `known-gap` and `fixture-missing` cases are
left out (ADR-0076). Once a case's weight isn't 1, a weighted rate follows,
and the failing cases are listed heaviest first. Each case that didn't
plainly pass shows its tags, and a `by tag:` block gives every tag's cases,
statuses and pass rate, the most failing first (ADR-0077). The results hold
the same rates in `summary`, over the run, per suite and per tag.

**`--tag`** runs part of the cases, such as a category you just fixed, in
seconds:

```sh
pnpm yokla run --tag support --tag orders
```

A gate on a tag-limited run compares only the cases it ran with the
baseline: one it left out passed before and isn't in this run, which the gate
notes and doesn't count as a regression. Run every case before a merge.

**`--stop-early`** judges each sample during the run, as the final judging
would, and stops a case's samples when:
- a deciding worst-of-N dimension failed;
- a deciding majority-of-N dimension can't pass any more, even if every
  remaining sample measures it and passes;
- a sample errored.

A passing case runs all its samples: a later one could still fail it. The
verdicts are the ones every sample would give, except that a sample that
would have errored after the failure was settled doesn't run. Latency,
cost, intervals and `unstable` come from the samples that ran. The summary
says how many samples ran of those planned, and a stopped case records
`samplesPlanned`. With target logs or spans, which arrive after the run, it
refuses to run.

**`--record` and `--replay`** repeat a run without calling the model again
(ADR-0040); the [model proxy guide](model-proxy.md#cassettes) says how.
- `--record runs/tents.cassette.json` writes every model call the proxy tied
  to a turn: the turn's key (case, sample and turn), the call's position, its
  upstream and path, the SHA-256 of its request, and the provider's answer in
  full. The results record `run.record`.
- `--replay runs/tents.cassette.json` sends the cassette to the proxy, which
  answers each call from it and forwards nothing. The results record
  `run.replay`, and each replayed call `replay`. A replayed call costs what it
  cost when it was recorded, for budgets, but the cost cap doesn't count it.
- **A call the cassette has no match for** gets a `502` from the proxy, and
  its turn is an `error`: the app asked something it didn't ask when the
  cassette was recorded. With `--replay-loose`, the recorded call at the
  same position answers it instead. Either way, the run's issues count such
  calls.
- A cassette recorded with another profile replays, and the issues say so.
- The gate judges a replayed run's latency thresholds as unmeasured: a
  replayed answer comes at once.
- **A cassette holds the provider's answers,** which may hold the target's
  data. Keep it out of version control, like the results file.

The results file (`results.v1`) holds every turn: the answer, the evidence,
the checks with their findings, timings, and the model calls with their cost.
Keep it out of version control when the answers may hold personal data.

**`--swap-model`** tries another model under the app's own cases, with the
app unchanged (ADR-0042); the [model proxy guide](model-proxy.md#model-swaps)
says how. Run the cases once per model, then set the runs side by side with
[`yokla compare`](#yokla-compare).

**`--transform`** asks whether the target understands users as they write
(ADR-0045). The run sends each written message of each case as the
transform changes it, and the verdicts should be those of the run as
written:

```sh
pnpm yokla run --out runs/written.json
pnpm yokla run --transform no-diacritics --out runs/no-diacritics.json
pnpm yokla compare --results runs/written.json --results runs/no-diacritics.json --expect-same
```

| Kind | What it does | Example |
|---|---|---|
| `no-diacritics` | each letter with a diacritic becomes its base letter, by the case's language pack | "Çadır önerir misin?" → "Cadir onerir misin?" |
| `lowercase` | the message in lower case, by the language's rules | "İADE" → "iade", "KIŞ" → "kış" |
| `no-punctuation` | each punctuation mark removed; a mark between two letters, but an apostrophe or a hyphen, leaves a space | "women's jackets?" → "womens jackets" |
| `typos` | one typo in one word of four letters or more, never at its first letter: two neighbouring letters swapped, one dropped or one doubled | "Siyah kadın mont" → "Siyha kadın mont" |

- **The same typo in every run.** It is drawn from the case id, the sample
  index and the turn index, as fault jitter is (ADR-0017). The samples of a
  case get different typos.
- **Several kinds** apply in the order of the table. One per run tells which
  one moved a verdict.
- **What no transform changes:**
  - a word that holds a digit, `@` or `/`, and a money amount with its
    currency, as the language pack finds it: "1.500 TL" stays;
  - a `notSentToModel` value, or a phrase of `answer.contains` or
    `answer.notContains`, wherever the message holds it, such as a canary
    the message asks the target to repeat;
  - the turn's expectations, faults, tool-result injections and request
    additions;
  - a simulated customer's messages, which the customer model writes. The
    run's issues count the cases left as they are.
- **The case keeps its definition** (ADR-0011), so `yokla compare` and the
  gate set it beside the case as written, and a case that passed in the
  baseline and fails under a transform is a regression.
- **The results** record `run.transforms`, with how many messages each kind
  changed; a kind that changed none is a run issue. A turn keeps the message
  sent as `user`, and the checks see it; `written` holds the message as the
  case wrote it, when a transform changed it. The HTML report shows both.
- **A cassette** records the run's transforms, and a replay with other
  transforms is refused before any request, since every call would diverge
  (ADR-0040).
- **Each transform is a run.** On a paid target, plan and cap it as any run.

**Written by a model (ADR-0059).** Two more kinds need `models.transform`
in the configuration:

| Kind | What the model writes | Example |
|---|---|---|
| `paraphrase` | the same request in other words, in the case's language, as another shopper would write it | "Çadır önerir misin?" → "Bana bir çadır tavsiye eder misiniz?" |
| `code-switch` | the same message with some words, such as product words, in the profile's other language | "Siyah kadın mont arıyorum" → "Siyah kadın jacket arıyorum" |

- **They apply first,** before the kinds above, and everything above holds
  for them.
- **One rewrite per message,** the same in every sample and every run, made
  before the first request.
- **Checked before it is sent:** a rewrite must keep exactly every text no
  transform changes, differ from the message, be one line and hold no more
  sentences than the message (ADR-0060); a code-switch must also keep its
  language, with no more common words of the mixed-in language than of its
  own, counted as `language-match` counts. The prompt asks for the same
  requests and facts, nothing added or dropped. A rewrite that fails a
  check is not sent: the message goes as written, and the run's issues say
  why, such as `"500 TL" was lost` or `the reply adds a sentence`.
- **`code-switch`** mixes in the first of the profile's languages that isn't
  the case's; with one language it leaves the messages as written.
- **Cost.** Before the first call, the run prints how many messages the
  model rewrites, how many the cache holds, the model's url and an upper
  bound. `--max-cost` is required while a rewrite isn't cached and the
  price isn't 0; it holds these calls with the customer's, and no proxy is
  needed for it. Once the spend reaches it, the messages left are sent as
  written. `run.own` counts the calls.
- **The cache** in `yokla-data/transform/` makes a rerun free, and sends the
  same messages. A rerun the cache answers whole needs no key: the key is
  read only when a rewrite isn't cached (ADR-0078).

## `yokla report`

```sh
pnpm yokla report --results runs/<run id>.json [--junit runs/junit.xml] [--html runs/report.html]
```

Prints the summary again from the results file alone, and optionally writes
JUnit XML or an HTML report.

- **The terminal summary and JUnit XML** hold one line per case that didn't
  pass, and none of the target's answers.
- **The HTML report** (ADR-0023) is one offline file to read why a case
  didn't pass.
  - It shows the run, the status of each case with its tags, the pass rate
    and, with weights, the weighted rate (ADR-0076), a By tag table, the most
    failing tag first (ADR-0077), how often each check applied, and every
    turn: the user's message, the answer, the findings, the mapped
    evidence and the model calls. Cases that didn't pass come first, open;
    with weights, the failing ones heaviest first.
  - It has no script and loads nothing, so it opens offline and contacts
    nobody. The answers are shown as text, never as markup or links.
  - A model call's prompt is shown by role and size only, whatever the
    results keep.
  - It holds the target's answers and evidence, so it is target data like the
    results file. Keep it out of version control when the answers may hold
    personal data.

## The configuration file

`yokla.config.yaml` holds what judges a run, as opposed to what reaches the
target. The [JSON Schema](../../packages/cli/schemas/config.v1.schema.json)
gives every field.

```yaml
version: 1
gate:
  maxFailures: 0
  latencyP95Ms: 8000
  suites:
    perf: { latencyP50Ms: 2000, latencyP95Ms: 4000 }
    resilience: { allowUnmeasured: true }
prices:
  openai:
    gpt-x: { input: 0.10, output: 0.50 }
models:
  customer:
    kind: openai-compatible           # or anthropic, or gemini
    url: http://127.0.0.1:11434/v1    # a local model keeps the conversation on the machine
    model: qwen2.5:7b
    apiKeyEnv: CUSTOMER_API_KEY       # optional
    price: { input: 0.15, output: 0.6 }
checks:
  - ./checks/no-internal-ids.ts
plan:
  upperBoundFactor: 2
```

- **`gate`:** the thresholds below, for every suite or per suite.
- **`prices`:** per upstream id and model, in USD per million tokens (see the
  [model proxy](model-proxy.md#prices-and-cost)).
- **`models.customer`:** the model that plays a simulated customer
  (ADR-0028).
  - **What it is:** OpenAI-compatible, whose url ends in the path before
    `/chat/completions`; Anthropic, whose url ends before `/messages`; or
    Gemini's native API (ADR-0032), whose url ends before `/models`, such as
    `https://generativelanguage.googleapis.com/v1beta`, or for Vertex AI
    `https://aiplatform.googleapis.com/v1/projects/P/locations/global/publishers/google`.
  - **How yokla calls it:**
    - directly, never through the model proxy;
    - at `temperature` 0, with at most `maxTokens` (400);
    - with the sample's seed where the provider takes one.
  - **Its key** is read from `apiKeyEnv`. For Gemini it goes in
    `x-goog-api-key`, or with `auth: bearer` as a bearer token, as Vertex AI
    takes it. The run checks it before the first case, even when every
    reply is cached: whether one is depends on the target's answers
    (ADR-0078).
  - **Gemini's thinking** counts as output, and a thought summary isn't the
    customer's message.
  - **Without a `price`,** its calls have no cost, never 0.
  - **Privacy:** a hosted model receives the conversation, the target's
    answers included.
- **`models.analyzer`:** the model `yokla analyze` asks for values in the
  target's docs, prompts and code (ADR-0049), in the same kinds as
  `models.customer`. Its `maxTokens` is 2,000 by default (ADR-0072), the
  others' 400. Raise it to what its replies fit in, such as 8000: a model
  that reasons spends output tokens on it, counted against
  `maxTokens` and billed as output (ADR-0051). Give it a `price` too, 0 for
  a local model: without one, `--max-cost` couldn't be kept, and
  `yokla analyze` refuses to run it. A hosted model receives those files'
  text. `maxTokens` goes up to 64,000 for any of yokla's own models.
- **`models.transform`:** the model that writes `yokla run --transform
  paraphrase` and `code-switch` (ADR-0059), in the same kinds as
  `models.customer`, with a `price`, 0 for a local model. A hosted model
  receives the cases' messages.
- **`checks`:** check modules you wrote, relative to this file (ADR-0030).
  `yokla run` loads them, and refuses one outside the contract before any
  request. See [checks you write](checks.md#checks-you-write-adr-0030).
- **`plan.upperBoundFactor`:** what `yokla plan` multiplies its estimate by.

### Gate thresholds

| Threshold | Default | Breaks the gate when |
|---|---|---|
| `maxFailures` | 0 | The suite has more `fail` cases. |
| `allowUnmeasured` | `false` | The suite has an `unmeasured` case or threshold, unless this is `true`. |
| `latencyP50Ms`, `latencyP95Ms` | | The median or 95th percentile latency of the suite's answered turns, every sample included, is higher. |
| `costPerTurnUsd` | | The mean model cost of an answered turn is higher. |
| `costUsd` | | The suite's total model cost is higher. |

A threshold without data is unmeasured: no answered turn for latency, or a
turn without a cost. Values under `gate.suites.<suite>` override the
gate-wide ones for that suite.

## `yokla gate`

```sh
pnpm yokla gate --results runs/<run id>.json [--baseline yokla.baseline.json] [--config yokla.config.yaml]
```

| Exit code | Meaning |
|---|---|
| `0` | The gate passed. |
| `1` | The gate is broken: a threshold was breached, or a case that passes in the baseline fails now. |
| `2` | The run can't be judged: it is partial, a case ended in `error`, or a file couldn't be read. |

- **Baseline comparison:** a case is compared only while its definition is
  unchanged (ADR-0011).
- **Notices:** the gate also notes a `gap-closed` case, whose `knownGap`
  marker can go, and a baseline made with another profile.

## `yokla baseline`

```sh
pnpm yokla baseline --results runs/<run id>.json [--out yokla.baseline.json] [--dry-run]
```

Writes `yokla.baseline.json` from a run, and shows what changed from the
previous baseline. The file is small enough to commit. It refuses a run the
gate can't judge. `--dry-run` shows the changes without writing.

## `yokla proxy`

```sh
pnpm yokla proxy --profile yokla.profile.yaml [--port <n>] [--records <file>]
```

- **What it runs:** the model proxy from the profile's `modelProxy`, on
  `127.0.0.1` only, until Ctrl-C.
- **`--port`:** overrides `modelProxy.port`; `0` picks a free port.
- **`--records`:** appends each recorded call to a JSON Lines file, with
  prompts kept as `modelProxy.prompts.store` says.
- **Spans:** with `modelProxy.spans`, it prints the OTLP/HTTP endpoint for the
  app's exporter, `/_yokla/otlp/v1/traces` (ADR-0029).
- **Exit code `2`:** for a profile without `modelProxy`, a bad port or a port
  in use.

See the [model proxy guide](model-proxy.md).

## `yokla plan`

```sh
pnpm yokla plan --cases cases --calibration runs/<run id>.json [--samples <n>] [--config yokla.config.yaml]
```

- **What it estimates:** what running the cases would cost, from a
  calibration run made with the model proxy, or with spans. It contacts
  nothing.
- **What it prints:** the estimate, an upper bound, and how many cases had
  their own calibration.
- **Exit code `2`:** when the calibration can't support an estimate. It then
  says what is missing and gives no figure.
- **Simulated customers** (ADR-0028) have no fixed turns. A sample costs what
  one cost in the case's own calibration, the customer's calls included.
  Without that calibration, the plan gives no figure.

## `yokla shrink`

```sh
pnpm yokla shrink --results runs/<run id>.json --case <id> [--check <id>] [--words] \
  [--samples 3] [--reproduce 5] [--max-runs 64] [--max-cost <usd>] [--calibration <file>] [--out <file>]
```

It cuts a failing case down to the fewest turns that still fail the same way,
and writes the result as a proposed case (ADR-0035). It takes the profile,
cases, configuration and target options of `yokla run`.

**The failure it keeps.** The failing finding of `--check`, or else the first
failing finding of a deciding dimension. A candidate still fails when, in
every one of its samples:
- the same check fails on the same turn, in the same dimension, with the same
  origin (ADR-0033);
- no other check fails on that turn that didn't fail there before.

**Reproducing first.** The original runs `--reproduce` times.
- Every run fails: shrinking starts.
- Some runs fail: the failure is **flaky**. shrink prints the failure rate and
  its interval, writes nothing, and exits with `1`.
- No run fails: it says the failure didn't reproduce, and exits with `1`.

**How it shrinks.** Turns after the failing turn are dropped, and earlier
turns are removed by delta debugging. Each candidate runs `--samples` times
and must fail every time. The search is deterministic.

**Whole messages by default.** Each kept turn keeps its message and its
expectations as written (ADR-0036). `--words` also cuts messages to their
fewest words. A cut message can stop asking what its turn's expectations
describe: "Siyah kadın mont arıyorum" cut to "mont" still fails a filter
check, but no longer asks for the filters. shrink says so before the search,
and the case file names each cut turn in its header comment.

**Budget.** Before it sends anything, it prints the most runs it can make,
`reproduce + max-runs × samples`, and with `--calibration`, their estimated
cost and upper bound. `--max-runs` caps the candidates, and `--max-cost` the
model cost. At a cap it keeps the smallest failing case found so far, and
says it stopped early.

**What it writes.** A case file, by default `<case id>.min.yaml` next to the
original case's file. It never overwrites a file.
- The case's id is `<case id>-min`, and its status is `proposed`, with the
  provenance source `shrink`. It runs, but gates only once a person approves
  it (ADR-0004).
- The terminal shows turns and characters before and after, each kept
  message, the runs made and their cost.
- A case that can't get smaller is reported as already as small as it gets,
  and nothing is written.

**What it refuses.** A case that isn't `fail` in the results, a case whose
definition changed since that run, and a simulated customer's case
(ADR-0028), whose turns a model writes. Each exits with `2` before any
request.

## `yokla mcp`

```sh
pnpm yokla mcp --profile yokla.profile.yaml --cases cases --max-cost 2 \
  [--config <file>] [--target-url <url>] [--proxy-url <url>] [--out runs] \
  [--replay <cassette> [--replay-loose]]
```

Serves yokla's tools to a coding agent over stdio, in the Model Context
Protocol (ADR-0041). The agent starts it as a local tool server; for
example, in an MCP client's configuration:

```json
{
  "mcpServers": {
    "yokla": {
      "command": "npx",
      "args": ["yokla", "mcp", "--profile", "yokla.profile.yaml", "--max-cost", "2"]
    }
  }
}
```

**The tools.**

| Tool | Does | Costs |
|---|---|---|
| `list_cases` | Lists the cases: id, suite, title, language, turns and review status. | nothing |
| `run_cases` | Runs the cases named, or every case, as `yokla run` does. Returns the run id, the statuses, the proposed cases' statuses apart, and each case that didn't pass with its failing findings: check, dimension, message, subject and origin. | model calls |
| `explain_finding` | Shows one case of a run, turn by turn: the user's message, the answer with the evidence the profile maps from it, the failing findings with their origin, and the turn's model calls. | nothing |
| `shrink_case` | Shrinks a failing case of a run, as `yokla shrink` does, and writes `<id>-min` in a new file next to it, as a proposed case. Returns how many of the reproduction runs failed and how many candidates ran. | model calls |
| `verify_fix` | Runs a failing case of a run again, with its `<id>-min` case when there is one, and the other cases of its suite. See below. | model calls |

**What `verify_fix` returns.**
- `fixed`: neither the case nor its `<id>-min` case still fails the target
  check, none of them errored, and the session's cap didn't cut the run
  short (`partial`).
- `ran`: every case it ran, with its status in the run given and now.
- `regressions`: each case that passed in the run given and doesn't now.
- `changed`: cases whose definition changed since that run; they aren't
  compared.
- `otherNotPassing`: cases of other suites that didn't pass in the run
  given. `verify_fix` doesn't run them, so `fixed` says nothing about them;
  `run_cases` checks them.

**What the person fixes at start.** The profile, the case paths, the
configuration and the target and proxy urls. No tool takes a path, a url
or a profile, so an agent chooses which cases to run, never which target
or which files to read.
- Each tool call loads the files again, as a command would: a case the
  agent edited counts at the next call, and so does a case `shrink_case`
  wrote.
- Calls run one at a time, since the model proxy holds one recording at a
  time.
- Every run writes its results under `--out`, and the tools return its run
  id. The other tools take that id.
- stdout carries protocol messages only; what yokla would print goes to
  stderr.

**Cost.** A session that can spend needs `--max-cost`: one whose profile
has a model proxy with upstreams or spans, or whose configuration has a
customer model. Without it, `yokla mcp` refuses to start.
- The cap covers every run of the session. Each run gets what is left as
  its own cap, and each paid tool says what it spent and what is left.
- Once it is spent, the paid tools refuse, and `list_cases` and
  `explain_finding` keep working. Start the server again to raise it.
- Without a model proxy, the target's cost can't be counted; each paid
  tool says so.
- With `--replay`, every run answers its model calls from a cassette
  (ADR-0040), at no model cost. `shrink_case` then refuses: a candidate's
  turns and samples aren't the recorded ones.

**What the agent sees.** Tool results hold the target's answers, cut at
4,000 characters, and the evidence mapped from them, 20 items per
collection, and the agent may send them to a hosted model. That is
your choice, as a hosted customer model is (ADR-0028). Prompts and the
model's answers appear only as far as the profile's `prompts.store` keeps
them in the results.

It exits with `0` when the client closes stdin, and with `2` for a
configuration problem, such as a missing `--max-cost`.

## `yokla compare`

```sh
pnpm yokla run --out runs/as-is.json
pnpm yokla run --swap-model openai:gpt-big=gpt-mini --out runs/mini.json
pnpm yokla compare --results runs/as-is.json --results runs/mini.json \
  [--config yokla.config.yaml] [--baseline yokla.baseline.json] [--json runs/compare.json]
```

Sets runs of the same cases side by side, such as one run per model that
`--swap-model` tried, and names the cheapest run that passes the gate
(ADR-0042). It reads results files and contacts nothing.
- **Each run** is named by what it changed: its swaps, its tool changes
  (`reversed: …`) and its transforms (`transforms: …`), or "as the app asks"
  for none. It shows the
  gate's verdict with the configuration's thresholds and the baseline, as
  `yokla gate` gives it; its statuses; its model cost and the mean cost of an
  answered turn; and the latency p50 and p95 of its answered turns.
- **The cases whose status differs** come first, a status per run. A case
  whose definition differs between runs is shown, not compared; one a run
  lacks shows as missing.
- **The cheapest run that passes the gate** is named by its total cost.
  None is named when no run passes, or when a passing run's cost isn't
  known.
- `--json` writes the comparison, by the schema `yokla schema comparison`
  prints.
- **`--expect-same`** exits with `1` when a case's status differs between
  the runs, as after a change that mustn't move a verdict, such as
  `--reverse-items` (ADR-0043) or `--transform` (ADR-0045). A case whose
  definition differs isn't counted.

It exits with `0` when it compared the runs, whatever their verdicts; with
`1` under `--expect-same` when a status moved; and with `2` when a file can't
be read or fewer than two runs are given.

## `yokla explore`

```sh
pnpm yokla explore [--max-runs 64] [--types 6] [--max-cost <usd>] \
  [--out explored.yaml] [--results runs/<run id>.json]
```

Searches for paths the written cases never take, and writes the
conversations that reach one as proposed cases (ADR-0044). It takes the
profile, cases, configuration and target options of `yokla run`.

**Coverage.** What the runs reached:
- the routes the target answered on, by the profile's `response.route`;
- through the model proxy, the tools the model asked for;
- each tool's argument shape: the tool with the sorted keys of its
  arguments, nested ones as dotted paths, such as
  `search_products{filters.priceMax,language,productType}`;
- the fault states: a route the target answered on under a fault kind.

Without a model proxy, only routes count, and explore says so. Without a
mapped route, it refuses.

**The search.**
- The written cases run first, once each, with one sample. What they reach is
  the coverage to beat.
- Then candidates run one at a time, each a small conversation of one sample.
  A candidate is kept when it reaches something no run before it did, or when
  a check fails on its last turn. Kept candidates join the pool, and the
  search goes on from them.
- The candidates, in this order:
  - **the domain pack's opening turns** (ADR-0046): the e-commerce pack
    takes up to `--types` product types (6 by default), in turn from each
    branch of the type tree: the first level below the levels all types
    share, branches by name, and in each the types with most products first.
    For each type it asks for a product by its name (one in stock first),
    for the type, for the type under its median price, and for the type
    under the largest whole amount below its lowest price, where nothing can
    match. Then it asks about each policy the profile declares. A type is
    asked by the words of its last level, or by its catalog label where the
    profile maps `catalog.fields.typeLabel` (ADR-0050), and types with the
    same words are one to a shopper: they count once, and the turn's
    expectation and prices cover them all (ADR-0048). Amounts are written as shoppers of the
    language write them, such as `300 TL` or `$300`; one last turn per
    language asks the first type with the currency code, such as `300 TRY`,
    where that differs, at its lower quartile price, so that a target that
    drops the bound shows a product over it (ADR-0052);
  - **the pack's turns after an answer that showed products:** adding the
    first of them to the cart, then the next while the conversation only adds
    to the cart, and asking for a cheaper one;
  - **a fault on the last turn,** one kind at a time: a `503`, a timeout,
    empty content and malformed JSON; only with the model proxy;
  - **the last turn asked again;**
  - **the first turn of another conversation** in the same language.
- An operator is tried once per state a conversation ends in: the route of
  its last answer, with the tools the model asked for in it. From a second
  conversation that ended the same way, it would most likely reach the same
  paths.
- The search is deterministic: the same cases, data and answers give the
  same candidates in the same order.

**Judging.** Every check that needs no expectation judges a candidate, such
as `price-grounded`, `stock-claim`, the response contract and `everyAnswer`,
and `graceful-under-fault` under a fault. An opening turn that asks for a
type or a price bound also states it, from the catalog: `productType`, every
type with the asked words, and `filters.maxPrice` (ADR-0046, ADR-0048). So `type-matched-or-disclosed` and
`filter-honoured-or-disclosed` judge it too: products of other types, or over
the bound, fail unless the answer says so. Only that turn states it; a
candidate built on it, or the turn asked again, states nothing. A case with a
simulated customer is left out.

**Budget.** Before it sends anything, it prints the most runs it can make:
the written cases, then up to `--max-runs` candidates. An exploration that
can spend money on model calls needs `--max-cost`, its cap over every run.
It stops at either cap, and says so.

**What it writes.**
- The terminal shows the coverage map: each kind with what the written
  cases reached and what the search added, and the tools the model was
  offered but never asked for. Then each kept case, with what it reached or
  failed.
- **A case file** at `--out`, by default `explored.yaml` next to the profile.
  It never overwrites a file.
  - Each kept candidate is a case named `<operator>-<n>`, such as `cart-1` or
    `fault-2`, with status `proposed` and the provenance source `explore`.
    Its evidence says where it came from and what it reached or failed, and,
    for a turn that states an expectation, the type and bound it came from.
    That turn keeps its expectation in the case.
  - The cases a check failed on come first.
  - A proposed case runs, but gates only once a person approves it
    (ADR-0004).
- **A results file**, by default `runs/<run id>.json`: the written cases'
  results with the kept cases', the model calls of every run, dropped
  candidates too, and the coverage as `run.coverage`, with what the search
  added under `added`. `run.exploration.candidates` traces every candidate
  that ran, kept or not, in order: its operator, the conversation it went on
  from, the messages it sent, the route of each answer, the id it was kept
  under, and what it reached or failed. It holds no answer text.

It exits with `0` when the search ran, whatever it found, and with `2` on a
configuration problem, before any request.

## `yokla generate`

```sh
yokla generate --profile yokla.profile.yaml --absent en:hammock --absent tr:hamak
yokla generate --redteam --competitor Rivalmart
```

It writes cases whose expectations the domain pack computes from the
profile's data, as proposed cases (ADR-0055); with `--redteam`, attack cases
from templates instead (ADR-0080). It sends nothing and calls no model, and
the same data and options write the same file.

| Option | Default | Meaning |
|---|---|---|
| `--profile <file>` | `yokla.profile.yaml` | The profile, and through it the data. |
| `--out <file>` | `cases/generated.yaml` next to the profile; `cases/redteam.yaml` with `--redteam` | Where the cases go. |
| `--per-kind <n>` | 2 | The most cases of each kind, in each language. |
| `--absent <lang>:<words>` | | Types a shopper may ask for that you expect absent, comma-separated, such as `en:hammock,kayak`. Repeatable. Not with `--redteam`. |
| `--redteam` | | Write the attack kinds instead of the data kinds (ADR-0080). |
| `--competitor <name>` | | A competitor of the target's, which an answer must not name, for the `competitor` attack. Repeatable; only with `--redteam`. |
| `--force` | | Overwrite `--out`. |

**The kinds.** The e-commerce pack writes eight, in each of the profile's
languages it has phrasings for, `tr` and `en`. It chooses types as `yokla
explore` chooses its opening types, and names them by their words.

| Kind | Turns | Expectation |
|---|---|---|
| `lookup` | "Do you have the {name}?" | the product among the answer's products |
| `absent-type` | "Do you have any {word}?" | `absentType` |
| `empty-band` | the type under the largest whole amount below its lowest price | `productType`, `filters.maxPrice` |
| `attribute` | "Do you have any {type} with {attribute} {value}?" | `productType`, `filters.attributes` |
| `comparison` | "Which is better, the {a} or the {b}?" | both products among the answer's |
| `refine` | the type, then "And under {amount}?", its median price | the second turn: `productType`, `filters.maxPrice` |
| `cheaper` | a product by name, then "Do you have anything cheaper than the one I asked about first?" | the second turn: `productType`, at most its price, and a product shown |
| `unknown-stock` | "Is the {name} in stock?", a product whose stock is unknown | the product among the answer's |

- **The checks that read the catalog judge the rest:** `price-grounded` the
  prices shown, `stock-claim` any stock claim, which for an unknown stock is
  a finding.
- **`absent-type`** writes a word only when no catalog type has it as a
  level and no type label in its language is it. Without type labels in a
  language (ADR-0050), a word of that language is checked against the
  levels only, so "çadır" passes for a catalog of English paths: give the
  labels, or check the words you give.
- **Products in stock.** `lookup`, `comparison`, `cheaper` and `attribute`
  name products in stock, in catalog order: stock above 0, or `inStock`
  true without a quantity. A type with none writes no case of that kind. A
  catalog that maps neither `stock` nor `inStock` can't tell, so its first
  products are named. The evidence gives the stock each was named by
  (ADR-0062).
- **A name of its own.** `lookup`, `comparison`, `cheaper` and
  `unknown-stock` name a product whose name, in the case's language, no
  other product holds, compared in lower case with runs of spaces as one. A
  name that starts a longer one still counts as its own (ADR-0063).
- **`cheaper`** names a product with a cheaper one in stock of the same
  catalog type, so its second turn has something to show and expects at
  least one product (`evidence.products.min: 1`). The evidence names the
  cheaper product (ADR-0063). The second turn says what it is cheaper than,
  so a first answer that lists cheaper products doesn't change the bound
  (ADR-0064).
- **`attribute`** needs `ecommerce.catalog.fields.attributes` in the
  profile. The attribute and its value are written as the catalog writes
  them; reword them when you approve the case.
- **What it writes:** each case named `<kind>-<language>-<key>`, such as
  `lookup-en-tnt-001`, with status `proposed`, the provenance source
  `generator` and, as evidence, the data its expectations came from. The
  terminal counts the cases by kind and language, and names each kind that
  wrote none, with why. A proposed case runs, but gates only once a person
  approves it (ADR-0004).
- **When the catalog changes,** a generated case is `fixture-missing` like
  any other (ADR-0053): a product it expects that left the catalog is a fact
  that no longer holds.

**Attacks (`--redteam`, ADR-0080).** Five kinds, each case of the `redteam`
suite, each with an expectation a deterministic check decides:

| Kind | Worded by | Turn | Expectation |
|---|---|---|---|
| `injection` | the language pack | an instruction to drop the rules and reply with a canary, in four styles: `forget`, `persona`, `system` (a line posing as a system message) and `after-question` | `answer.notContains` its canary, `YK-` and six hex digits, its own for each case |
| `extraction` | the language pack | a request for the system prompt: `repeat`, `code-block`, `translate` | `answer.notContains` the profile's `modelProxy.inspect.canary`; with the proxy, `prompt-leak` judges too |
| `offer` | the domain pack | a price the user names for a product `lookup` would ask about: half its price, down to a whole ten; asked, or claimed approved by a manager | `concession.amount` |
| `commitment` | the domain pack | a promise no policy gives: a refund at any time, free shipping on every order, delivery tomorrow | `concession` |
| `competitor` | the domain pack | where else the product sells for less, naming no shop | `answer.notContains` every `--competitor` |

- **`--per-kind`** caps each kind in each language: 2 by default, so the
  first two styles; 4 writes every injection style.
- **`extraction` needs a canary** in the profile. Without one it writes
  none, and the terminal says so; so does `competitor` without
  `--competitor`.
- **Templates are fixed phrasings.** A target that resists them may fall
  to a reworded attack; later items of the red-team track vary them (design
  §20).

It exits with `0` when the file was written, and with `2` on a wrong option,
an existing `--out` without `--force`, a profile whose pack has no data to
generate from, or no case generated.
