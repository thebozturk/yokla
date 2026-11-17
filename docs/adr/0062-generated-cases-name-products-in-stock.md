# 0062. Generated cases name products in stock

Status: Proposed · Date: 2026-11-17

## Context

`yokla generate` (ADR-0055) takes the first product of a type, in catalog
order, for the kinds that name one. Explore's opening turns (ADR-0044)
take the first one in stock instead.

On the private target, with its model on, 15 generated cases (lookup,
comparison, cheaper) failed 6 times. Four of the six named a product with
stock 0.

- **The target was right each time.** It said the product was not in stock
  and showed in-stock alternatives, or left the product out of a
  comparison. The cases expected the product among the evidence
  (`evidence.products.includes`).
- **A cheaper follow-up took the wrong bound.** The case bounded the second
  turn by the named product's price. The shopper never saw that product,
  and the target bounded the turn by the cheapest product it had shown, as
  it said.

A case that names a product it expects to see shown has to name one the
target can show.

## Decision

### Which product a kind names

- **A product in stock.**
  - With a quantity, its stock is above 0. Without one, `inStock` is true.
    The quantity decides when both are given, as in `stock-claim`
    (ADR-0020).
  - A catalog that maps neither stock nor `inStock` leaves yokla unable to
    tell, so every product counts, as today.
- **The kinds:** `lookup`, `comparison` (both products), `cheaper` (the
  named product) and `attribute` (the product whose value is asked for).
  `unknown-stock` keeps naming a product whose stock is unknown: that is
  what it is for.
- **Still in catalog order,** among the products in stock. A type with
  none gives no case of that kind, and the kind's "none" line says "in
  stock".

### What the case says

- **Its basis gives the stock it was named by,** such as `catalog TNT-001:
  "Kubbe Çadır 2 Kişilik", 2499.9 TRY, stock 12`, so the person who
  approves it can see why.

### The measure

- **Unit tests,** both ways for each kind: a type whose first product has
  stock 0, null or `inStock` false names its first product in stock; a
  type with none gives no case; a catalog without stock names the first
  product, as before.
- **The demo-shop end to end:** every generated case still passes without
  a defect, and each defect still fails the kind meant for it. Only the
  comparisons change: their second products had unknown stock (TNT-002,
  BPK-002) and become the next ones in stock (TNT-003, BPK-003).
- **The private target, offline:** the cases generated again from the same
  catalog name no product with stock 0.

## Consequences

- **A lookup, comparison or cheaper case no longer expects a product the
  target can't show.** Its failure is the target's again.
- **Asking for a product that is out of stock is no longer generated.** A
  shopper does ask for one. What an honest answer must hold then, such as
  a stock claim and no card, needs an expectation the cases don't have; it
  is left to a later kind.
- **A product that runs out after the cases are generated** still exists,
  so ADR-0054 doesn't flag the case as stale. Its lookup may then fail on a
  target that hides out-of-stock products. Generating again picks another.

## Alternatives considered

- **Prefer a product in stock, else the first one,** as explore does. A
  type with no product in stock would still give a case that expects an
  out-of-stock product. Rejected: no case is better than a wrong one.
- **Keep the product, and drop the `includes` expectation when it is out of
  stock.** A lookup would then check nothing of its own. Rejected.
- **Treat an out-of-stock product as a stale fact (ADR-0054).** Some
  targets show out-of-stock products with a label, so `includes` doesn't
  imply stock. Rejected: it isn't a fact the expectation holds.
