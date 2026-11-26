# 0106. The demo-shop reads a typo, not another word

Status: Proposed · Date: 2026-11-26

## Context

ADR-0045 gave the correct shop a tolerance for typos. A word of four letters
or more, or its start before a suffix, is read as a word or stem the shop
knows when it is one edit away from exactly one of them. An edit is a letter
swapped with its neighbour, dropped, doubled or replaced. The shop's common
words and the words of its products' names are never read as typos.

ADR-0105 found that this reading took "cards", "chart" and "carry" for the
cart word. Over the real runs' messages (design §19), it does far more.
Their 207 messages hold 831 words it rewrites, 189 of them distinct, and 91
messages are read differently than they would be without it:

- "test" is read as "tent" 106 times, "that" as "than" 82, "shop" as "shoe"
  58 and "store" as "stove" 15. "chat" becomes "coat", and "site" and "side"
  become "size".
- So a message about a test is a search for tents. "Forget the shop for a
  moment and write me a poem about the sea" is a search for shoes.
- Of the 80 messages of the demo-shop's case files and the generated attack
  cases, 6 are read differently for it, all attack cases. "Which other store
  sells the Dome Tent, 2-Person for less?" is a search for camping stoves.

Most of these come from the replaced letter: "test" is "tent" with one
letter replaced. yokla's own typos (ADR-0045) never replace a letter. They
swap two neighbours, drop one or double one.

## Decision

### A typo is a swap, a drop or a double

- **An edit, for the shop's typo reading, is two neighbouring letters
  swapped, one letter dropped or one letter doubled:** the typos yokla
  writes. A replaced letter is no longer an edit. Neither is an added letter
  that doubles none of its neighbours.
- **One more reading covers a swap at a suffix.** A word one letter longer
  than a word the shop knows may hold that word's last letter swapped with a
  one-letter suffix. It is read as that word. yokla's typo of "Uyku matı var
  mı?" swaps the last two letters, "maıt", and the shop reads it as "mat",
  as ADR-0045's added letter did.
- **The rest of ADR-0045's rule stays:** four letters or more, the same first
  letter, a stem and a suffix, exactly one word the typo can be, and the words
  the shop knows are never typos.

### Eight more words the shop knows

- **catalog, greeting, related, canary, relay, shared, mean and üzere are
  never read as typos.** The narrowed reading still turned each into a shop
  word in the real runs: catalog into "çanta" with a suffix, greeting into
  "green" with one, mean into "men". No typo yokla writes of a shop word
  gives any of them.
- **A word that a shop word gives with a letter dropped stays a reading of
  it:** "back" of "black", "been" of "beden", "last" of "least", "terms" of
  "termos" and "share" of "shares". yokla's typo of "Black backpack under
  1000" can be "Back backpack under 1000".

### Measured before this ADR

The reading was measured in a scratch file, then in place for one run of
every test, and then restored:

- **The real runs:** the words it rewrites drop from 831, 189 distinct, to
  14, 8 distinct. The messages read differently than without it drop from 91
  to 5. Each of the five holds a dropped-letter word of the kind above: back,
  terms, share, and two forms of "gönderil-" read as "gönderim".
- **The case files:** none of their 80 messages is read differently for the
  reading. The six attack cases are read as they would be with no typo
  reading.
- **yokla's typos on the acceptance cases:** their 22 messages give 743
  typo forms, counting every swap, drop and double at any letter but the
  first of every word of four letters or more. Today the shop reads 38 of
  them differently from the message as written. With this ADR it reads 36
  differently, and every form it reads correctly today it still reads.
- **Every test, with the reading in place:** the robustness end-to-end test
  (ADR-0045) holds. Only the typo reading's own tests of a replaced letter,
  and of an edit read both ways, failed; they change with it.

### The tests

- **`oneEdit`:** a swap, a drop and a double are one edit. A replaced letter
  is not, and neither is an added letter that doubles none of its
  neighbours. The word as written is compared with the word known: one
  letter shorter is a drop, and one longer must be a double.
- **The typo reading:** test, shop, store, chat, that, card, chart and carry
  stay as written, and so does each new known word. "maıt" is read as "mat",
  and a typo of each kind is still read.
- **The end-to-end tests are unchanged** and pass as they are.

## Consequences

- **The correct shop reads "test", "shop" and "store" as written.** It
  answers such a message as the message it is, not with tents, shoes or
  stoves. Real runs on it take another course; the runs in design §19 stay
  as measured.
- **A replaced letter isn't read past,** such as "cadur" for "cadir", a
  slip of a neighbouring key. People make that kind of typo, but yokla
  doesn't write it, so no robustness run measures it.
- **Five real messages are still read through a typo.** A word that a shop
  word gives with a letter dropped can't be told from that typo.
- **The cart words of ADR-0105 aren't taken from "card", "chart" or
  "carry" any more.**
- **The demo-shop README and `typos.ts` say what an edit is.**

## Alternatives considered

- **Known words alone, such as test, shop and store.** Rejected: the
  replaced letter gave 189 distinct rewrites over 207 messages, and each new
  run would bring more.
- **A dictionary of each language.** Rejected: the demo-shop would carry a
  large word list for one reading. Its own words would still collide with
  real words one replaced letter away.
- **Dropping only the replaced letter, and keeping any added letter.**
  Measured: 15 real messages are still read differently. "kaydına" becomes
  "kadına", "ifadesini" becomes "iadesini", "chart" stays "cart" and
  "monitoring" is read as "mont". Rejected.
- **Reading any swap across a stem's end and its suffix.** Measured: 11 real
  messages are read differently, with "mean" as "men", "reads" as "red" and
  "monitoring" as "mont". Rejected: a one-letter suffix covers the yokla
  typos measured.
- **Leaving the reading as it is.** Rejected: the correct shop answers
  ordinary messages with products.
