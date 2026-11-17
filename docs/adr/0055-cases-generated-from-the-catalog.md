# 0055. Cases generated from the catalog: yokla generate

Status: Proposed · Date: 2026-11-17

## Context

Design §9 plans data generators for v0.4: "Generators live in packs. Each
generator emits cases whose expectations are computed, not guessed." Its
data-grounded list, from a catalog snapshot:

- a lookup of an existing product, which must show its authoritative price;
- a product type absent from the catalog;
- an empty price band of a type that exists;
- attribute filters;
- a comparison of two existing products;
- multi-turn carry-over: refining the filters, "the cheaper one";
- unknown stock: no in-stock or out-of-stock claim.

`yokla explore` already builds turns from the catalog (ADR-0044, ADR-0046):
a product by name, a type, the type under its median price, and the type
under its lowest price. It sends them, searches on from the answers, and
keeps a case only where it found something. A generator is the other half:
a fixed, reviewable set of cases with computed expectations, written before
anything is sent, that a person approves once and runs every time.

The maintainer chose all of §9's data-grounded kinds, and a command of their
own, `yokla generate`.

## Decision

### The command

- **`yokla generate --profile <file>`** reads the profile and the data its
  domain pack reads, and writes a case file. It sends nothing and calls no
  model.
- **Options:**
  - `--out <file>`, `cases/generated.yaml` next to the profile by default;
    it refuses to overwrite without `--force`;
  - `--per-kind <n>`, 2 by default: the most cases of each kind, in each
    language;
  - `--absent <language>:<words>`, repeatable, such as `en:hammock,kayak`:
    the types a shopper may ask for that the person expects absent.
- **Languages:** the profile's languages the pack has phrasings for, `tr`
  and `en`.
- **Determinism:** the same catalog and options write the same file.
- **Every case is `status: proposed`** (ADR-0004), with provenance `source:
  generator`, a new machine source. Its evidence names the catalog rows and
  values the expectation came from, such as `catalog JKT-001: color blue`.
  Nothing gates until a person approves it.
- **The summary** counts the cases by kind and language, and names each kind
  that wrote none, with why: no product has a name in the language, no type
  has two products, no attribute is mapped, no stock is unknown, no
  `--absent` word was given.

### The kinds

The e-commerce pack generates them. Types are chosen as explore chooses its
opening types (ADR-0046), and named by their words (ADR-0050). Products are
taken in catalog order, at most one per type. Amounts are written as the
language writes them (ADR-0048).

| Kind | Turns | Expectation |
|---|---|---|
| `lookup` | "Do you have the {name}?" | `evidence.products.includes: [id]`, `answerable: true` |
| `absent-type` | "Do you have any {word}?" | `absentType: {word}`, `answerable: true` |
| `empty-band` | "Do you have any {type} under {amount}?", the largest whole amount below the type's lowest price | `productType`, `filters.maxPrice` |
| `attribute` | "Do you have any {type} with {attribute} {value}?" | `productType`, `filters.attributes: {attribute: value}` |
| `comparison` | "Which is better, the {a} or the {b}?", two products of one type | `evidence.products.includes: [a, b]` |
| `refine` | "Do you have any {type}?", then "And under {amount}?", the type's median price | the second turn: `productType`, `filters.maxPrice` |
| `cheaper` | "Do you have the {name}?", then "Do you have anything cheaper?" | the second turn: `productType`, `filters.maxPrice: {its price}` |
| `unknown-stock` | "Is the {name} in stock?", a product whose catalog stock is null | `evidence.products.includes: [id]`, `answerable: true` |

- **The checks that read the catalog judge the rest,** as for any case:
  `price-grounded` the prices shown, `stock-claim` any stock claim, which for
  an unknown stock is a finding.
- **`absent-type` writes a word only when it is absent.** A word that is a
  level of a catalog type (ADR-0054), or a type label in its language
  (ADR-0050), is left out, and the summary says so.
- **`attribute` needs the catalog's attributes,** mapped by a new profile
  option, `ecommerce.catalog.fields.attributes`: the evidence field each
  filter names, and the catalog field that holds it, such as `color: color`.
  It takes a value that at least one product of the type has. The attribute
  and the value are written as the catalog writes them; the person rewords
  them when approving.
- **Each language has its own phrasings,** in the pack, beside explore's.

### Their facts

- **A generated case is fixture-missing like any other** when the catalog
  changes under it (ADR-0053).
- **The e-commerce pack states one more fact,** amending ADR-0053: each id a
  turn expects among the `products` evidence is in the catalog. A lookup of a
  product that left the catalog then sends nothing.

### The demo-shop

- **It answers the new kinds:**
  - a comparison of two named products shows both;
  - a stock question about a named product shows it;
  - a bare price bound, such as "And under 1,000 TL?", refines the type of
    the session's last search.
- **Its profile maps the catalog's attributes:** size, color and gender.
- **The end-to-end test, at no model cost:**
  - `yokla generate` with `--absent en:hammock --absent tr:hamak` writes
    every kind in both languages, the same file twice;
  - the cases load as proposed;
  - on the demo-shop without defects, every generated case passes;
  - each data defect fails a generated case of the kind meant for it:
    `fabricated-price` a `lookup`, `unknown-stock-claim` an `unknown-stock`,
    `absence-substitution` an `absent-type`, `filter-ignored` an
    `attribute`, and `type-padding` an `empty-band`;
  - nothing is contacted but the shop.

### Layers

- **`core`:** the `generator` machine source, and the pack's `generate`
  hook, which returns cases with their provenance. Core reads no keys (P7).
- **`packs/ecommerce`:** the kinds, their phrasings and the new fact.
- **`cli`:** `yokla generate`, its options, the file and the summary.

## Consequences

- **A target gets a reviewable suite from its own catalog,** with
  expectations nobody guessed, before anything is sent.
- **Explore and generate meet the same checks** from two sides: explore
  searches and keeps what failed, generate writes a fixed set to approve.
- **A generated case can still be worded badly,** most of all an attribute
  written as the catalog writes it. The person reads it before approving,
  as for every case yokla writes.
- **profile.v1 gains `ecommerce.catalog.fields.attributes`,** and cases gain
  the `generator` source, both additively.

## Alternatives considered

- **Generating inside `yokla init` or `yokla explore`.** Init proposes a
  profile, and explore keeps only what it found; mixing a fixed suite into
  either changes what they are for. Rejected: a command of its own.
- **A model to word the cases.** It would cost money, and the expectations
  come from the catalog anyway. Left to the paraphrase transforms (§9).
- **Absent types from a list in the pack.** A list of every product a shop
  doesn't sell has no end, and its words differ per shop. Rejected: the
  person names them, and yokla checks each is absent.
- **Translating attribute values.** The catalog's values are the only
  computed ones. Rejected: they are written as they are.
