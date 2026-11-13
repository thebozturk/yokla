# 0022. A total of the answer's own amounts

Status: Proposed · Date: 2026-11-13

## Context

On the open-source target, a shopping plan listed its items with their
prices: a tent at $219, four sleeping bags at $89 each for $356, and a stove at
$64.50. It then said that "adding it takes the list to $639.50". That is right:
$219 + $356 + $64.50 = $639.50. `price-grounded` failed it.

ADR-0021 foresaw this. A sum of several products still fails, because a total
needs to know which products it adds up. Here the answer says so itself: every
part of the total is an amount it already stated, and each part is grounded.

A rule that adds up every earlier amount in order doesn't work. The answer
also states the user's budget ($600) and a unit price ($89), and neither is
part of the total.

## Decision

`price-grounded` also accepts an amount that equals the sum of two or more
other amounts of the same answer, each grounded on its own.

- **The parts.** An amount counts as a part when another rule grounds it: a
  returned product's price, a price times a stated quantity (ADR-0021), a
  campaign, a policy source or a price source (ADR-0020).
- **What isn't a part.**
  - The user's own amounts are not parts: a budget is not part of a total.
  - An amount grounded only as a sum is not a part of another sum.
  - Each stated amount is used at most once in a sum.
- **Where the parts may be.** Anywhere in the answer, before or after the
  total, so "Total $639.50: tent $219, …" counts too.
- **Currency.** The parts and the total must agree in currency when they
  state one.
- **A bound.** Only the first twelve parts of an answer are combined. With
  more, an amount that matches no sum of those twelve is judged as before.
- **The finding.** It names the parts, for example "$639.50 = $219 + $356 +
  $64.50".

## Consequences

- **Plans, carts and comparisons can state totals.** The plan's "$639.50"
  passes.
- **The rule is looser than a single price, by design bounded.**
  - Any sum of the answer's grounded amounts passes. An invented amount that
    happens to equal such a sum, to the cent, passes too.
  - With twelve parts at most, an answer has at most 4,083 sums of two or
    more parts.
  - The finding shows which parts it added, so a person can check it.
- **Differences and discounts still fail.** "$5 more than in June" and "20%
  off, now $23.20" are left for later.
- **A total of products the answer doesn't price still fails.** "The four
  items come to $606" has no stated parts to add up.

## Alternatives considered

- **Adding up every earlier amount, in order.** The budget and the unit price
  break it, as the plan showed. Rejected.
- **Sums of the returned products' prices, with any quantities.** The answer
  might add up any products in any numbers, so nearly every amount would pass.
  Rejected.
- **Sums only of amounts stated before the total.** It misses a total stated
  first, a common way to write a summary. Rejected.
