# 0013. Fault plans: provider faults per turn, injected by the model proxy

Status: Proposed · Date: 2026-11-10

## Context

v0.2's second exit criterion is that resilience defects are detected (design
§20). Design §12 lists the faults: latency with or without jitter, status
codes `429`, `500` and `503`, a dropped request, malformed JSON, a truncated
stream, empty content and tool calls that break their schema. The resilience
suite asserts graceful behaviour: an answer within the deadline, no fabricated
facts, the fallback route used.

Three things are open:
- **Where a fault is declared,** and how it reaches only the calls it is meant
  for.
- **How each fault is made.** Some faults need no provider call; others need
  the provider's real answer, changed.
- **How a target that fails under a fault is judged.** Today a non-2xx answer
  is a turn error, so the case is `error` and the gate exits with `2`: the
  very failure a resilience case looks for would read as "couldn't measure".

## Decision

- **Faults are declared per turn,** in the case file:

  ```yaml
  turns:
    - user: Çadır önerir misin?
      faults:
        - fault: { kind: status, status: 503 }
          calls: [1]          # the turn's model calls it applies to; default: all
          upstream: openai    # default: every upstream
      expect: { route: fallback, deadlineMs: 5000 }
  ```

  A case with faults needs a model proxy in the profile; preflight refuses it
  otherwise.
- **The runner arms them on the proxy** for the turn, with the same control
  call that marks the turn (ADR-0012). The proxy applies them only to calls of
  that turn, found by mark or by trace. Outside a recording, the proxy never
  changes a call.
- **How the proxy makes each fault:**

  | Kind | Forwarded | What the app gets |
  |---|---|---|
  | `status` (429, 500, 503) | no | that status with a provider-shaped error body; `retryAfterS` adds `Retry-After` |
  | `latency` | yes | the real answer, `ms` later, plus up to `jitterMs` |
  | `timeout` | no | nothing: the connection stays open until the app gives up, or `holdMs` (default 120 s) ends it without an answer |
  | `malformed-json` | yes | the first half of the real body, with status 200 |
  | `empty-content` | yes | the real answer with every text part emptied |
  | `truncated-stream` | yes | the first half of the events, then the connection ends |
  | `invalid-tool-call` | yes | the real answer with tool-call arguments that aren't JSON |

  - Jitter is drawn from a seed made of the turn id, so a run can be repeated.
  - A body that a fault changes is decoded and sent uncompressed.
  - A fault that can't apply is recorded as not applied: for example
    `invalid-tool-call` on an answer without tool calls.
  - A call that is not forwarded costs nothing. Its tokens are `0`, which is a
    measurement, since no provider call was made.
- **Records name the fault.** Each call's record and its turn's results carry
  the fault's kind and whether it applied.
- **A failure under a fault is a finding, not an error.** In a turn with
  faults, a non-2xx answer or an answer the profile can't read doesn't stop
  the case as an error. The core check `graceful-under-fault` fails instead,
  and the gate judges it.
- **`deadlineMs` is a core expectation** for any turn: the answer must arrive
  within it. The `answered-within-deadline` check judges it; without the
  expectation it doesn't apply. The fallback route is checked by the existing
  `route` expectation, and fabrication by the domain checks, as for any turn.
- **The demo-shop gains resilience, and resilience defects.**
  - **Correct behaviour:**
    - one retry after a `429` or `503`, honouring `Retry-After`;
    - a model timeout (3 s by default);
    - an answer from a template, on the `fallback` route, whenever the model
      fails or its output can't be used.
  - **Defects,** each caught only by its own check:
    - `no-model-fallback`: a model failure becomes a `500`;
    - `no-model-timeout`: a stalled model stalls the answer past the deadline;
    - `unchecked-model-output`: malformed or empty model output reaches the
      user.

## Consequences

- **Resilience cases need a proxy.** Fault injection depends on the proxy's
  correlation. Without the proxy, a target can't be tested for resilience
  through yokla.
- **Faulted runs cost less.** Faults that aren't forwarded make no provider
  call.
- **The gate can fail on resilience.** A target that crashes under a provider
  outage breaks the gate with `1`, not `2`.
- **Changing answers needs the protocol.** The proxy parses OpenAI-compatible
  and Anthropic answers to empty or break them. Another protocol needs its own
  adapter (ADR-0012).

## Alternatives considered

- **Faults per case instead of per turn.** It is shorter to write, but a
  multi-turn case could no longer fail just its second turn. Per turn, with
  the case's own turns as the unit, is the precise form.
- **Fault plans in the profile.** They would apply to every case. Faults are
  scenarios, so they belong with the cases that assert the behaviour.
- **Every fault synthesized by the proxy.** No provider call would be needed,
  but empty content, malformed bodies and truncated streams would no longer
  look like the provider's real answers.
- **A target failure under a fault as an `error`.** That keeps today's rule,
  but then a resilience case could never fail. The gate would only ever say
  "couldn't measure". Rejected.
