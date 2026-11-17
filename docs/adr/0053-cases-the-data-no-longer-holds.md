# 0053. Cases the data no longer holds: fixture-missing

Status: Accepted · Date: 2026-11-17

## Context

Design §9 plans freshness for data-grounded cases: "If the snapshot no
longer satisfies a case's precondition, the case is `fixture-missing`, not
`fail`. Snapshot provenance (time, row count, hash) is written to the
results." Results.v1 has the status, and the gate already treats it as a run
that can't be judged (§16). Nothing produces it yet.

A case rests on the catalog in two ways:

- **`absentType: hammock`** says the catalog holds no hammock. The demo-shop's
  `hammock-en` case asks "Do you sell hammocks?", and `absence-correct`
  fails an answer that doesn't say so. If the catalog gains a hammock, a
  right answer fails.
- **`productType: outdoor/hydration/water-bottle`** says the catalog holds
  water bottles. If they leave the catalog, the case asks for a type that
  isn't there, and `type-matched-or-disclosed` judges an answer to a
  question nobody would ask now.

Catalogs change daily on a real shop. `yokla explore` writes proposed cases
with these expectations from the catalog of the day (ADR-0046), and the
private target's known issue classes include stale data-bound cases (§19).
The checks that read amounts and stock read the catalog of the run already,
so they don't go stale. What goes stale is a fact a case states.

A filter doesn't: `filter-honoured-or-disclosed` holds whether or not a
product matches the bound. The answer must honour it or say it didn't.

## Decision

### The facts a case rests on

- **The domain pack derives them from the expectations,** with no new case
  syntax. The e-commerce pack:

  | Expectation | Fact | Unmet when |
  |---|---|---|
  | `absentType: T` | the catalog holds no `T` | a product's type is `T`, or under it by `typeSeparator` |
  | `productType: T` or `[T, …]` | the catalog holds one of them | no product's type is one of them, or under one |

- **Nothing else is a fact,** so no other case changes: filters, `answerable`
  and `policyTopic` hold whatever the catalog holds.
- **An unknown is not unmet.** Without a catalog, or without types in it,
  the pack states no fact, and the case runs as before.
- **Every expectation counts:** each turn's, and a simulated customer's
  (ADR-0028). Written, starter, explored and transformed cases alike.
- **Core stays domain-free (P7).** A prepared pack may give
  `unmetFacts(expect)`, which returns one line per unmet fact. Core never
  reads the keys.

### A case whose facts are unmet doesn't run

- **Before it runs,** each case's expectations are checked against the
  prepared pack. A case with an unmet fact sends nothing: no request, no
  model call, no cost.
- **Its status is `fixture-missing`,** with the unmet facts, one line each,
  in a new `fixture` field of the case result (additive to results.v1), for
  example `the catalog now holds hammock: 1 product, such as p-hammock-1`.
- **The gate does what §16 says:** a run with a `fixture-missing` case can't
  be judged, and exits with `2`, naming it. A proposed case doesn't gate, as
  before. The person updates the case, or removes it.
- **The reports say why.** The terminal, JUnit and HTML reports give the
  unmet facts as the case's reason.
- **`yokla run`, `shrink`, `explore` and `mcp` share the runner,** so all of
  them do it. Explore's own turns take their facts from the catalog of the
  run, so theirs are met.

### The snapshot, in the results

- **`run.data`** (additive to results.v1) lists every file the packs read
  for the run, as each pack's `PackIo` reads it:
  - its path, relative to the profile;
  - its SHA-256;
  - its rows: its non-empty lines, one per JSON Lines row;
  - its modification time.
- **Two runs on different data show it,** in the hash, before any verdict is
  compared.

### The demo-shop

- **The end-to-end test, at no model cost,** runs the acceptance cases on a
  copy of the demo-shop whose catalog has gained a hammock and lost its
  water bottles:
  - `hammock-en` and the water-bottle case are `fixture-missing`, each with
    its unmet fact;
  - the shop receives no request for them;
  - every other case keeps the status it has on the unchanged catalog;
  - the run exits with `2`, and names both cases;
  - `run.data` names the catalog, with the copy's hash and rows.
- **The pack's unit tests** check each fact both ways: met and unmet, with a
  type under the expected one by `typeSeparator`, and with no catalog.

## Consequences

- **A case the data outgrew no longer fails the target.** It stops the gate
  instead, with the fact that changed, for a person to update it.
- **Nothing is sent for it,** so a stale case costs nothing.
- **A written case can now stop a run that passed before,** when the catalog
  changes under it. That is the point: its verdict meant nothing.
- **The results say which data a run used.** Two runs differ in their
  catalog's hash when the data changed.
- **results.v1 gains `fixture` on a case and `run.data`,** additively.

## Alternatives considered

- **Pinning each case to its facts, with a new `requires` field.** The facts
  are already in the expectations; a second copy can disagree with them.
  Rejected.
- **Re-deriving the expectations at run time.** A written case's expectation
  is a person's statement, and changing it silently would change what was
  approved (ADR-0004). Rejected: the case is named, not rewritten.
- **Running the case, and marking it afterwards.** It costs the requests and
  the target's model calls, for a verdict that is thrown away. Rejected.
- **A filter's band as a fact,** such as "no tent under 500 TL". No check's
  verdict depends on it. Rejected.
- **Failing the case.** A failure says the target was wrong. Rejected, as
  §9 says.
