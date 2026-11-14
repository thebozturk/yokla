# 0036. yokla shrink keeps whole messages by default

Status: Accepted · Date: 2026-11-15

Amends [ADR-0035](0035-the-smallest-failing-conversation.md).

## Context

ADR-0035 has yokla shrink cut each kept message down to its fewest words,
with the turn's expectations left as they are. Its reasoning was that a
candidate that makes a check inapplicable doesn't fail it, so a cut that
removes what an expectation depends on is rejected.

The first run against the demo-shop showed where that reasoning breaks. With
`filter-ignored`, the case `black-women-jacket-tr` asks "Siyah kadın mont
arıyorum" and expects the filters `color: black, gender: women`. The shop
drops the filters, and `filter-honoured-or-disclosed` fails. Shrink cut the
message to "mont", and the check still failed, in the same dimension, with
the same message: the shop returned jackets of every colour, outside the
filters the turn still expects.

The shrunk case fails for another reason than the original. "mont" doesn't
ask for black women's jackets, so a shop that honours every filter fails it
too. The check stays applicable, because its input is the turn's
expectations, not the message. Any expectation that restates what the
message asks, such as filters, a product type, an absent type or an amount
the user wrote, can be cut away from its message this way.

Removing a whole turn keeps the target turn's message and expectations
together. It can still change what a follow-up means: "only black ones"
without the turn that asked for jackets. Such a cut usually fails another
check too, such as the product type, and ADR-0035's rule against new failing
checks rejects it; not always.

## Decision

- **Whole messages by default.** yokla shrink removes turns only. Each kept
  turn keeps its message as written, with its expectations.
- **Words on request.** `--words` cuts messages as ADR-0035 describes.
  - The terminal says, before the search, that a cut message can stop asking
    what its expectations describe.
  - The case file it writes says so in its header comment, and names each
    turn whose message was cut, so the reviewer reads those first.
- **The rest of ADR-0035 stands:** the target, the rule for a candidate that
  still fails, reproduction first, the budget, and the proposed case it
  writes.
- **The demo-shop acceptance** shrinks by turns. It shows the case
  `black-women-jacket-tr` cut to "mont" with `--words`, and checks that the
  file it writes carries the warning.

## Consequences

- **A shrunk case fails for the reason its original did,** as far as its
  messages go. A case of one turn can't get smaller by default, and shrink
  says it is already as small as it gets.
- **Removing earlier turns can still mislead.** A follow-up stripped of its
  context may fail only the target check. The shrunk case is proposed, and
  the summary lists each turn it kept, for a person to read.
- **Fewer runs by default:** no word search.
- **`--words` stays useful** where the expectations don't restate the
  message, such as a forbidden phrase or a leaked canary, and where a
  person checks the result.

## Alternatives considered

- **Protecting the words an expectation depends on.** That would need to
  know, per pack and per language, which words carry a filter or a type.
  Rejected: too narrow for a general command, and wrong in other languages.
- **Requiring the same finding evidence as the original.** The filter
  finding names the same violated filters for "mont", so it would accept
  the same wrong cut. Rejected.
- **Removing word cutting entirely.** It still finds the smallest message
  for checks that don't depend on what the message asks. Rejected in favour
  of an option with a warning.
