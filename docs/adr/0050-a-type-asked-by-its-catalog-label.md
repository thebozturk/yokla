# 0050. A type asked by its catalog label

Status: Proposed · Date: 2026-11-17

## Context

ADR-0048 asks for a type by the words of its last path level. On a catalog
whose last level is the product type, such as `outdoor/camping/tent`, those
are the words a shopper uses. A wide run of `yokla explore` against a real
shop assistant's catalog showed that this is not always so.

- **The last level is sometimes a facet, not a type.** It can be a size, a
  material, a weight class or a fragment of a name, under a level that holds
  the type, as in `…/sleeping-bags/kids-sleeping-bag/junior` or
  `…/cookware/camping-cup/steel`.
- **The turn then asks for the facet alone,** such as "is there junior?".
  The expectation names only that path, so an answer that showed products
  those words fit, filed under other paths, failed
  `type-matched-or-disclosed`. A shopper who wrote those words would have
  accepted it. Four of the run's 28 kept cases were these
  false findings.
- **Slugs lose letters.** The words come without diacritics ("kafa lambasi"
  for "kafa lambası"), which no Turkish shopper writes on purpose.
- **No rule on the path tells a facet from a type.** One heuristic was
  measured on that catalog: use the deepest level whose words occur in most of
  its products' names.
  - **Too few types qualify.** For about seven in ten types, no level's words
    occur in half the products' names: plural paths, singular names, and
    book titles that never name their category.
  - **The facets qualify.** Size words do occur in the names of the products
    they size.
- **The catalog's owner knows.** The level that names the product type
  varies between catalogs, and even inside one. The export that writes the
  snapshot can name it, from the shop's own category names, with their
  letters.

## Decision

### A label field in the catalog

- **`catalog.fields.typeLabel`,** optional, names a field of each row that
  holds the words a shopper uses for the row's type, such as "Kafa Lambası"
  or "sleeping bag". Like `name`, it is one field, or one per language, such
  as `{ tr: type_label_tr, en: type_label_en }`.
- **yokla never derives it.** The profile's author fills it in the catalog
  export, from whichever level or name fits that catalog (P9). The analyzer
  may propose the field later (ADR-0047); this ADR doesn't.

### Intents ask by the label

When the profile sets `typeLabel`, the e-commerce pack's intents use it in
place of the last level's words, for the language of the turn.

- **A type's label is its rows' label.** When a type's rows hold more than
  one label, the most common one counts, and ties go to the first by name.
- **Types group by label.** As in ADR-0048, every catalog type whose label
  folds to the same words is in the group. The expectation lists them all,
  and the prices come from all their products.
- **`--types` counts distinct labels,** and the round-robin over the type
  tree's branches stays as ADR-0046 set it.
- **The turn writes the label as the catalog has it,** with its letters and
  case as the shop writes them, so "Kafa Lambası", not "kafa lambasi".
- **The basis names the label,** such as `type "uyku tulumu" (2 catalog
  types) at most 1849, its median price`.
- **No label falls back.** A type with no label in the turn's language is
  asked by its last level's words, as ADR-0048 does. Without `typeLabel`,
  nothing changes.

### The demo-shop

- **The catalog gains a facet type:** a type whose last level is a size,
  under a level that names the product, such as `outdoor/sleeping-bag/junior`.
  Its rows and the other sleeping bags' rows carry the label "sleeping bag"
  (en) and "uyku tulumu" (tr).
- **The end-to-end test:**
  - **With the label,** the turn that reaches that type asks for "sleeping
    bag". It states every sleeping-bag type, and on the correct shop no
    explored case fails.
  - **Without the label,** the same turn asks for "junior", as today.
  - **ADR-0044's, ADR-0046's and ADR-0048's criteria still hold.**

## Consequences

- **Fewer false findings on catalogs whose last level is a facet,** and turns
  that read as a shopper writes, with the shop's letters.
- **Work in the export.** Someone must choose the label per catalog. A
  catalog without it behaves as before.
- **Wider groups.** A label shared by a type and its subtypes, such as
  "sleeping bag" over adult and kids' sleeping bags, puts them all in one
  expectation. A target that shows any of them passes. A written case
  that names a path still tells them apart.
- **Amends ADR-0048** where a type is asked by its last level's words.

## Alternatives considered

- **Derive the level from product names.** Measured, it rejected most types
  and kept the facets. Rejected.
- **A profile option for the type's level,** such as `typeLevel: -2`. The
  right level varies inside one catalog. In the catalog that showed the
  problem, it is the last level for some types and the one above for others.
  Rejected.
- **A profile list of types explore skips.** It has to be kept by hand, and
  the skipped types are never asked. Rejected.
- **Accept the false findings,** since a person approves every proposed
  case (ADR-0004). They cost review time on every run and hide the real
  ones. Rejected as the only answer, kept as the fallback for catalogs
  without a label.
