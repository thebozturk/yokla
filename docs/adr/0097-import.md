# 0097. Import (E5)

Status: Proposed · Date: 2026-11-23

## Context

ADR-0092 makes E5 import: another tool's cases and results, read through a
mapping the user writes, as a profile adapts yokla to a target (P9): which
field or column holds the message, the answer, the verdict, the score and
the reason. JSON, JSON Lines, CSV and YAML. Cases become proposed cases with
`source: import` (ADR-0004); results become samples and findings (ADR-0007),
which report and gate like yokla's own. A row whose verdict the mapping
can't find is `unmeasured`, never a pass. Its exit criteria: three fixtures,
each in a different shape written from a tool's published format, import
with their verdicts; yokla's own exported rows (E4) import back to the same
statuses; imported cases don't gate until a person approves them.

ADR-0092 also says that no other tool is named: fixtures are named by their
shape, and yokla ships no mapping for a named tool.

What exists:

- **`@yokla/interop-rows`** (ADR-0096) maps cases and runs to neutral rows,
  `core` only. E5 adds the way back, as ADR-0096 planned.
- **`core`** reads YAML 1.2 and JSON (`parseConfig`), queries JSONPath
  (`queryJsonPath`), aggregates samples into a case's status by its
  dimensions' policies (`aggregateCase`), and sums a run (`summariseCases`,
  `summariseChecks`).
- **A case's `source`** already has the value `import`, and a proposed case
  runs but doesn't gate (ADR-0004).
- **The results schema** requires per case a suite, a language, samples of
  turns with their checks, and the dimensions' aggregation.

## Decision

### The mapping

A small YAML or JSON file, `yokla.import/v1`, validated at load, says where
each value is. A value is a JSONPath into the row, or `{ value: … }` for a
constant:

```yaml
version: 1
rows: $.results[*]            # where the rows are, in a JSON or YAML file
case: $.id                    # the case's id
message: $.input.question     # what was sent
answer: $.output              # what came back (results)
verdict:                      # the row's verdict (results)
  at: $.passed
  pass: [true]
  fail: [false]
score: $.score                # kept with the verdict (results)
reason: $.reason
findings:                     # each assertion, when the tool lists them (results)
  at: $.assertions[*]
  check: $.name
  verdict: { at: $.passed, pass: [true], fail: [false] }
  reason: $.reason
sample: $.attempt             # which sample of the case (default: the order of its rows)
turn: $.turn                  # which turn of the sample (default: 0)
suite: { value: quality }
language: { value: en }
tags: $.tags
```

- **The file's format** comes from its extension: `.json`, `.jsonl`,
  `.csv`, `.yaml` or `.yml`. A CSV file's first line names its columns, and
  each row is read as an object of strings: `$.question` is the column
  `question`.
- **`rows`** applies to a JSON or YAML file; by default its top level, when
  that is an array. Each line of JSON Lines and each CSV row is a row.
- **`case`** defaults to `row-<n>` by the row's position when cases are
  imported; results need it, to group the rows of a case.
- **`suite`** defaults to `quality`, and **`language`** to the profile's
  first language: the command passes it.
- **Nothing in the mapping names a tool.** It is the user's, like a profile.

### Cases

- **`yokla import cases --from <file> --mapping <file> --out <file>`**
  writes a case file: a case per distinct `case`, its rows' messages as its
  turns in their order, with `provenance: { source: import, evidence:
  '<file>, row <n>', status: proposed }`.
- **The cases carry no expectations.** Another tool's assertions don't say
  what yokla's checks should expect. The person who approves a case writes
  its expectations, and a proposed case runs but never gates (ADR-0004).
- **It never overwrites a file,** as `yokla explore` doesn't.

### Results

- **`yokla import results --from <file> --mapping <file> --out <file>`**
  writes `results.v1`, which `yokla report`, `yokla gate`, `yokla compare`
  and `yokla baseline` read like any run.
- **Each row is one turn of one sample of its case** (ADR-0007): the rows of
  a case are grouped by `sample`, and ordered by `turn`.
- **The row's verdict is a finding** of the check `imported`, in the
  dimension `verdict`, with the reason as its message and the score with
  it. The dimension's policy is `worst-of-n`.
- **Each mapped assertion is a finding** of the check `imported`, in a
  dimension named after it, with the policy `advisory`: it explains the
  verdict, and doesn't decide it.
- **A row whose verdict the mapping can't find, or finds outside both
  lists, is `unmeasured`**: its turn gets no finding in `verdict`, and an
  unmeasured entry that names why. The case is then `unmeasured`, never a
  pass (design §13).
- **The run** is named by the source file: its id, the target `imported`,
  the file's SHA-256 as the profile's, and the run's times as the import's.
- **A case's definition hash** is that of its id and messages, so a
  baseline compares an imported run with the next import of the same cases
  (ADR-0011).

### yokla's own rows

**A mapping for `yokla.result-row/v1`** ships in the guide, not in code:
its `case`, `sample`, `turn`, `message`, `answer` and `verdict` (`pass`
passes, `fail` fails, `unmeasured` is neither), and its findings. A run
exported with `yokla report --rows` and imported back has the same statuses
when its dimensions aggregate worst of n, as the demo-shop's do; another
policy, such as majority of n, isn't in the rows.

### The library API

**`importCases(text, mapping, options)`** and **`importResults(text,
mapping, options)`** are added (ADR-0093), with the `ImportMapping` type:
the commands' work on text the caller read. The mapping and the reading of
rows live in `@yokla/interop-rows`.

### Exit criteria

- **Three fixtures, in different shapes,** written from the published
  formats of the kinds of tool in design §4 and named by their shape: a
  JSON file of nested results with per-assertion components, JSON Lines of
  flat graded rows, and a CSV of graded answers. Each imports through its
  mapping with its verdicts, and the gate judges it: pass, broken or
  unjudgeable as the fixture says.
- **A row with no verdict** makes its case `unmeasured`.
- **The round trip:** a demo-shop run, correct and with
  `fabricated-price`, exported with `yokla report --rows` and imported back
  through the guide's mapping, has every case's status.
- **Imported cases don't gate:** a case file imported from a fixture runs
  against the demo-shop, and the gate passes while its cases are proposed;
  once a person approves them, as they carry no expectations, the gate is
  broken by their `unmeasured` status until expectations are written.

## Consequences

- **A team can keep another tool's results in yokla's gate,** baseline and
  reports, and move its datasets into yokla's cases, without yokla knowing
  the tool.
- **Imported verdicts are the other tool's.** yokla reports them as such: a
  finding of `imported` says what the row said, not what yokla's checks
  found.
- **`@yokla/interop-rows` grows** a CSV reader of its own, a few dozen lines
  with tests, so `core` and the package stay without a new dependency.

## Alternatives considered

- **Map the other tool's assertions to yokla's expectations.** Each tool
  names them its own way, and a mapping from one to the other would be a
  mapping for a named tool. Rejected: the person writes the expectations.
- **Let the assertions decide the verdict,** worst of them. A tool may weigh
  its assertions, or pass on a threshold of their score. Rejected: the
  row's verdict decides, as the tool decided.
- **Treat a missing verdict as a pass, or as a fail.** A pass would be
  silent, and a fail would claim a finding no one made. Rejected:
  `unmeasured`, as P5 says.
- **A CSV dependency.** It would add a supply-chain entry for a format this
  small. Rejected: an RFC 4180 reader of its own.
- **A mapping for yokla's rows in code.** It would be a second format for
  one already documented. Rejected: the guide's mapping, tested by the round
  trip.
