# 0060. A rewrite adds nothing, and keeps its language

Status: Accepted · Date: 2026-11-17

## Context

ADR-0059's real run, approved with its estimate, sent the demo-shop's 18
acceptance cases paraphrased and code-switched by Claude Haiku 5.5, for
$0.0011 in all.

- **The paraphrase did its job.** Sixteen cases kept their verdict. The two
  that moved share a message, rewritten as "Are there any medium-sized
  jackets for women in stock?": the shop doesn't read "medium-sized" as size
  M. That is the target's gap, which the transform is for.
- **The code-switch wrote more than a code-switch.**
  - It added requests: "Çadır önerir misin?" gained "Hangi tent'ler iyi, 2
    kişilik olan var mı?", a constraint the case never asked; "Merhaba"
    became a question about headphones; "Do you sell hammocks?" gained a
    Turkish sentence.
  - It moved a message's language: "Can you recommend a stock to invest
    in?" became "Can you recommend bir stock to invest in, hisse
    önerebilir misin?", and the shop refused it in Turkish, which the
    English case's checks don't read.
  - The two cases that moved, `hammock-en` and `invest-en`, moved by the
    rewrite, not the target.

ADR-0059 checks a rewrite for what it keeps, never for what it adds.

## Decision

### The prompt, version 2

- **Both kinds:** keep the same requests and facts, add none and drop
  none; change only how they are written.
- **Code-switch:** keep the case's language as the message's language;
  replace a few words, such as product words, with the other language's,
  and write nothing else in it.
- **The prompt's version moves to 2,** so no rewrite of version 1 is taken
  from the cache.

### Two more checks before a rewrite is sent

- **No more sentences than the message.** A sentence ends at `.`, `?`, `!`
  or `…` before a space or the end, never at a point between digits such as
  "1.500"; a message without one is one sentence. A rewrite with more is
  not sent: "the reply adds a sentence".
- **A code-switch keeps its language.** Counted as `language-match` counts
  (ADR-0018), the rewrite's common words of the language mixed in must not
  outnumber those of the case's language; a short message with none of
  either passes. A rewrite where they do is not sent: "the reply is no
  longer in <language>".
- **As in ADR-0059,** a message whose rewrite is refused is sent as
  written, and the run's issues say why.

### The measure

- **The fake provider's rules don't change,** and none of its rewrites
  breaks the new checks, so ADR-0059's end-to-end test holds as it is.
- **Unit tests** check each rule both ways: a rewrite with a sentence more,
  a decimal point that ends nothing, and a code-switch whose mixed-in words
  lead, beside one where they tie.
- **One more run with the real model, by hand,** approved with its
  estimate: the same cases, both kinds. Its verdicts, refusals and cost go
  to design §19, beside the first run's.

## Consequences

- **A rewrite that asks for more is not sent,** so a verdict that moves
  under it is the target's.
- **A long paraphrase in one sentence still passes,** as it should: a
  shopper may ask the same thing at length.
- **A code-switch with only a word or two mixed in may read as the case's
  language to the target too.** That is the code-switch shoppers write.

## Alternatives considered

- **A word-count bound.** On the real run, a faithful paraphrase of 10
  words was longer than a rewrite of 9 that had added a sentence. Rejected:
  sentences tell them apart.
- **Only the prompt.** A model may still add a request, and nothing would
  catch it. Rejected: the checks stay deterministic.
- **Answering a code-switched message in either language.** The checks
  judge in the case's language (ADR-0059). Rejected for now: the rewrite
  keeps the case's language instead.
