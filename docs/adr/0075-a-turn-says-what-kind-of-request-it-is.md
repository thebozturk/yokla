# 0075. A turn says what kind of request it is

Status: Accepted · Date: 2026-11-20

## Context

A shop assistant's users don't only search. Real conversation logs are
full of greetings, thanks, "can I talk to a person", and questions about
an order the assistant can't see. When a target treats such a message as a
product search, it answers with a failed-search sentence ("I couldn't find
any products for your search") or, worse, with product cards for "ok
thanks".

No generic check sees this today:

- `over-refusal` and `deflection` need the turn to say whether the request
  is *answerable*. A greeting is neither answerable nor a request to
  refuse: marking it `answerable: false` makes `over-refusal` fail every
  greeting the target answers politely.
- `absence-correct` judges a stated absence only when the turn *expects*
  absence.
- `evidence-count` can forbid products (`max: 0`), and `answer-text` can
  forbid a phrase, but both must be written by hand for each case, with
  the target's own wording.

On the private target of design §19, cases mined from another assistant's
real conversation logs were run twice: once with hand-written patterns per
category, once with only `answerable` set on product questions. The
generic checks caught only a small share of the failures the patterns
caught, all of them deflections; every failure they missed was a
non-search message answered as a search.

## Decision

- **A turn may set `expect.request`:** one of
  - `chitchat` — a greeting, thanks, a goodbye, an emoji, small talk;
  - `handoff` — the user asks for a person: an agent, an advisor, a call;
  - `support` — a question about the user's own order, payment, account,
    return or delivery, which the target may answer or send elsewhere.

  Product and information requests need no value: `answerable` and the
  domain expectations already cover them.
- **A new check, `request-handled`,** runs when the turn sets
  `expect.request`. On that turn:
  - **no evidence items** in any collection the profile maps (a
    clarifying question's turn is no exception: chit-chat gets no cards);
  - **no failed-search sentence:** the answer contains no `absence`
    phrase of the language pack, unless it also contains a `deflection`
    phrase (an order question answered "I can't see your order, contact
    customer service" is fine);
  - **for `handoff` only, a pointer to a person or a channel:** a
    `deflection` phrase of the language pack, or one of the profile's
    `contactPhrases` (below). Without one the turn fails: the user asked
    for a person and wasn't told how to reach one.
- **The profile may list `response.contactPhrases`:** the target's own
  words for its channels (a support URL, a phone line's name), matched
  after folding. They add to the pack's `deflection` phrases for this
  check only.
- **Dimension `request`, worst-of-N.** A greeting answered with cards in
  one sample out of three is a defect.
- **`deflection` (advisory) doesn't run on a turn with `expect.request`:**
  sending an order question elsewhere is the expected answer there.
- **Language packs:** English and Turkish `absence` and `deflection`
  phrases are checked against this use; phrases a failed search uses that
  are missing are added ("no results", "couldn't find any products").
- **The analyzer and `explore` don't set the value yet.** It is written
  by a person, or by a generator from labelled logs.

### The tests

- **Unit tests per kind, both ways:** cards on `chitchat` fail; an
  absence sentence on `chitchat` fails; an absence sentence with a
  deflection on `support` passes; `handoff` without a pointer fails, with
  a pack phrase passes, with a profile `contactPhrases` entry passes.
- **No `expect.request`, no check:** existing cases' verdicts don't move.
- **The demo-shop gets three cases,** one per kind, and a seeded fault:
  "thanks" answered by a product search. The end-to-end test expects the
  fault caught and the clean build passing.

## Consequences

- **The commonest real-world miss of a shop assistant becomes one field
  per case,** without the target's wording in every case.
- **The phrase lists carry more weight.** A target whose failed-search
  sentence uses words no pack lists passes the absence part; the
  evidence part still holds. Unknown wording can be added to the profile's
  `everyAnswer` patterns as today.
- **Three kinds, not a taxonomy.** Anything else stays with `answerable`
  and the domain expectations. A fourth kind needs its own ADR.

## Alternatives considered

- **Reusing `answerable: false` for chit-chat.** It means "should refuse";
  a polite greeting would fail `over-refusal`.
- **Hand-written patterns per case only.** Works (the private target's
  run did exactly that) but every case repeats the target's wording, and
  a target that rewords its sentence silently passes them all.
- **Detecting the kind from the user's message.** A classifier in yokla
  would be the target's own job done twice, with its own errors; the case
  states what the person expects.
