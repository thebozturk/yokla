# 0095. Two runs side by side (E3)

Status: Accepted · Date: 2026-11-23

## Context

ADR-0092 makes E3 a comparison that shows what changed inside a case: per
case, each run's findings, check by check, as new, gone or kept; each
turn's answers next to each other; cost and latency per case; and a
comparison page in the HTML report. It compares any runs of the same cases:
before and after a change, two targets, two profiles. Its exit criteria, on
the demo-shop: the correct shop's run compared with a run under one defect
names that defect's cases and checks as newly failing and shows both
answers; reversed, it names them fixed; two runs of the correct shop show no
change in findings.

What exists:

- **`yokla compare`** (ADR-0042, ADR-0043) reads two results files or more.
  Per run it gives the gate's verdict, the status counts, the cost and the
  latency, and it names the cheapest run that passes. Per case it gives the
  status in each run, whether the statuses differ, and whether the case's
  definition differs (then its statuses aren't compared, ADR-0011).
  `--expect-same` exits with 1 when a status differs. `--json` writes
  `yokla.comparison/v1`.
- **The library API** (ADR-0093) exports `compare` and `comparisonReport`.
- **The results** hold, per case, sample and turn, the user's message, the
  answer, each check's findings, the latency, and the model calls with
  their cost.
- **The HTML report** (ADR-0023) is one static file with no script, which
  shows a run's answers. The comparison has no page.
- **Within `results.v1` and its siblings,** a change only adds optional
  fields (ADR-0007).

## Decision

### The comparison says what changed inside a case

`yokla.comparison/v1` gains optional fields per case, so existing readers
keep working:

| Field | What it holds |
|---|---|
| `findings` | One row per failing finding of the case, keyed by its turn, its check and its dimension: in each run, in how many samples it failed (`0` when it didn't, `null` when the case or the turn isn't in that run), and the first failing message there. Only rows that fail in at least one run. |
| `findingsDiffer` | Whether a row fails in one run and not in another. |
| `costUsd` | Per run, the target's model cost of the case: the sum of its turns' costs from the proxy or the spans; `null` when a turn's cost isn't known or nothing measured it. |
| `latencyMs` | Per run, the median latency of the case's answered turns; `null` with none. |

- **Rows, not verdicts.** A run's rows say what failed there. The reports
  read them against the first run, the base: a row that fails only in the
  later run is **new**, one that fails only in the base is **gone**, one
  that fails in both is **kept**. When the base lacks the case, what fails
  later is new.
- **A row is any failing finding,** an advisory one too: the reports show
  what failed, and the case's status says what counted.
- **A sample counts once per row,** however many of its findings fail the
  row's check on that turn.
- **A case whose definition differs** gets no rows: it isn't compared, as
  ADR-0011 says, and the comparison says so as before.
- **The order:** the cases whose status differs first, then those whose
  findings differ, then the rest.
- **The comparison holds no answers.** A message can quote a value from an
  answer, as the terminal summary's can.
- **`--expect-same` keeps its meaning,** a status that differs (ADR-0043).
  A finding that changes inside a case whose status didn't is reported, and
  doesn't change the exit code.

### The terminal names the changes

After the runs and the statuses, `yokla compare` lists each case whose
findings differ, and for each later run against the base, its new and gone
findings: the turn, the check, the dimension and the message. Kept findings
are counted, not listed. When no case's findings differ, it says so in one
line.

### A comparison page

- **`yokla compare --html <file>`** writes one static page, under the rules
  of the HTML report (ADR-0023): no script, nothing loaded, the answers
  shown as text.
- **It shows:** each run, with its label, gate verdict, status counts, cost
  and latency; then each case, the changed ones first and open, with its
  status, cost and latency per run, its new, gone and kept findings, and
  turn by turn the user's message with each run's answer side by side and
  the findings that failed under it.
- **The sample shown** is each run's first failing sample of the case, or
  its first sample when none failed, as the MCP server's `explain_finding`
  chooses (ADR-0041).
- **The user's message** is shown once per turn, or once per run when the
  runs sent it differently, as under a transform (ADR-0045).
- **It holds the target's answers,** as the results file and the HTML
  report do. The guide says to treat it as target data.

### The library API

- **`compare`** returns the comparison with its new fields.
- **`comparisonHtml(comparison, runs)`** is added (ADR-0093): the page, from
  the comparison and the runs' results, in the same order.

### Exit criteria

An end-to-end test runs the demo-shop's cases against the correct shop
twice, and once against a shop with `fabricated-price`:

- **Correct, then the defect:** every case the defect fails has a new
  `price-grounded` row, its dimension `fabrication`, and no other row is
  new; the page shows both runs' answers of such a case. A case with a
  follow-up gains the row on each turn that quotes a price.
- **The defect, then correct:** the same rows are gone.
- **Correct, twice:** no case's findings differ.

## Consequences

- **The comparison grows with the failing findings,** not with the
  answers: a row per failing check and turn.
- **The JSON Schema of the comparison changes** by additions only, and is
  regenerated.
- **A run compared with itself before and after a fix** shows the fix as
  gone rows, with the answer that changed, without opening two HTML
  reports.

## Alternatives considered

- **Store new, gone and kept in the JSON.** They depend on which run is the
  base, and say less than the counts per run. Rejected: the rows hold the
  counts, and the reports read them against the first run.
- **The answers in the comparison JSON.** It would become target data, and
  copy what the results files hold. Rejected: the page reads them from the
  results.
- **Compare every sample.** Samples of a run aren't paired with another
  run's samples. Rejected: a row counts the failing samples; the page shows
  one sample per run.
- **Findings changes break `--expect-same`.** A metamorphic run whose
  wording moves but whose verdicts hold would then fail. Rejected: statuses
  decide, as ADR-0043 says.
- **A text diff of the answers.** Two answers can differ in every word and
  pass the same checks. Rejected: they are shown side by side, and the
  findings say what changed.
