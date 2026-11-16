# 0048. Intents ask as a shopper names things

Status: Accepted · Date: 2026-11-16

## Context

ADR-0046 made `yokla explore`'s opening turns state the type and price bound
they ask, spread over the catalog's types. A free run against a real shop
assistant (no model proxy, a catalog of thousands of types) kept 13
candidates, all failing a check, where ADR-0044's search had kept none. Two
things were wrong with how the turns asked, not with the target.

- **A type is asked by words that more than one type shares.** The pack
  writes a type as the words of its last level, so a catalog with
  `…/baby-wipes/general` and `…/newborn-wipes/general` asks "general" for
  either. The expectation then named the one path the words came from, and
  an answer that showed a product of the other path failed
  `type-matched-or-disclosed`. The shopper's words can't tell them apart, so
  the answer was right. In that catalog, about four in ten last-level names
  belong to more than one path. Two of the 13 kept cases were these false
  findings.
- **Amounts are written with the currency code,** such as "300 TRY".
  Shoppers write "300 TL" or "₺300". The target dropped a bound written
  with the code, and that one defect made 11 of the 13 kept cases: every
  price turn of every type failed for the same reason. Asked with "TL",
  the same turns kept their bounds, and other defects behind them could
  show. The code is still worth one question, since it found a real defect.

## Decision

### A type is the words a shopper says

- **The expectation lists every catalog type with the same words.** An
  intent that asks for "general" states `productType` as all the types
  whose words are "general", in catalog order. An answer that shows a
  product of any of them matches.
- **The prices come from all of them.** The median and the lowest price are
  taken over the products of every type with those words. So no product of
  any of them meets the empty band.
- **Types are chosen by their words.** `--types` counts distinct words: when
  a type's words were already chosen, the round-robin of ADR-0046 skips it
  and goes on to the next type. A group's branch, count and name are those
  of its type that comes first in the round-robin.
- **The basis names the words and how many types they cover,** such as
  `type "general" (2 catalog types) at most 49, below its lowest price
  49.99`.

### Amounts as a shopper writes them

- **The e-commerce pack's phrasing for each language writes an amount in
  its usual unit,** by currency code:

  | Language | TRY | USD | EUR | GBP | another code |
  |---|---|---|---|---|---|
  | tr | `300 TL` | `300 dolar` | `300 euro` | `300 sterlin` | `300 <code>` |
  | en | `300 TRY` | `$300` | `€300` | `£300` | `300 <code>` |

  English shoppers have no word of their own for the lira, so the code stays.
- **One turn per language asks with the code,** where the usual unit
  differs from it: the first chosen type under its median price, written
  `<amount> <code>`, as intent `currency-code`. It states the same
  expectation. It runs after the other opening turns, so it doesn't cost the
  types their runs.

### The demo-shop

- **The end-to-end test:**
  - the catalog gains a second type whose last level is the same words as
    an existing type's, under another branch; a turn that asks for those
    words states both types, and on the correct shop no explored case fails;
  - the Turkish under-price turns write `TL`, and one `currency-code` turn
    per language writes `TRY`;
  - ADR-0044's and ADR-0046's criteria still hold.

## Consequences

- **Fewer false findings on catalogs with repeated names.** The expectation
  matches what the shopper could have meant.
- **A looser expectation.** A target that shows the "wrong" one of two
  same-named types passes. Telling them apart needs a written case that
  names the path, or words that differ.
- **One defect no longer fills the proposed cases.** A target that can't
  read a currency code fails once per language, not once per price turn.
- **Amends ADR-0046** where the expectation names one type, where the
  prices come from that type alone, and in how amounts are written.

## Alternatives considered

- **Ask by the full path's words,** such as "baby wipes general". No
  shopper says that, and the turn would test parsing of an odd phrase, not
  the catalog. Rejected.
- **Skip types whose words are shared.** That leaves out about four in ten
  names in the catalog that showed the problem. Rejected.
- **Let `type-matched-or-disclosed` accept siblings by last level.** It
  would loosen the check for written cases too, whose writers name a path
  on purpose. Rejected: the intent states what it asked.
- **Keep the code, and add the usual unit as a variant.** Every price turn
  would then fail twice on a target that can't read the code. Rejected for
  the usual unit, with one code turn per language.
- **A currency table in core.** Core knows no language (P7). The phrasing
  belongs to each language's set in the pack, as the templates do.
