# 0021. A price times a stated quantity, and text that belongs to one item

Status: Accepted · Date: 2026-11-13 · Amends 0020

## Context

With ADR-0020's mapping, the open-source target's components became visible,
and two of its correct answers failed.

- **A price times a quantity.** A plan said "Four sleeping bags, one per
  person … $356 for four". The bag costs $89, and 4 × $89 = $356.
  `price-grounded` accepts a product's price, a campaign, a policy source, a
  price source and the user's own numbers. It doesn't accept a price times a
  quantity, so it failed the answer.
- **Text that belongs to one item.** A comparison listed, for the espresso
  machine, "Espresso machine with steam wand, but $329 and currently out of
  stock". In the component, the line belongs to its entry. Joined into the
  answer text (ADR-0020), the line names no product, so `stock-claim` applied
  its claim to every returned product and failed the drip coffee maker, which
  is in stock.

ADR-0020 says of joined text that it "changes no verdict that a separate
reading would not". The second case shows that this is wrong. A line about one
item that doesn't name it loses its item once it is joined.

## Decision

### A price times a stated quantity

`price-grounded` also accepts an amount that equals a returned product's price
times a quantity stated in the same sentence.

- **What a quantity is.** An integer from 2 to 99, written in digits ("4
  bags", "x4") or as a number word of the case's language ("four", "dört").
  Each language pack lists its number words.
- **What isn't a quantity.** The money amounts of the sentence and its
  durations don't count, so "$89" offers no 89 and "14 days" no 14.
- **Which prices.** Only the prices of products returned in the conversation
  are multiplied. Campaigns, policy sources and price sources are not, since
  they are already totals or fees.
- **What the finding says.** It names the price and the quantity, for example
  "$356 = 4 × $89 (product AR-1203)".

### Text that belongs to one item

- **The rule.** `response.text` joins text that stands on its own: the answer's
  text pieces, a component's title, a plan's steps, a guide's sections. A line
  that belongs to one item stays out unless it names that item. Examples are
  a card's reason for one product, and a comparison's pros, cons or "best
  for".
- **Where it is said.** The guide says so where it documents the list.
- **The correction.** ADR-0020's consequence about joined text is corrected
  here. Joined text can change a verdict when a line about one item doesn't
  name it.
- **What stays as it is.** `stock-claim` keeps applying a claim that names no
  product to every returned product, as before. A claim of "all in stock"
  should still be judged against every product.
- **Later.** Text read per item, kept with its product, is the way to check
  these lines. It is left for later.

## Consequences

- **"$356 for four" passes, and the check stays narrow.** An amount that
  equals a price times some unrelated number of the sentence also passes. An
  example is a price times a temperature written as digits. That needs the
  product, the number and the amount to line up exactly, and the finding says
  which product and quantity it used.
- **A sum of several products still fails.** For example "the plan comes to
  $605.50". A total needs to know which products it adds up, and that is left
  for later.
- **Profiles keep per-item lines out of the answer text.** On the open-source
  target, a card's reasons and a comparison's notes are then not checked
  until per-item text exists.
- **Language packs gain number words,** tested in both directions like every
  marker list.

## Alternatives considered

- **Any multiple of a price.** Every amount with a price among its divisors
  would pass, so the check would ground almost anything. Rejected.
- **A quantity only in digits.** The answers that failed wrote "for four", so
  it would not fix them. Rejected.
- **Attributing an unnamed line to the item it came from, now.** The evidence
  and the text are read separately today, and joining them needs a design of
  its own. Deferred.
- **Stopping stock-claim from applying an unnamed claim to every product.**
  It would also stop judging "all of these are in stock" about products whose
  stock is unknown. Rejected.
