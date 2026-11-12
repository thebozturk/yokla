# 0017. Fault jitter seeded by case, sample and turn

Status: Accepted · Date: 2026-11-12 · Amends 0013

## Context

ADR-0013 says of latency faults: "Jitter is drawn from a seed made of the turn
id, so a run can be repeated." The second half doesn't hold.

- **The turn id is random.** It is the request id yokla sends, or a fresh id
  when the profile sends none, and it changes with every run. The proxy seeds
  the jitter with it, so the same case gets a different delay in every run.
- **The turn id can't be made stable.** It doubles as the request id that the
  target's logs are matched by (ADR-0009). It must be unique in every run, so
  it can't also identify a turn across runs.
- **Unrepeatable delays blur verdicts.** A latency fault close to a turn's
  `deadlineMs` can pass in one run and fail in the next, with nothing changed.
  A regression against the baseline then can't be told apart from a different
  draw of jitter. In the end-to-end test, the demo-shop's `slow-provider` case
  failed about once in seven runs, partly because its delay changed from run
  to run. Its margin was widened; the delay still changes.

## Decision

- **The jitter seed is made of what identifies a turn across runs:** the case
  id, the sample index and the turn index. As before, the upstream id and how
  many calls each plan of the turn has matched are added, so each call of a
  turn gets its own draw.
- **The runner sends the seed** when it arms a turn's faults, in the same
  control call (ADR-0012). The proxy uses it instead of the turn id.
- **The same case, sample and turn get the same delay** in every run: on any
  machine, at any concurrency, in either correlation mode.
- **Samples still vary.** The sample index is part of the seed, so the N
  samples of a case draw N different delays.
- The rest of ADR-0013 stands.

## Consequences

- **A faulted run repeats.** The injected delays are the same from run to
  run. The time the target itself takes still varies, so a verdict near a
  deadline can still change, but no longer because of the injected delay.
- **The call order inside a turn matters.** Each call's draw depends on how
  many calls of the turn came before it. A target that makes a turn's calls in
  parallel, in a varying order, can give the same call a different draw.
- **Jitter no longer varies between runs.** To try other delays, raise the
  case's samples or change its `jitterMs`.
- **Renaming a case changes its delays.** A renamed case is a new case for the
  baseline too (ADR-0011).
- **The runner and the proxy change together.** They ship in the same
  version, and the arming call gains one field.

## Alternatives considered

- **A run seed, random by default, recorded in the results,** with `--seed`
  to repeat a run. A run would repeat only when asked to. A default run would
  still draw new delays, so comparing it with the baseline would still mix a
  change in the target with a change in jitter. It can be added later by
  mixing a run seed into this one. Not now.
- **Stable turn ids.** They would serve as the seed, but the request id must
  be unique per run for log correlation. Rejected.
- **No jitter, only fixed latency.** Repeatable, but it drops a fault that
  design §12 lists. Rejected.
