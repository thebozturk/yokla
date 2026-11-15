# 0038. Stopping a case's samples once its failure is settled

Status: Proposed · Date: 2026-11-15

## Context

A case runs N samples: its own `samples`, else `--samples`, else 1 (design
§11). The verdict comes from all of them, per dimension (design §13):

- **worst-of-N:** one failing sample fails the dimension;
- **majority-of-N:** the dimension fails when more than half of the samples
  that measured it failed;
- **advisory:** reported, never deciding.

Often the verdict is settled before the last sample. A worst-of-N dimension
that failed in the first sample fails whatever the other samples show. On a
target whose model calls cost money, the remaining samples of a failing case
are spent for nothing, and so is the time.

Design §20's debugging track plans this as D3. A statistical rule, stopping
when an interval clears a threshold, would save samples on passing cases
too. But a worst-of-N dimension has no threshold above zero, and such a rule
can give another verdict than N samples would, with some probability. The
maintainer chose an exact rule: stop only when no further sample can change
the verdict.

Today the runner exchanges every sample of every case first, and judges
them after the last case. It reads the model proxy's records when the
recording closes, and the target's logs and the spans once at the end
(ADR-0009, ADR-0029). The proxy can already answer for an open recording,
and the runner settles it after every answer in serial correlation
(ADR-0016).

## Decision

### The option

- **`yokla run --stop-early`** turns it on. Without it, nothing changes.
- **Not with late signals.** With target logs (`target.observe.logs`) or
  spans (`modelProxy.spans`), the run refuses, with exit code `2`, before
  any request. Both arrive only after the run, and can change a sample's
  verdict after it was judged.

### When a case stops

After each sample, the runner judges that sample as the final judging
would, and stops the case's samples when one of these holds:

- **A deciding worst-of-N dimension failed** in a sample so far.
- **A deciding majority-of-N dimension can't pass any more:** with `f`
  failures out of `m` samples that measured it, and `r` samples left, it
  fails even if every remaining sample measures it and passes:
  `2f > m + r`.
- **A sample errored.** The case's status is `error` whatever follows.

Nothing else stops a case:

- **Passing is never settled early.** A later sample can fail a dimension,
  or leave it unmeasured, so a passing case runs all N samples.
- **Advisory dimensions are ignored,** since they never decide a status.

### Judging a sample during the run

- **The checks are the same,** with the same context: the sample's turns,
  their evidence, and the model calls the proxy tied to them.
- **The proxy's calls.** With a model proxy, the runner settles the
  recording after the sample (ADR-0016) and reads its records so far, so
  calls after the last answer count.
- **Only to decide.** The results come from the final judging over every
  sample that ran, as without the option, so a case is judged one way only.

### What the results show

- **The run** records `sampling: { stopEarly: true }`.
- **A case that stopped** records `samplesPlanned` with its N, next to the
  samples that ran. The terminal summary and the HTML report say "stopped
  after k of N samples".
- **Intervals, `unstable`, latency percentiles and cost** are computed over
  the samples that ran.
- **`yokla plan`** is unchanged: its upper bound already assumes every
  sample runs.

### The demo-shop

The acceptance runs every case with `--samples 3`, with and without
`--stop-early`, for the defect-free shop and for each in-process defect:

- every case gets the same status and the same failing dimensions both
  ways;
- each failing worst-of-N case stops after one sample;
- `over-refusal`, whose `refusal` dimension is majority-of-N, stops after
  two;
- every passing case runs all three;
- `--stop-early` with a log source refuses to run.

## Consequences

- **Failing cases cost one sample, not N,** when their failure is
  worst-of-N. Passing cases cost the same as before.
- **The verdict is the one N samples would give,** with one exception: a
  sample that would have errored after the failure was settled doesn't run.
  The case is then `fail` where N samples would report `error`. An error
  says the case couldn't be judged; a settled failure already judged it.
- **`unstable` sees less.** A case that stopped at its first failing sample
  can't show that later samples would have passed. A flaky failure looks
  like a steady one; yokla shrink's reproduction (ADR-0035) still tells
  them apart.
- **Each sample waits for its model calls to settle** when the proxy is
  used, which adds the profile's `settle.quietMs` per sample in header
  correlation.
- **Logs and spans can't be used with it.** A later ADR can lift that, for
  example by reading logs after every sample.

## Alternatives considered

- **A statistical rule,** such as stopping when the Wilson interval clears a
  configured rate, or a sequential probability ratio test. It saves samples
  on passing cases, but changes what a verdict means: worst-of-N would need
  a tolerated failure rate, and the verdict could differ from N samples'.
  Not chosen, by the maintainer, for now.
- **On by default.** The verdicts don't change, but the samples behind
  latency, cost and `unstable` do. Rejected: a run should change what it
  measures only when asked.
- **Running every sample when logs or spans are on, with a warning.** A
  silent change of behaviour between profiles. Rejected for a refusal.
- **Stopping a passing case once a failure is unlikely.** That is the
  statistical rule again, with a threshold nobody set.
