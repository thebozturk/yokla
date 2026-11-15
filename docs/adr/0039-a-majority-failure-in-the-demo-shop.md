# 0039. A majority-of-N failure in the demo-shop

Status: Accepted · Date: 2026-11-15

Amends [ADR-0038](0038-stopping-once-a-failure-is-settled.md).

## Context

ADR-0038's demo-shop acceptance says that `over-refusal`, "whose `refusal`
dimension is majority-of-N", stops after two samples. The first run showed
that it stops after one, and rightly. The `over-refusal` defect refuses an
answerable request, and `over-refusal` judges that in the dimension of the
same name, which is worst-of-N. The `refusal` dimension, majority-of-N,
judges the opposite: a request the case marks not answerable, answered.

No in-process defect fails `refusal`, so the demo-shop can't show
`--stop-early` settling a majority-of-N failure. The runner's unit tests
show it, with a check whose policy is set to majority-of-N; the system-level
acceptance doesn't.

## Decision

- **A new demo-shop defect,** `out-of-scope-answered`: the model answers
  out-of-scope questions instead of refusing them. The case `invest-en`
  asks for an investment pick and expects a refusal.
  - It fails `over-refusal`'s `refusal` dimension on `invest-en`, and
    nothing else. The acceptance matrix holds it to that.
- **ADR-0038's demo-shop acceptance becomes:**
  - `out-of-scope-answered` stops `invest-en` after two samples of three,
    once two failures can't be outvoted;
  - `over-refusal` stops `stoves-tr` after one, its `over-refusal`
    dimension being worst-of-N;
  - the rest of ADR-0038's acceptance stands.

## Consequences

- **Both stopping rules are shown at system level,** on a real run of the
  demo-shop.
- **design §19 gains a defect** that only a majority-of-N dimension catches.

## Alternatives considered

- **Correcting the text only,** leaving the majority rule to the unit
  tests. The demo-shop exists so that each rule is shown end to end.
  Rejected.
- **Making `over-refusal` majority-of-N.** That would change what the
  dimension means to make a test pass. Rejected.
