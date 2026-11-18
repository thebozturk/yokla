# 0070. v0.4 ships with one exit criterion partly met

Status: Proposed · Date: 2026-11-18

## Context

Design §20 says a version ships when its exit criteria hold. v0.4 has
three.

- **On the demo-shop, the analyzer reproduces the approved entries of the
  hand-written profile.** It holds (ADR-0047).
- **On the demo-shop, a transform catches a seeded defect, and the other
  cases keep their verdicts.** It holds (ADR-0045, ADR-0059).
- **On the private target, yokla rediscovers the known issue classes.** It
  holds for one class of four (design §19):
  - **type absence vs price-band relaxation:** rediscovered;
  - **fabricated prices** and **direct prompt injection:** not
    rediscovered, with every turn judged. Those are honest negatives: the
    target no longer shows them, as far as the cases reach;
  - **stale data-bound cases:** waiting. The target's local data hasn't
    changed since 2026-11-10, so nothing can be stale. A fresh export on
    2026-11-18 was byte for byte the same;
  - **indirect injection through a tool result** couldn't be tried. The
    target can't be pointed at the model proxy (ADR-0069).

What is missing depends on the target, not on yokla. Every scope item of
v0.4 is done, and many changes since 0.3.0 (ADR-0040 to ADR-0069) are
unpublished.

## Decision

- **v0.4.0 is released** with the third criterion partly met.
- **The changelog states each criterion as it stands:** the two that hold,
  and for the third, each class with its outcome, as design §19 gives it.
- **The roadmap row keeps its exit criteria as written.** The open classes
  carry over: stale data-bound cases are measured once the target's data
  changes, and indirect injection once the target can be pointed at the
  proxy. Their results go to design §19 and the changelog of the version
  that measures them.
- **This is an exception, not a new rule.** Later versions ship when their
  criteria hold, as §20 says.

## Consequences

- **The work since 0.3.0 reaches npm** with its gaps named.
- **"v0.4" no longer means every criterion held.** Anyone reading the
  changelog sees which didn't, and why.
- **The open classes stay open work,** not a reason to hold every other
  change back.

## Alternatives considered

- **Hold the release until the target's data changes.** That may take
  weeks and depends on someone else. Rejected.
- **Release a 0.3.x instead,** saving "0.4" for when the criterion holds.
  The scope is v0.4's, and a patch number would say there are only fixes.
  Rejected.
- **Count an honest negative as a rediscovery.** It isn't one. Rejected.
