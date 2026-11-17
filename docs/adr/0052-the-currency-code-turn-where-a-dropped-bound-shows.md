# 0052. The currency-code turn where a dropped bound shows

Status: Accepted · Date: 2026-11-17

## Context

ADR-0048 adds one turn per language that writes an amount with the currency
code, at the first chosen type's median price. A later run against a real
shop assistant that drops a bound written with the code showed two things.

- **The turn passed although the target dropped the bound.** The target
  showed the type's products without the bound, and the first ones it
  showed happened to cost less than the median. Nothing over the bound
  reached `filter-honoured-or-disclosed`. Asked by hand, other types with
  the code still showed products over the bound.
  - **Why the median is weak here:** about half the products of a type are
    under it, so a target that drops the bound can still show only products
    under it. Which ones it shows first depends on its own ranking.
- **Near types fail `type-matched-or-disclosed`.** With catalog labels
  (ADR-0050), about a third of the run's kept cases showed a product of a
  near type, as a trail-running shoe for "hiking shoe" would be. A shopper
  would accept these.
  - **No general rule separates them from real failures.** In that catalog,
    accessories share a branch with the type they serve, as near types
    share one with each other: tent footprints would sit by tents as trail
    shoes sit by hiking shoes. An accessory's label holds its type's words,
    such as "tent footprint", as a near type's does.
  - **A rule that would pass the trail shoe passes the footprint.** Showing
    accessories for the type asked is a real defect, which written cases
    had already found.

## Decision

### The code turn asks at the lower quartile

- **The bound is the first chosen type's lower quartile price,** rounded up
  to a whole amount: the price at a quarter of the way up its products'
  prices, the lowest first, taking the lower one where it falls between
  two.
  - **Its effect:** about three quarters of the products cost more than the
    bound. A target that drops the bound and shows a few of the type's
    products shows one over it unless its ranking favours the cheapest
    quarter.
  - **It stays non-empty.** At least one product meets the bound, so an
    honest answer can show products.
- **Everything else stays as ADR-0048 set it:** one turn per language where
  the usual unit differs from the code, after the other opening turns, the
  same expectation and the intent `currency-code`. Its basis reads
  `… at most 900, its lower quartile price, with the currency code TRY`.
- **The under-price turns keep the median,** since their purpose is a band
  that holds about half the type.

### Near types stay a finding

- **`type-matched-or-disclosed` and the intents are unchanged** for near
  types. No path or label rule tells a near type a shopper accepts from an
  accessory they don't.
- **The catalog's owner groups them.** Types with the same label are one
  group (ADR-0048, ADR-0050), so the export that writes the label can give
  every type a shopper treats as one the same label, such as each kind of
  hiking shoe. The guide says so.

### The demo-shop

- **A new defect, `currency-code-ignored`:** the shop drops a price bound
  written with the currency code, in both languages.
- **The end-to-end test:**
  - **With the defect,** the Turkish `currency-code` turn fails
    `filter-honoured-or-disclosed`. At the median it would pass: the
    shop's three cheapest products of the type cost less than the median.
  - **Without it,** the turn passes.
  - **ADR-0044's, ADR-0046's, ADR-0048's and ADR-0050's criteria still
    hold.**

## Consequences

- **A target that can't read a currency code fails the code turn** unless
  its ranking hides it.
- **Near types remain false findings** on catalogs whose labels are fine
  grained. The owner removes them in the export, or a person dismisses
  them when approving proposed cases (ADR-0004).
- **Amends ADR-0048** in the bound of the `currency-code` turn.

## Alternatives considered

- **Ask the code turn at the empty band.** Every product the target shows
  would then fail it, but so would a target that reads the code and pads an
  empty band with other products. The turn would no longer say which
  defect it found. Rejected.
- **A code turn for every type.** One defect would again fill the proposed
  cases (ADR-0048). Rejected.
- **Accept products whose path shares the type's branch, or whose label
  contains the asked words.** That would pass the footprints with the trail
  shoes. Rejected.
- **Report near types as advisory instead of failing.** The same rules
  would decide what is near, so the footprints would become advisory too.
  Rejected.
