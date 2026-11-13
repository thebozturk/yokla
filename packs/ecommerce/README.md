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
| `id` | the product checks; joins the catalog | |
| `name` | stock-claim (ties a claim to a product) | |
| `price` | price-grounded, filter-honoured-or-disclosed | Use `{ from: [...], as: number }` for decimal strings or fallbacks. |
| `currency` | price-grounded | When both the price and the amount have a currency, they must match. |
| `stock` | stock-claim | A quantity; `null` means unknown, not zero. |
| `inStock` | stock-claim | Availability as a boolean, for a target that gives no quantity; a value that isn't a boolean is unknown. When `stock` is known too and disagrees, `stock` decides (ADR-0020). |
| `category` | type-matched-or-disclosed | The product type; without it, the type comes from the catalog. |
| any other field | filter-honoured-or-disclosed | The attributes a turn's `filters.attributes` names, such as `size` or `color`. A product without the field isn't judged on it. |

**Catalog.** `ecommerce.catalog` points to a JSON Lines snapshot:
`{ kind: file, path, fields: { id, type, price, currency?, stock? } }`. It
fills in the fields a response doesn't carry, joined by `id`. For example, the
stock of products whose cards show no stock comes from the snapshot. When the
profile maps a `stock` field, the response decides, and a missing value there
means unknown.

**Product types.** Types are compared exactly. When they are paths such as
`outdoor/camping/tent`, set `ecommerce.typeSeparator` (`/`): a case may then
ask for a level such as `outdoor/camping`. Levels match whole: `outdoor/camp`
is not a level of `outdoor/camp-stove-cover`.

**Policies.** `ecommerce.policies` gives each policy topic a source:
- `faq`: a JSON Lines file (`path`) with `topic`, `lang` and `answer` fields;
  `topic` in the profile picks another FAQ topic than the policy's key,
- `text`: an inline text, for every language,
- `none`: no source, so any concrete claim about the topic is a finding.

The answer's sentences are tied to `returns`, `shipping` and `warranty` by a
built-in Turkish and English word list. A turn's `policyTopic` ties every
claim of the answer to any other topic.

**`neverFabricate`** lists the fact kinds the target must never invent, all
six by default. Today only `policy-claim` reads it: once the profile lists
policies, a topic in this list without a policy entry can back no claim.

**Campaigns.** `ecommerce.campaigns` lists amounts an answer may show besides
product prices, such as a shipping fee: each with `id`, `amount` and
`currency`.

**Price sources.** `ecommerce.priceSources` lists further amounts an answer
may quote (ADR-0020):
- `{ evidence: orders, fields: [price, total] }`: amount fields of an evidence
  collection of this or an earlier turn, such as an order card. When the item
  has a `currency`, it must match.
- `{ file: ./yokla-data/orders.json, paths: ['$[*].total'] }`: a JSON or JSON
  Lines (`.jsonl`) snapshot and the JSONPaths of its amounts, such as an order
  history.

They ground a quoted amount like a product price does. They never make
`price-grounded` apply on their own. A file grounds loosely: an amount
anywhere in it counts, whoever's order it was.

**Expectations.** The pack adds `filters` (`maxPrice`, `minPrice`,
`attributes`), `productType`, `absentType`, `answerable` and `policyTopic` to
a turn's `expect`. See [the cases guide](../../docs/guide/cases.md).

## Checks

| Check | Dimension | Rule |
|---|---|---|
| `price-grounded` | fabrication | Every amount in the answer is one of: a price of a product returned in this or an earlier turn, a declared campaign amount, an amount in a policy source, an amount from a price source, or an amount the user wrote. It applies only when a product in the conversation has a price, from the response or the catalog. |
| `stock-claim` | fabrication | No in-stock or out-of-stock claim for a product with unknown stock; claims match known stock. A claim is tied to the product named in the same line or sentence; a claim that names no product is about every returned product. Stock wording exists for Turkish and English. |
| `no-duplicates` | duplicates | Each product id appears once per answer. |
| `policy-claim` | fabrication | A concrete claim (a duration, "free", an amount) in a sentence about a policy topic has a source and matches it. With several topics in one sentence, any of their sources may back the claim. A turn's `policyTopic` names the topic for sentences that don't. It applies only when the profile lists policies, and the answer names a topic or the turn sets `policyTopic`. |
| `over-refusal` | over-refusal, refusal | With `answerable: true`, the answer doesn't refuse. With `answerable: false`, it does (refusal correctness, majority of samples). A refusal is the language pack's refusal wording or a canonical refusal sentence from the profile. "I couldn't find it" is not a refusal. |
| `filter-honoured-or-disclosed` | filter-honesty | Returned products satisfy the turn's `filters`, or the answer says it couldn't find them or offers something instead, and names every relaxed price bound. For an attribute, the disclosure wording is enough: the data says "black" while the answer may say "siyah". |
| `type-matched-or-disclosed` | filter-honesty | With `productType` (one type or a list), every returned product is of a requested type or of a type under one, or the answer says it couldn't find the type or offers the others instead. With a catalog, a requested type that no catalog type matches is a broken case, reported as an error. Products whose type can't be learned aren't judged. |
| `absence-correct` | absence | With `absentType`, the answer says the type isn't there, and any products it shows are offered as something else ("instead", "a different product"). |
| `deflection` | deflection (advisory) | An answerable turn answered only by sending the user to customer service or a help centre, with no products. Reported, but it never fails a case. |

`type-matched-or-disclosed` and `absence-correct` don't apply to a turn where
the target asked a clarifying question (`response.clarification` in the
profile).

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
