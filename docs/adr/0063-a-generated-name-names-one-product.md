# 0063. A generated name names one product, and "cheaper" has an answer

Status: Proposed · Date: 2026-11-18

## Context

After ADR-0062, the private target ran the same 15 generated lookup,
comparison and cheaper cases again, with its model on: 12 passed. Two
things in the run were yokla's.

- **A name that two products hold.** Two of the products named were
  colour or pack variants whose catalog name is the very name of another
  product. A shopper's message can't say which one is meant, so an
  `evidence.products.includes` of one id passes or fails by luck. In one
  comparison the target showed another brand's product of the same size
  instead. ADR-0061 already refuses such a name when it binds a
  stock claim.
- **A cheaper follow-up with nothing to show.** In 4 of the 5 cheaper
  cases, the named product was the cheapest in stock of its own catalog
  type. The target said so, truthfully, and showed no product.
  `filter-honoured-or-disclosed` had nothing to read, so the second turn
  measured nothing, and a target that wrongly said "nothing cheaper" would
  have passed the same way. The demo-shop's cheaper cases are the same:
  TNT-001 and BPK-001 are the cheapest in stock of their types.

## Decision

### A name that no other product holds

- **`lookup`, `comparison`, `cheaper` and `unknown-stock` name a product
  whose name, in the case's language, no other catalog product holds.**
  - Names are compared in the language's lower case, with runs of spaces
    as one.
  - A name that is the start of a longer one, such as "Kubbe Çadır" and
    "Kubbe Çadır 2 Kişilik", still names one product.
  - A name shared only in another language doesn't count against this
    one.
- **`attribute` is unchanged:** its message names a type and a value, not
  a product.

### A cheaper follow-up that has an answer

- **`cheaper` names a product with a cheaper one in stock of the same
  catalog type.** Of those, the first in catalog order that the other
  rules allow (ADR-0062, and the name above).
- **The second turn also expects a product shown:**
  `evidence.products.min: 1`, beside its `productType` and `maxPrice`. The
  catalog holds one, so an answer that shows nothing fails
  `evidence-count`, and an answer that shows products is judged by
  `filter-honoured-or-disclosed` as before.
- **Its basis names the cheaper product,** such as `…, at most its price;
  TNT-001 is cheaper and in stock`.

### The measure

- **Unit tests, both ways:**
  - a name another product holds is skipped by each of the four kinds,
    whatever its case;
  - a longer name that starts with it, or the same name in another
    language, doesn't make it shared;
  - `cheaper` skips the cheapest product in stock of its type, and one
    whose cheaper product is out of stock;
  - the second turn carries `min: 1`.
- **The demo-shop end to end:**
  - every generated case passes without a defect, and each defect still
    fails the kind meant for it;
  - the cheaper cases move from TNT-001 and BPK-001 to TNT-003 and
    BPK-003;
  - each cheaper second turn shows a product.
- **The private target, offline:** in the cases generated again, no named
  product shares its name, and every cheaper product has a cheaper one in
  stock of its type.

## Consequences

- **An `includes` expectation names a product the message can name.**
- **A cheaper case measures its follow-up.** A target that says nothing is
  cheaper, when its own catalog type has something, fails.
- **"Same type" is the catalog type, not the word group the case asks
  by.** A target that looks across the group may show a product of
  another type of that group; `filter-honoured-or-disclosed` reads its
  price, and the case still passes if one is shown.
- **Fewer products can be named.** A catalog of colour variants that share
  one name gives fewer lookups; the "none" line says why.

## Alternatives considered

- **Require that no other name contains the name.** Most catalogs list a
  product beside its larger variants ("… 2 Kişilik"), so most names would
  be refused. Rejected: a full name written out names its own product.
- **Keep `cheaper` as it is, and add `min: 1` only.** For the cheapest
  product in stock of a type, "nothing cheaper" is the right answer, and
  the case would fail it. Rejected.
- **A cheaper product anywhere in the word group.** The target that said
  "nothing cheaper in the same category" was right by its own type, which
  the word group is broader than. Rejected: the case's demand must hold
  within the narrower scope.
