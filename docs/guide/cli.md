# Commands, configuration and the gate

From a checkout of the repository, run each command as `pnpm yokla <command>`.
`yokla <command> --help` prints its options.

| Command | Does |
|---|---|
| `init` | Writes a first profile and starter cases from one message to the target. |
| `run` | Runs cases against the profile's target and writes a results file. |
| `report` | Prints the summary of a results file, and optionally writes JUnit XML or an HTML report. |
| `gate` | Judges a results file against thresholds and a baseline. |
| `baseline` | Accepts a run as the baseline. |
| `proxy` | Runs the model proxy until stopped. |
| `plan` | Estimates the cost of a run from an earlier one. |
| `schema <name>` | Prints a JSON Schema: `profile`, `cases`, `config`, `results` or `baseline`. |

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

## `yokla run`

| Option | Default | Meaning |
|---|---|---|
| `--profile <file>` | `yokla.profile.yaml` | The profile. |
| `--cases <path>` | `cases`, next to the profile | A case file or directory; repeatable. |
| `--out <file>` | `runs/<run id>.json` | Where to write the results. |
| `--samples <n>` | 1 | Samples per case, when the case doesn't say. |
| `--stop-early` | | Stop a case's samples once no further sample can change its failure (ADR-0038). Not with target logs or spans. |
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
get the run's first token, or when a case ended in `error`.

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

The results file (`results.v1`) holds every turn: the answer, the evidence,
the checks with their findings, timings, and the model calls with their cost.
Keep it out of version control when the answers may hold personal data.

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
  - It shows the run, the status of each case, how often each check applied,
    and every turn: the user's message, the answer, the findings, the mapped
    evidence and the model calls. Cases that didn't pass come first, open.
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
    takes it.
  - **Gemini's thinking** counts as output, and a thought summary isn't the
    customer's message.
  - **Without a `price`,** its calls have no cost, never 0.
  - **Privacy:** a hosted model receives the conversation, the target's
    answers included.
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
