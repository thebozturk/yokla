# 0096. Export (E4)

Status: Proposed · Date: 2026-11-23

## Context

ADR-0092 makes E4 export: yokla's cases as a neutral dataset, a JSON Lines
row per case; its results as neutral rows, one per turn and sample, with the
status and the findings; and its checks as one JavaScript assertion function
on the library API, for any tool whose assertions can be JavaScript: an
answer and its evidence in, a verdict, a score and a reason out. Each format
has a JSON Schema and a table of what it leaves out (ADR-0007). Its exit
criteria: the assertion function, given the turns of a demo-shop run, gives
the run's own verdicts; a demo-shop run's exported cases and rows validate
against their schemas.

ADR-0092 also says:

- **No other tool is named.** yokla writes no other tool's configuration
  file. A user points their tool at the assertion function and at their
  target, in their own configuration.
- **Interoperability lives in `interop-*` packages named by what they do,**
  which E4's and E5's ADRs choose, under the `interop-*` layer rule: they
  depend on `core` only.

What exists:

- **The runner judges a turn** by reading the target's body with the
  profile's response mapping (`extractResponse`: the text, the route, the
  evidence), building the turn's view, and running the checks with the case,
  the turn's index and the earlier turns' views. `aggregateCase` turns the
  checks' findings into the case's status by each dimension's policy. None
  of this is reachable without sending the turn to the target.
- **The library API** (ADR-0093) loads a project: the profile, the cases,
  the configuration and its check modules.
- **The results** hold, per turn, the message, the answer's text and mapped
  evidence, the latency, the cost and every check's findings.

## Decision

### A package for neutral rows: `@yokla/interop-rows`

- **It maps yokla's cases and results to neutral rows,** and, in E5, rows
  back. Pure, `core` only, as the `interop-*` layer rule says.
- **Its name needs reserving** before the release that first carries it
  (ADR-0071): the maintainer publishes the placeholder, deprecates it, adds
  the trusted publisher and requires two-factor authentication.
  `pnpm pack-check` packs ten packages from then on.

### Case rows: `yokla.case-row/v1`

One JSON Lines row per case, for any tool that reads a dataset:

| Field | What it holds |
|---|---|
| `schema` | `yokla.case-row/v1` |
| `id`, `suite`, `language`, `tags` | as the case has them |
| `message` | the first turn's message, for a tool that sends one message |
| `turns` | each turn's message and its expectations, as the case writes them |

- **`yokla export --out <file>`** writes them from the project's cases, as
  `yokla run` loads them, with `--profile`, `--cases` and `--tag`.
- **Left out, and listed in the guide's table:** a case with a simulated
  customer (it has no written turns: it is skipped, and the command says
  so); a turn's provider faults and tool changes, which need yokla's proxy;
  identities and roles; the case's provenance and review status. Only
  approved cases are written.

### Result rows: `yokla.result-row/v1`

One JSON Lines row per turn of each sample, for any tool or dashboard that
reads rows:

| Field | What it holds |
|---|---|
| `schema` | `yokla.result-row/v1` |
| `run`, `case`, `suite`, `language`, `tags` | the run's id and the case's |
| `sample`, `turn` | their indexes |
| `message`, `answer` | what was sent, and the answer's text |
| `latencyMs`, `costUsd` | the turn's, when measured |
| `verdict` | the turn's: `fail` when a finding of a dimension that isn't advisory failed, `pass` when one passed and none failed, `unmeasured` otherwise |
| `status` | the case's status in the run |
| `findings` | each finding: check, dimension, verdict, severity, message |
| `error` | why the turn couldn't be judged |

- **`yokla report --results <file> --rows <file>`** writes them.
- **They hold the target's answers,** as the results file does.
- **Left out, and listed in the guide's table:** evidence, the model calls
  and their prompts, spans, observed log fields, aggregation per dimension
  across samples, and the run's metadata beyond its id.

### The assertion function

- **`createAssertion(project)`** on the library API gives an async function
  `(answer, context) → { pass, score, reason, verdict }`:
  - **`answer`** is the target's answer: its JSON body, `{ body }`, read
    with the profile's response mapping, so the evidence checks apply; or
    its text alone, a string, when the tool has only the text; or
    `{ text, evidence }`, as yokla's results hold it.
  - **`context`** names the yokla case, `{ case, turn? }`, the last turn by
    default, and `earlier`, the answers of the turns before it, for checks
    that read the conversation.
  - **It judges the turn** with yokla's checks, for that turn's
    expectations, as the runner does, and gives the turn's verdict as the
    result rows define it.
  - **`pass`** is true only for `pass`: `unmeasured` is never a pass.
    **`score`** is the share of the turn's applicable findings that passed,
    0 with none. **`reason`** names the failing findings, or why the turn
    is unmeasured.
- **The runtime gains `judgeAnswers`,** the runner's own judging of given
  answers, with no target and no model call: the same response mapping,
  the same view, the same checks. Checks that need the model proxy, the
  spans or the target's logs find nothing to read, as in a run without
  them.
- **The guide shows its use** from a tool's JavaScript assertion, without
  naming a tool: export the cases, send each `message`, and call the
  function with the answer and the row's `id`.

### JSON Schemas

`yokla schema case-row` and `yokla schema result-row` print them, and
`packages/cli/schemas/` holds them, generated as the others are.

### Exit criteria

- **The assertion gives the run's verdicts:** for every turn of a
  demo-shop run, against the correct shop and with `fabricated-price`, the
  assertion given the turn's recorded text and evidence, and the earlier
  turns', gives the verdict and the failing findings the run gave.
- **From the body, as a tool would:** each single-turn case's message sent
  to the demo-shop by the test itself, and its body given to the
  assertion, gives the run's verdict.
- **The rows validate:** a demo-shop run's exported case rows and result
  rows parse with their schemas, one row per approved case without a
  simulated customer, and one per turn of each sample.

## Consequences

- **A team on another tool can keep yokla's checks:** its tool sends the
  messages, and yokla's function judges the answers, against the catalog
  and the policies in yokla's profile.
- **A new published package,** whose name the maintainer reserves before
  the next release.
- **The assertion judges a turn, not a case.** Samples and their
  aggregation stay with the other tool; the verdict of one answer is
  yokla's.
- **Answers leave yokla only in the result rows,** a file the user writes,
  as the results file is.

## Alternatives considered

- **The rows in `core`.** No new package to reserve, but ADR-0092 puts
  interoperability in `interop-*` packages. Rejected.
- **One package per direction,** export and import. Two names to reserve
  for one mapping. Rejected: E5 adds import to `interop-rows`.
- **The assertion in `interop-rows`.** It needs the packs, the runtime's
  judging and the user's check modules, which the `interop-*` layer can't
  reach. Rejected: it is on the library API, as ADR-0092 says.
- **Re-run the target inside the assertion.** It would send the message
  again, and judge a different answer from the one the tool saw. Rejected:
  it judges the answer it is given.
- **`unmeasured` as a pass.** Rejected by P5: never a silent pass.
