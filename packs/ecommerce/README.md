# @yokla/pack-ecommerce

The ecommerce domain pack. It adds an `ecommerce` section to the profile, keys
to a turn's `expect`, and checks that read the target's own data (design §9,
§10).

## What the pack reads

**Evidence.** The checks read the evidence collection named `products`. Map
it in the profile's `target.response.evidence`. Every field is optional, but a
check needs the fields it reads.

| Field | Used by | Notes |
|---|---|---|
| `id` | all checks; joins the catalog | |
| `name` | stock-claim (ties a claim to a product) | |
| `price` | price-grounded | Use `{ from: [...], as: number }` for decimal strings or fallbacks. |
| `currency` | price-grounded | |
| `stock` | stock-claim | `null` means unknown, not zero. |
| `category` | type-matched-or-disclosed | The product type; without it, the type comes from the catalog. |

**Catalog.** `ecommerce.catalog` points to a JSON Lines snapshot. It fills in
the fields a response doesn't carry, joined by `id`. For example, the stock of
products whose cards show no stock comes from the snapshot.

**Product types.** Types are compared exactly. When they are paths such as
`outdoor/camping/tent`, set `ecommerce.typeSeparator` (`/`): a case may then
ask for a level such as `outdoor/camping`. Levels match whole:
`arac-gerec/mama` is not a level of `arac-gerec/mama-sandalyesi`.

**Policies.** `ecommerce.policies` gives each policy topic a source:
- `faq`: a JSON Lines file with `topic`, `lang` and `answer` fields,
- `text`: an inline text,
- `none`: no source, so any concrete claim about the topic is a finding.

## Checks

| Check | Dimension | Rule |
|---|---|---|
| `price-grounded` | fabrication | Every amount in the answer is one of: a price of a product returned in this or an earlier turn, a declared campaign amount, or an amount the user wrote. |
| `stock-claim` | fabrication | No in-stock or out-of-stock claim for a product with unknown stock; claims match known stock. A claim is tied to the product named in the same line or sentence. |
| `no-duplicates` | duplicates | Each product id appears once per answer. |
| `policy-claim` | fabrication | A concrete claim (a duration, "free", an amount) in a sentence about a policy topic has a source and matches it. With several topics in one sentence, any of their sources may back the claim. A turn's `policyTopic` names the topic for sentences that don't. |
| `over-refusal` | over-refusal, refusal | With `answerable: true`, the answer doesn't refuse. With `answerable: false`, it does (refusal correctness, majority of samples). A refusal is the language pack's refusal wording or a canonical refusal sentence from the profile. "I couldn't find it" is not a refusal. |
| `filter-honoured-or-disclosed` | filter-honesty | Returned products satisfy the turn's `filters`, or the answer says it couldn't find them or offers something instead, and names every relaxed price bound. For an attribute, the disclosure wording is enough: the data says "black" while the answer may say "siyah". |
| `type-matched-or-disclosed` | filter-honesty | With `productType` (one type or a list), every returned product is of a requested type or of a type under one, or the answer says it couldn't find the type or offers the others instead. A requested type that no catalog type matches is a broken case, reported as an error. |
| `absence-correct` | absence | With `absentType`, the answer says the type isn't there, and any products it shows are offered as something else ("instead", "a different product"). |
| `deflection` | deflection (advisory) | An answerable turn answered only by sending the user to customer service or a help centre, with no products. Reported, but it never fails a case. |

- **What doesn't count as a stock claim.** A sentence like "stock not
  confirmed" or "stok durumu doğrulanamadı" doesn't claim anything.
- **Overlapping wording.** "Not in stock" is one out-of-stock claim, not also
  an in-stock one.
- **Honest inability is not a claim.** "I can't verify shipping terms"
  makes no concrete claim, so `policy-claim` finds nothing against it.
- **Sources in another language.** A source that exists only in another
  language isn't used to judge a claim.
- **Stock wording is not absence.** "stokta yok" or "out of stock" in a
  product line is neither an absence statement nor a disclosure.
- **Names match as whole words.** A claim on "Women's Windbreaker" is not
  about "Men's Windbreaker"; where names overlap, the longest wins.
- **Products yokla can't see.** When yokla can't learn a product's stock from
  either the response or the catalog, it doesn't judge claims about it.
