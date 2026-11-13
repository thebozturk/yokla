# 0019. An edge-case turn is judged on whether the target handled it

Status: Accepted · Date: 2026-11-13 · Amends 0018

## Context

ADR-0018 added `allowStatus` for edge-case turns, such as an empty or a very
long message. A turn that sets it is never an error for its status: the check
`status-allowed` passes a 2xx or a listed status and fails any other. A target
that crashes on the edge case then fails the case instead of making the run
unjudgeable.

The open-source target showed that a status is not the only way to fail.
- **What the target did.** It sent the whitespace-only message on to its
  model, and the provider refused it with `400`. By then the target had
  already answered `200` and begun an event stream. The stream ended without
  its done event.
- **How yokla read it.** The answer was incomplete (ADR-0016), so the turn
  was an `error` and the gate couldn't judge the run.
- **What the case wanted.** The target mishandled the edge case, which is the
  finding the case exists for. The result said "couldn't measure" instead.

The same would happen to a 2xx body that isn't JSON, or that has no answer
text at the profile's path. ADR-0018's rule covers the status only.

## Decision

- **A turn that sets `allowStatus` is never an error for the answer it got.**
  It counts as handled with a 2xx answer that yokla reads in full, or with a
  listed status. Anything else is a finding of `status-allowed` (dimension
  `robustness`), and the finding names what went wrong. That covers:
  - another status;
  - a stream that ends before its done event, or that sends its error event;
  - a body that isn't JSON;
  - an answer without its text.
- **As before, a turn without a usable answer** is judged only by the checks
  that need no answer (`graceful-under-fault`, `answered-within-deadline`,
  `status-allowed`).
- **The check keeps its id.** `status-allowed` now describes itself as: the
  target handled the turn, with a complete 2xx answer or a status the turn
  allows.
- **A turn without `allowStatus` is unchanged.** An answer yokla can't read
  there is still an `error`.

## Consequences

- **The run can be judged.** On the open-source target, the empty-message
  starter case fails, and the gate exits with `1` instead of `2`.
- **Profile mistakes stay visible.** A wrong text path in an edge-case turn
  reads as a robustness failure, not as an error. The finding says "answer
  text not found at …", and every other turn of the run, which has no
  `allowStatus`, still errors on it.
- **Edge-case turns are the only place this applies.** Elsewhere, an answer
  that can't be read still stops the case.

## Alternatives considered

- **Map the target's error event in the profile.** `init` could infer it, and
  the stream would then end with an error. But an error event makes the
  answer incomplete too (ADR-0016), so the turn would still be an `error`. It
  doesn't solve the problem.
- **A separate expectation, such as `handled: true`.** It would say the same
  thing as `allowStatus`, which already marks a turn as an edge case. It adds
  surface for nothing. Rejected.
- **Leaving it as it is.** The gate would say "can't judge" for the very
  defect the case looks for. Rejected.
