# 0064. A cheaper follow-up says cheaper than what

Status: Proposed · Date: 2026-11-18

## Context

ADR-0063 made a generated `cheaper` case name a product that has a cheaper
one in stock of its catalog type, and made its second turn expect a
product shown (`evidence.products.min: 1`). Its second turn still asks
"Do you have anything cheaper?".

On the private target, with its model on, the 5 cheaper cases generated
under ADR-0063 passed 2 times and failed 3 times, each on `min: 1`.

- **The target was right each time.** Its first answer was a list of 8
  products, 3 to 6 of them already cheaper than the product asked for. It
  read "anything cheaper?" as cheaper than the cheapest product it had
  shown, said so, and said there was none. By the catalog, nothing in
  stock of that type was cheaper than the cheapest shown, in all three.
- **The case read it as cheaper than the product asked for.** A case is
  written before anything is sent, so it can't know what the first answer
  will show. When that answer is a list, "anything cheaper?" has two
  readings, and the case took one.

## Decision

- **The cheaper follow-up says what it is cheaper than:** the product the
  shopper asked about first, without naming it again.
  - Turkish: "İlk sorduğum üründen daha ucuz bir seçenek var mı?"
  - English: "Do you have anything cheaper than the one I asked about
    first?"
- **The expectations stay as ADR-0063 set them:** `productType`,
  `maxPrice` at that product's price, and `evidence.products.min: 1`.
- **Only `yokla generate` changes.** Explore's cheaper intent (ADR-0046)
  asks after an answer it has seen, and keeps its wording.

### The measure

- **Unit tests:** the second turn's message in both languages, beside its
  unchanged expectations.
- **The demo-shop end to end:** every generated case still passes without
  a defect, and each cheaper second turn still shows a product.
- **One more run on the private target, with its model on,** approved with
  its estimate: the cheaper second turns are judged against the product
  asked about first.

## Consequences

- **The bound has one reading.** A target that bounds by the product asked
  about first, and shows nothing when its type has a cheaper product in
  stock, fails; one that shows such a product passes.
- **The case still tests carry-over.** The message refers back to the
  conversation instead of naming the product, so the target has to
  resolve which product was asked about first.
- **A target that bounds by the cheapest product shown now fails, where it
  was right before.** The message has removed the reading that made it
  right.

## Alternatives considered

- **Name the product in the follow-up.** "Do you have anything cheaper
  than the {name}?" is the plainest bound, but the turn no longer depends
  on the conversation. Rejected.
- **Drop `min: 1`.** No false failure, but a target that wrongly says
  "nothing cheaper" passes again, as before ADR-0063. Rejected.
- **Bound by the cheapest product the first answer shows.** A generated
  case can't know it. Rejected: that is explore's job, which reads the
  answer before it asks.
