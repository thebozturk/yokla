# 0010. The gate: thresholds per suite, a baseline, and three exit codes

Status: Accepted · Date: 2026-11-10

## Context

Design §16 names a gate: `yokla gate` applies thresholds per suite from
`yokla.config.yaml`, and its exit code is `0` passed, `1` gate broken or `2`
run error. Design §13 adds two rules:
- `unmeasured` never counts as a pass;
- a case that passed in the baseline and no longer passes breaks the gate.

Neither document fixes the thresholds, the file format, or which statuses
break the gate. Other decisions bear on it:
- **ADR-0004.** Only approved cases gate.
- **ADR-0005.** Judge dimensions don't gate by default.
- **ADR-0007.** The gate reads only `results.v1`.

## Decision

- **Command.** `yokla gate --results <file> [--baseline <file>]
  [--config <file>]`. It reads results files only and contacts nothing.
- **Exit codes.**
  - `2`, the run can't be judged: a case is `error` or `fixture-missing`, the
    run is `partial`, or a file can't be read or is invalid. A run that
    couldn't be measured is never reported as broken or passed.
  - `1`, the gate is broken: at least one rule below is broken.
  - `0`, the gate passed.
- **Rules per suite.**
  - **Failures.** A suite may have at most `maxFailures` cases with status
    `fail`. The default is `0`.
  - **Unmeasured.** A suite may have `unmeasured` cases only with
    `allowUnmeasured: true`. The default is `false`, because `unmeasured`
    never counts as a pass.
  - **Known gaps.** `known-gap` doesn't break the gate. `gap-closed` doesn't
    break it either, but the gate says to remove the marker and update the
    baseline.
- **Baseline.** A baseline is a results file.
  - **Regression.** A case that was `pass` in the baseline and is now anything
    but `pass` or `gap-closed` breaks the gate, whatever the thresholds allow.
    A case that became `known-gap` counts as a regression: the marker
    documents a gap, it doesn't excuse a new one.
  - **Not regressions, but reported:** a baseline case missing from the run
    (the run may be a subset), and a baseline made with another profile.
  - Updating the baseline is a separate, explicit command (design §13).
- **Configuration.** `yokla.config.yaml` holds `version: 1` and a `gate`
  section. Thresholds set on `gate` apply to every suite, and `gate.suites`
  overrides them per suite. Without the file, the defaults apply and the gate
  says so. A Zod schema in `core` defines the file, and its JSON Schema is
  generated like the others (ADR-0008).
- **Deferred: approved cases only (ADR-0004).** `results.v1` doesn't yet carry
  a case's review status, and every case so far is written by a person. When
  generated cases arrive (v0.3), results gain the review status, and only
  approved cases gate.

## Consequences

- **CI can tell "broken" from "couldn't run".** A broken target fails the
  build with `1`; a misconfigured run or an unreachable target gives `2`.
- **Strict by default.** A new suite with a vacuous case breaks the gate until
  the case measures something or the suite allows `unmeasured`.
- **Regressions can't be hidden by thresholds or markers.** A tolerated failure
  must not be a new one.
- **Running a subset doesn't break the gate**, but the gate lists the baseline
  cases it didn't see.

## Alternatives considered

- **Pass rates instead of counts.** Rates suit large generated suites, but hand
  written suites are small, and a rate hides which case broke. Counts first; a
  rate can be added as another optional threshold.
- **`unmeasured` allowed by default.** It would let vacuous cases pass the gate
  silently. Rejected.
- **`error` as a gate failure (`1`).** It would mix "the target is wrong" with
  "the run couldn't measure it". Rejected.
- **Gating inside `yokla run`.** Running and judging stay separate, so a run can
  be judged later against another baseline or config.
