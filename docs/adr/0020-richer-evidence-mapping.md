# 0020. Richer evidence mapping: several paths, availability, price sources, component text

Status: Accepted · Date: 2026-11-13

## Context

The first real target, an open-source retail assistant, streams its answers
as text pieces and UI components (ADR-0016). Its v0.2 run showed four things
the profile can't yet say. Each is general: any target with components, or a
catalog without quantities, has them.

- **Products in several places.** A product card lists its products at one
  path; a comparison, a plan and its related products list theirs at others.
  An evidence collection takes one path, so the profile could map only the
  cards. A price quoted from a comparison then had nothing to be checked
  against.
- **Stock given only as available or not.** The target gives `in_stock`, a
  boolean. yokla's stock is a quantity, so mapping it would read every
  product's stock as unknown, and `stock-claim` would fail correct claims.
  The profile left stock out, and stock claims went unjudged.
- **Amounts from other data.** "You paid $24 in June, it's $29 today" was
  right: $24 is in the target's order history. `price-grounded` grounds
  amounts in product prices, campaigns, policy sources and the user's own
  numbers, so it failed the answer.
- **Answers given only as a component.** For some turns the target sent no
  text at all, only a card, a comparison or a plan with its own words: reasons,
  labels, details. The text checks saw an empty answer.

## Decision

### One collection, several paths

`evidence.<collection>.items` takes one JSONPath or a list of them. The items
of every path are read in order and share the collection's `fields`:

```yaml
evidence:
  products:
    items:
      - $.all.ui[*].payload.items[*].product
      - $.all.ui[*].payload.entries[*].product
      - $.all.ui[*].payload.steps[*].products[*]
    fields: { id: product_id, name: title, price: price, inStock: { from: in_stock, as: boolean } }
```

An item with the same `id` as one an earlier path returned is left out: the
same product in a card and in a comparison is shown once, not twice. Within
one path, a repeated item stays, so `no-duplicates` still sees an answer that
lists a product twice.

### Availability

The e-commerce pack gains the evidence field `inStock`, a boolean, beside the
quantity `stock`. The catalog may map it too (`fields.inStock`).

- **Known stock.** Stock is known when `stock` is a number, or when `inStock`
  is `true` or `false`.
- **In-stock claims.** An in-stock claim matches `stock > 0` or
  `inStock: true`.
- **Out-of-stock claims.** An out-of-stock claim matches `stock = 0` or
  `inStock: false`.
- **Quantities win.** When both are known and disagree, `stock` decides, and
  the finding says so.

### Price sources

`ecommerce.priceSources` lists further amounts an answer may quote, besides
product prices, campaigns and policy sources:

```yaml
ecommerce:
  priceSources:
    - { evidence: orders, fields: [price, total] }       # amounts the turn showed
    - { file: ./yokla-data/orders.json, paths: ['$[*].items[*].price', '$[*].total'] }
```

- **`evidence`:** a collection of the turn or an earlier turn, and the fields
  holding amounts.
- **`file`:** a data snapshot (JSON, or JSON Lines read as an array), and
  JSONPaths to the amounts in it. Like the catalog, it is the target's own
  data (ADR-0004).
- **What it grounds, and what it doesn't.** An amount from a price source
  grounds a quoted amount as a product price does. It doesn't make
  `price-grounded` apply: the check still needs a priced product in the
  conversation, so that a target answering from data yokla can't see isn't
  failed.

### Answer text from several paths

`response.text` takes one JSONPath, as today, or a list. With a list, every
string at every path is joined in order, with a blank line between them:

```yaml
response:
  text:
    - $.text
    - $.all.ui[*].payload.items[*].reason
    - $.all.ui[*].payload.entries[*].best_for
    - $.all.ui[*].payload.steps[*].label
```

- **One path, unchanged.** It still reads its first match, and a missing text
  is an answer without text.
- **A list.** It reads every match of every path. The answer has no text only
  when none of them has a string.
- **Which checks see it.** Every check that reads the answer reads the joined
  text, so a card's reasons are checked like the answer's sentences. The time
  to the first text (ADR-0016) still comes from the stream's text pieces.

## Consequences

- **The e-commerce checks see components.** On the open-source target, the
  e-commerce checks see the products of every component, judge availability
  claims, accept a price from the order history and read the words of a card.
  The profile changes; yokla's code knows nothing of the target (P9).
- **The schemas widen without breaking.** A profile written for v0.2 means the
  same thing.
- **A file of amounts grounds loosely.** An amount anywhere in an order
  history grounds a quoted amount, whoever's order it was. It is the
  target's own data and declared in the profile, but the check can't tell
  "your order" from "an order". The guide says so.
- **Joined text may join words that read oddly together,** such as a card's
  label next to a reason. The checks match concrete claims, not sentence
  flow, so this changes no verdict that a separate reading would not.

## Alternatives considered

- **Several collections instead of several paths,** such as `products` and
  `comparedProducts`. Every e-commerce check reads `products`, so each check
  would have to learn the other names. Rejected.
- **Converting a boolean into a quantity,** `true` as 1 and `false` as 0. A
  quantity of 1 would make "only one left" a correct claim. Rejected: a
  separate field says only what the data says.
- **Amounts from the text of tool results.** The stream carries tool results
  only as short, cut excerpts, and money parsed from free text grounds even
  more loosely than a data file. Rejected for now.
- **Leaving component-only answers to the evidence alone.** The products
  would be checked, but the words around them, a claim in a card's reason,
  would not. Rejected.
