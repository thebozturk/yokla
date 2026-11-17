# 0061. Negated stock wording, and products the answer only names

Status: Proposed · Date: 2026-11-17

## Context

On the private target, with its model on, 15 generated cases (lookup,
comparison, cheaper) ran 20 turns. `stock-claim` reported 15 passes and 5
not applicable. One answer gave a product's full name and said, in
Turkish, that it "şu an stokta değil" (is not in stock right now), then
offered similar products that were.

The named product is in the catalog with stock 0, so the claim is true. It
was not returned: the answer showed eight in-stock alternatives instead.
`stock-claim` said "no stock claims".

Two gaps hide behind that pass.

- **Negation outside the phrase is not read.** The ecommerce lexicon,
  measured on its own lists:

  | Wording | Read as |
  |---|---|
  | "stokta değil", "stokta bulunmuyor", "stokta bulunmamaktadır" | nothing |
  | "stoklarımızda mevcut değil" | in stock |
  | "hemen teslim edilemiyor" | in stock |
  | "isn't in stock", "no longer in stock" | in stock |
  | "not available now", "not ready to ship" | in stock |
  | "currently not in stock" | out of stock (right) |

  Only the last is right: "not in stock" is listed, and a match inside a
  longer one doesn't count. Turkish puts its negation after the phrase, and
  English contractions put it in a word of their own. A negated in-stock
  phrase read as in stock fails a true answer about a product with stock 0
  as a fabrication, at high severity.
- **A claim about a product that wasn't returned spreads.** A claim binds to
  a returned or seen product named in its sentence (ADR-0026, ADR-0027); a
  sentence that names none applies to every returned product. The sentence
  above names a product, just not one of those. With the negation read, it
  would fail all eight alternatives as "claims … is out of stock, but stock
  is N".

## Decision

### Negated wording

- **Listed negated forms are out-of-stock claims.** The out-of-stock lists
  gain them, and the longest match decides, as with "not in stock" today:
  - Turkish: "stokta değil", "stokta bulunmuyor", "stokta bulunmamaktadır",
    "stokta mevcut değil", "stoklarımızda mevcut değil", "stoklarımızda
    bulunmuyor", "stoklarımızda yok".
  - English: "isn't in stock", "aren't in stock", "no longer in stock", "not
    available now", "isn't available now", "not ready to ship", "isn't ready
    to ship".
- **Any other English negation before a claim phrase cancels it.**
  - The negations: "not", "never", "no longer", and a word ending in "n't".
  - Where: among the five words before the phrase, after the last comma,
    semicolon, colon, "but" or "and".
  - "We don't have it in stock" makes no claim. "Not sure about the size,
    but it is in stock" still claims in stock.
  - A cancelled phrase claims nothing. Reading it as the opposite would take
    the negation's scope, which a word window can't tell.
  - The negations are lexicon data per language. Turkish has none: it
    negates after the phrase, in the listed forms.
- **"hemen teslim" leaves the in-stock list.** It promises delivery, and
  Turkish negates it inside the verb ("edilemiyor", "edilmez", "edilemez"),
  in more forms than a narrow list holds.

### Products the answer only names

- **With a catalog snapshot, a claim can bind to a catalog product.**
  - Named by its full name only: ADR-0027's starts stay for the turn's own
    products.
  - Its name has two words or more, and no other catalog product holds it.
  - Its stock comes from the catalog. The finding says it was named, not
    returned.
- **The turn's products come first.** Returned and seen products are
  matched as today. Where names overlap, the longest wins across both, so a
  returned product's full name beats a shorter catalog name inside it.
- **A sentence that names a catalog product doesn't spread its claim.**
  Where the name is held by several catalog products, the claim is not
  judged; it is not applied to every returned product either.
- **Without a catalog, nothing changes.** A sentence that names no returned
  or seen product still applies to every returned product.

### The measure

- **Unit tests, both ways:**
  - each listed form reads as out of stock;
  - each in-stock phrase alone still reads as in stock;
  - the cancel window: a negation inside it, one word past it, and one
    across a comma or "but".
- **`stock-claim` tests:**
  - a claim about a catalog product that wasn't returned passes at stock 0
    and fails at stock 5;
  - a shared name judges nothing and spreads nothing;
  - a one-word name, and a run without a catalog, behave as today.
- **The private target's stored answers, judged again offline,** with no
  call: the "stokta değil" turns pass against stock 0, and no turn gains a
  failure.

## Consequences

- **A true out-of-stock answer about a product that wasn't shown is judged,
  and passes.** Before, it was missed, and with the negation alone it would
  have failed eight products.
- **An English sentence that negates in-stock wording is no longer a false
  fabrication.** One that negates it further back than five words, or in a
  form the lists don't hold, still reads as the phrase it contains; each
  such form found is added to a list.
- **"hemen teslim" alone is no longer a claim,** so an answer that promises
  immediate delivery of a product with stock 0 is not caught by this check.
- **Folding the catalog's names costs one pass per language per run.** A
  catalog of tens of thousands of products is read once, not per turn.

## Alternatives considered

- **Flip any claim with a negation nearby.** It reads "not only is it in
  stock" as out of stock. Rejected: a cancel can only miss a claim, a flip
  can invert one.
- **A Turkish negation window after the phrase.** Turkish negates inside the
  verb ("bulunmuyor"), so a following-word list catches only "değil", which
  the listed forms already hold. Rejected for now.
- **Binding to catalog products by the start of their name, as ADR-0027
  does for the turn's.** Across tens of thousands of names, a two-word
  start is often shared, and when it isn't, it is often a common phrase.
  Rejected: full names only.
- **Not judging any claim in a sentence that names a product outside the
  turn.** That needs the catalog's names anyway. Rejected: with them, the
  claim can be judged.
