# 0014. Budgets: cost and latency thresholds, unmeasured thresholds, plan and cap

Status: Proposed · Date: 2026-11-10

## Context

The model proxy now measures each turn's model calls, tokens and cost
(ADR-0012). Design §10 names `cost-budget` and `latency-budget` checks, §13
says latency is judged by percentile across samples and that a threshold
without data is `unmeasured`, and §14 describes `yokla plan` and a `--max-cost`
cap. None of this exists yet:
- **No unmeasured threshold.** A check can only apply or not apply. A cost
  budget on a turn whose cost is unknown would "not apply". The case would
  then pass on its other checks: a silent pass.
- **No percentile policy.** The `percentile` and `mean` policies are in the
  results schema but aren't implemented.
- **Nothing in the gate reads cost or latency.**

## Decision

- **A check can report a threshold it can't measure.** Besides applying or not
  applying, a check can return `unmeasured` for a dimension, with a reason.
  - In `results.v1` this is an optional `unmeasured` field on the check result,
    an additive change.
  - A dimension that no sample measured has the verdict `unmeasured`.
  - A case with a deciding dimension that is `unmeasured` is `unmeasured`,
    unless another dimension fails; a failure still wins. It never passes.
- **Per-turn budgets.** `budget: { costUsd?, modelCalls? }` is a new core
  expectation. The `cost-budget` check judges it from the turn's proxy data.
  - The dimension is `cost`, worst of N.
  - Without proxy data, or with a turn cost of `null`, the check reports `cost`
    as `unmeasured`.
  - Per-turn latency already has `deadlineMs` (ADR-0013).
- **Latency and cost thresholds per suite, in the gate.** `yokla.config.yaml`
  gains these thresholds, gate-wide or per suite:
  - `latencyP50Ms` and `latencyP95Ms`: over the latencies of every answered
    turn of the suite, every sample included, by the nearest-rank method;
  - `costPerTurnUsd`: the mean cost of the suite's answered turns;
  - `costUsd`: the suite's total.

  A percentile across samples is judged on the pooled values, which is what
  design §13 asks. So the `percentile` policy isn't needed and stays unused.
  When a threshold has no data, it is an `unmeasured` breach:
  - no answered turn, for latency;
  - any answered turn with a `null` cost, for cost.

  Like an `unmeasured` case, it breaks the gate unless the suite sets
  `allowUnmeasured`.
- **`yokla plan` estimates from a calibration run.** `yokla plan --cases
  <path> --calibration <results> [--samples <n>]` estimates the cost of
  running the cases and contacts nothing.
  - Each planned turn costs what the same case cost per turn in the
    calibration, when it ran there with the same definition (ADR-0011).
    Otherwise it costs the mean over all calibrated turns.
  - It prints the estimate and an upper bound: the estimate times
    `plan.upperBoundFactor`, 2 by default.
  - It also prints how many cases had their own calibration.
  - **It refuses to guess.** Without a calibration, or when calibrated turns
    have a `null` cost, it says what is missing and gives no figure.
  - yokla's own model calls are counted as zero, which is exact while yokla
    makes none; generation and judging (v0.3, v0.4) will add theirs.
- **`yokla run --max-cost <usd>` is a hard cap.** It needs a model proxy.
  - After each sample, the runner reads the open recording and totals its
    cost. Once the total reaches the cap, no new sample or case starts. The
    results are `partial`, with an issue saying why, and the gate can't judge
    them (ADR-0010).
  - A recorded call without a cost makes the cap unenforceable. The run
    stops there the same way, and says so.

## Consequences

- **Budgets never pass silently.** Without prices or proxy data, a cost
  budget makes its case `unmeasured`, and the gate says so.
- **More `unmeasured` cases than before.** That happens exactly where a case
  asks for something that wasn't measured. Existing checks never return
  `unmeasured`, so their results don't change.
- **The perf suite is a suite of cases** with latency thresholds in the gate.
  No new runner mode is needed.
- **The cap costs one local control call per sample** while it is set.
- **Plan is only as good as its calibration.** The upper bound factor can
  later be tuned from the history of runs (design §14).

## Alternatives considered

- **A new finding verdict, `unmeasured`.** It would change an enum of
  `results.v1`, which ADR-0007 allows only as a new major version. An
  optional field is additive. Rejected.
- **Percentiles as an aggregation policy per dimension.** It needs a
  parameter per dimension and per-sample values in the aggregator. Pooled
  thresholds in the gate say the same with less machinery. Deferred.
- **Estimating cost from token counts and the price table alone.** It would
  need to guess the target's model calls and their sizes. A calibration run
  measures them. A profile-declared call count can be added later, for
  targets that can't be calibrated.
- **Enforcing the cap in the proxy, by refusing calls.** It would change the
  target's behaviour mid-run. The runner stopping is visible and leaves the
  target alone.
