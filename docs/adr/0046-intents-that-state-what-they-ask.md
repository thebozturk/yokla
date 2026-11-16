# 0046. Intents that state what they ask, across the catalog's types

Status: Accepted · Date: 2026-11-16

## Context

ADR-0044 gave `yokla explore` domain intents: turns a pack builds from the
target's own data. A run against a real shop assistant with a large catalog
(tens of thousands of products in thousands of types, no model proxy)
showed three gaps.

- **An intent states nothing, so the data-backed checks can't judge it.**
  ADR-0044 reasoned that "an intent knows no right answer, so it states
  none". But an intent knows what it asked. It asked for a type and a price
  bound it took from the catalog. The search sent exactly such a turn, a
  type "under <amount> TRY", and the target answered with products over the
  bound as if they matched. `filter-honoured-or-disclosed` and
  `type-matched-or-disclosed` need `filters` and `productType` from the
  turn's expectation. Neither ran, and nothing was kept.
- **The opening intents use one type.** They take the catalog's first named
  product, its type and that type under its median price. With thousands of
  types the search asks about one of them. Seventeen of 64 runs were used:
  without a proxy only routes count, and state pruning (ADR-0044) leaves few
  states to try.
- **A candidate that isn't kept leaves no trace.** To see what the search
  asked and where each answer went, the messages had to be sent again by
  hand.

The defects the search missed were found that way: a price bound dropped
silently, a short result filled with other types under a "found" sentence,
and a matching product in stock left out. A written case found one of them;
the others sat on types no case asked about.

## Decision

### An intent states what it asked

An intent turn may carry an expectation, built by the pack from the same
data the turn's words came from (ADR-0004: from data, never from the
target's code or answer). It states only what the turn asked:

| Intent | Expectation |
|---|---|
| `type`: a type is asked for | `productType: [type]` |
| `under-price`: the type under its median price | `productType: [type]`, `filters.maxPrice` |
| `empty-band` (new): the type under its lowest price | `productType: [type]`, `filters.maxPrice` |
| `product`, `policy`, `cart`, `cheaper` | none, as before |

- **The checks judge it as they judge a written turn.** Showing other types,
  or products over the bound, fails unless the answer discloses it. An
  answer that shows nothing is not judged by them (`applicable: false`).
- **`empty-band`** asks for a type under the largest whole amount below its
  lowest catalog price. A bound is inclusive, so no product of the type can
  match it. The target must say so, or disclose what it offers instead.
  Where that amount would be below 1, the intent is left out.
- **Only the intent's own turn carries it.** A candidate built on top of a
  kept one drops the earlier turns' expectations, as ADR-0044 does for
  written cases, and `repeat` asks the message again without it. A failure
  is therefore kept once, not copied.
- **The proposed case keeps the expectation,** status `proposed`. Its
  provenance names the catalog type and the bound it came from, so the
  person approving it can see where it came from.
- **Core stays domain-free (P7).** An intent turn gains an optional
  `expect`, which core passes through without reading it. The pack's own
  schema validates it, as it does for a written case.

### Opening intents spread over the types

- **The pack chooses up to `--types <n>` types, 6 by default.** It takes
  them round-robin across the type tree's branches:
  - it groups types by their first level below the levels all types share
    (by the profile's `typeSeparator`);
  - within a group, it orders types by product count, then by name;
  - it takes one type from each group in turn, by group name, until it has
    `n`.

  The same catalog gives the same types. Without a `typeSeparator`, it takes
  the most-stocked types.
- **For each type, four opening turns:** a product of the type by name (the
  first with stock above zero, else the first), the type, the type under its
  median price, and the type under its lowest price. Policies are asked as
  before, once each.
- **Openings still run first,** before the operators of ADR-0044. With the
  defaults that is at most 24 runs plus the policies, which leaves room for
  the operators within the 64-run budget.

### Every candidate is traced

The exploration's results gain `run.exploration.candidates` (additive to
results.v1), one entry per candidate run, in order:

- `operator`, `from` (the pool conversation it went on from, or null);
- `messages`: the user turns it sent;
- `routes`: the route of each answer, where the profile maps one;
- `kept`: the id it was written under, or null;
- `reached` and `failed`, as for a kept candidate.

Answers are not copied there: the trace says where the search went, and
`prompts.store` and the HTML report still decide what of the answers is
kept.

### The demo-shop

- **A new defect, `type-bound-ignored`.** The price bound is dropped for
  sleeping bags, a type no written case asks about, while the answer still
  presents the products as matching.
- **The end-to-end test, without a model cost:**
  - with the defect, the acceptance cases pass, and the exploration keeps an
    `under-price` case for sleeping bags that fails
    `filter-honoured-or-disclosed`;
  - on the clean shop, no explored case fails, `empty-band` turns included:
    the shop discloses the relaxation;
  - ADR-0044's criteria still hold at the default budget: every route and
    tool is reached, and `cart-total-off` is still found;
  - the trace has one entry per candidate run, and two explorations write
    the same trace and cases.

## Consequences

- **The search can find the defects that need an expectation,** where the
  expectation is one the data gives: a type and a price bound. Defects that
  need a judgement about the answer still need a written case or a person.
- **Exploration spends more runs on openings:** about four per type. On a
  paid target `--types`, `--max-runs` and `--max-cost` bound it, and the
  estimate is printed first.
- **Proposed cases carry expectations a person didn't write.** They don't
  gate until a person approves them (ADR-0004), as before. The provenance
  names the data they came from.
- **Amends ADR-0044** where it says intents carry no expectation, and where
  the opening intents use only the first named product.

## Alternatives considered

- **Keep intents without expectations, and rely on the checks that need
  none.** That is ADR-0044. The real-target run shows its cost: the checks
  that would have failed never ran. Rejected.
- **Derive the expectation from the target's answer,** such as the type of
  the first product shown. That repeats whatever the target did, right or
  wrong, and breaks ADR-0004. Rejected.
- **Every type of the catalog.** It's exhaustive, but thousands of types
  would use the whole budget on openings. Rejected for a bounded, spread
  choice.
- **The most-stocked types only.** In a real catalog they often come from
  one branch, for example clothing sizes. Rejected for the round-robin over
  branches. It is kept as the fallback without a separator.
- **A random sample of types.** It would spread too, but two explorations
  would differ, which breaks ADR-0044's determinism. Rejected.
- **Tracing answers too.** That duplicates what the results and the HTML
  report already decide to keep, and would put answer text where
  `prompts.store` doesn't reach. Rejected for messages and routes.
- **Natural amounts and type labels** ("2000 TL" rather than "2000 TRY",
  "kamp ocağı" rather than "kamp ocagi"). They make turns more realistic, but
  they are separate questions. Left to a later decision. The currency code
  even found a defect that "TL" didn't.
