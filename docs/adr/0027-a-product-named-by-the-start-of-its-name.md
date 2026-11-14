# 0027. A product named by the start of its name

Status: Accepted · Date: 2026-11-14

## Context

`stock-claim` ties a claim to the product named in its sentence. A product
is named only when the sentence holds its full name. A claim in a sentence
that names no product applies to every returned product.

On the open-source target, an answer returned two products:

- "ACME Signature 15-Bar Espresso Machine with Steam Wand", out of stock;
- "ACME Everyday 12-Cup Programmable Drip Coffee Maker", in stock.

The answer said that "the ACME Signature 15-Bar at $329 … is currently out of
stock", and that "the ACME Everyday 12-Cup drip maker is in stock". Both are
right. Neither sentence holds a full name, so `stock-claim` applied each
claim to both products and failed two of the four. Answers shorten long
product names all the time, and a full name that runs to eight words is
rarely written out.

## Decision

A product is also named by the start of its name.

- **Which start counts.** The shortest start, in whole words, that no other
  product of the turn shares, and at least two words long.
  - The products of the turn are those returned, and those seen by the
    model (ADR-0026).
  - "ACME Signature" tells the espresso machine from the drip coffee maker.
  - Where five products start with "ACME Makers", each needs its third word.
- **How it is matched.** As the full name is: on the folded text, as whole
  words.
- **Where names overlap, the longest wins,** as today.
  - A full name written out beats the start of another product's name.
  - The start of the same product's name, inside its full name, is the same
    mention.
- **What doesn't name a product.**
  - A name of one word is named only in full.
  - A start that two products share names neither of them.
- **Where it applies.** `stock-claim` uses it. It is the only check that
  ties claims to product names.

## Consequences

- **Shortened names are understood.** The two claims of the answer above are
  tied to their products and pass. A wrong claim about a shortened name is
  caught, where before it was spread over every returned product.
- **The rule depends on the turn's products.**
  - A start that is unique among them names a product, even if the catalog
    has others with the same start.
  - This is deliberate: an answer is about the products it has, and the
    catalog may be absent.
- **A two-word start can still be a common phrase.** An example is a product
  whose name begins with "Kids Scooter". A sentence that uses those two words
  for something else ties its claim to that product. The finding names the
  product, so a person can see why.
- **The same rule could tie other claims later,** such as prices to
  products. Today only `stock-claim` ties claims to names.

## Alternatives considered

- **Fuzzy matching, by the share of a name's words in a sentence.** It is
  hard to predict, and a sentence about two products would match both.
  Rejected.
- **Aliases in the profile.** They are specific to a catalog and must be
  kept up to date. A target that returns a short name can map it as a field
  of the evidence. Deferred until a target needs it.
- **Any word unique to a name, such as "Signature".** Ordinary words would
  name products. Rejected.
- **Asking a model which product a sentence is about.** That puts a judge
  before the deterministic checks, against ADR-0005's order. Deferred to the
  judge checks of v0.5.
