# 0056. Type padding shows in a short result, not an empty band

Status: Proposed · Date: 2026-11-17

## Context

ADR-0055's end-to-end test expects each data defect to fail a generated case
of the kind meant for it, and names `type-padding` for an `empty-band` case.

Run on the demo-shop, the generated cases show otherwise. `type-padding`
fills a short result up with products of other types, presented as the
requested type. An `empty-band` case asks for a type under its lowest price,
so nothing matches, and the demo-shop answers an empty result by relaxing
the bound and saying so: there is no short result to fill. The `attribute`
cases fail instead. "Do you have any backpack with color black?" finds one
black backpack, and the defect fills the list with other black products as
backpacks; `type-matched-or-disclosed` fails it.

Every other expectation of ADR-0055's test held: without defects, all 30
generated cases pass, and `fabricated-price`, `unknown-stock-claim`,
`absence-substitution` and `filter-ignored` each fail the kind named for
them.

## Decision

- **The end-to-end test expects `type-padding` to fail an `attribute`
  case,** in place of an `empty-band` one. This amends ADR-0055.
- **The defect doesn't change.** Padding an empty result would be another
  defect, and the demo-shop's end-to-end tests rely on this one as it is.

## Consequences

- **ADR-0055's mapping now reads:** `fabricated-price` a `lookup`,
  `unknown-stock-claim` an `unknown-stock`, `absence-substitution` an
  `absent-type`, `filter-ignored` an `attribute`, and `type-padding` an
  `attribute`.
- **An empty band still has its defect:** `filter-ignored` fails it, since
  the dropped bound shows products over it.

## Alternatives considered

- **Padding relaxed results too.** It would make `empty-band` catch the
  defect, but changes what an existing defect seeds. Rejected.
- **Noting the outcome in design §19 only.** The accepted ADR's decision
  would then state an expectation the test doesn't hold. Rejected.
