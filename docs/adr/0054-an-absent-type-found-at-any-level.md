# 0054. An absent type is found at any level of a catalog type

Status: Proposed · Date: 2026-11-17

## Context

ADR-0053 makes a case `fixture-missing` when the catalog no longer holds a
fact its expectations state. For `absentType: T`, the fact is unmet when "a
product's type is `T`, or under it by `typeSeparator`".

An absent type is named as a shopper names it, not as a catalog path. The
demo-shop's cases expect `absentType: hammock` and `absentType: sleeping-pad`,
while its catalog's types are paths such as `outdoor/camping/tent`. A hammock
added to that catalog would be `outdoor/camping/hammock`: neither `hammock`
nor under it. ADR-0053's rule would miss it, and the case would fail a right
answer, which is what ADR-0053 is for.

## Decision

- **`absentType: T` is unmet** when a product's type:
  - is `T`;
  - is under `T` by `typeSeparator`; or
  - has `T` as one of its levels by `typeSeparator`, such as `hammock` in
    `outdoor/camping/hammock`.
- **Without a `typeSeparator`,** only a type equal to `T` counts, as before.
- **`productType` doesn't change.** It names catalog types (ADR-0046), so a
  type equal to it or under it is what holds it.
- **The pack's unit tests** check a level at the end of a path, in the middle
  of one, and a word that is only part of a level, such as `hammock` in
  `outdoor/camping/hammock-stand`, which doesn't count.
- **The demo-shop's end-to-end test** adds the hammock as
  `outdoor/camping/hammock`.

## Consequences

- **A stale absent type is found in a catalog of paths,** as shoppers' words
  and catalog levels usually meet.
- **A level shared by many types counts for all of them.** `absentType:
  outdoor` is unmet by any outdoor product, which is right: the catalog holds
  outdoor products.

## Alternatives considered

- **Matching the type labels too (ADR-0050).** A label is free text, in a
  language and a number ("hammocks", "hamak"), and matching it needs the
  language pack's folding. Left out: the levels catch the case at hand.
- **A substring of the type.** `hammock` would match `hammock-stand`, a
  different product. Rejected.
