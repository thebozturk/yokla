# 0074. A number written with digit separators

Status: Proposed · Date: 2026-11-20 · Amends 0049

## Context

ADR-0049 checks every value the analyzer's model returns against the line
it quotes. A number passes when its digits stand alone in the quote: `120`
in `perMinute: 120`, but not in `1200` or `1.20`.

Code and docs often write a large number with digit separators:

- **in code,** `2_000` or `3_600_000` (TypeScript, JavaScript, Python,
  Java, Rust, Go and others);
- **in English prose,** `2,000`;
- **in Turkish and many other languages' prose,** `2.000`, or `2 000` with
  a space or a no-break space.

The run with a real model on the private target of design §19, after
ADR-0073, found a rate limit per hour on a line that states it as
`limit: 2_000`. The model returned 2000, with the right file, line and
quote. The check dropped it as "the value is not in the quote", so the
value was not proposed.

## Decision

- **A number is in the quote when its digits stand alone there, written
  either way:**
  - **plain,** as today: `2000`;
  - **grouped by threes from the right,** with one separator used between
    every group: `_`, `,`, `.`, a space, U+00A0 or U+202F. Examples:
    `2_000`, `2,000`, `2.000`, `3 600 000`.
- **What stands alone keeps ADR-0049's meaning:** no digit, `.`, `,` or
  `_` right before the number; after it, no digit, and no `.`, `,` or `_`
  followed by a digit. So `12,000` holds neither `12` nor `2,000`, and
  `2.0001` doesn't hold `2.000` as 2000.
- **Groups must be of three.** `20_00` is not 2000. Separators can't mix
  in one number: `1,000.000` is not 1000000.
- **Only the check changes.** The prompt, the fields and the value's shape
  stay: the model still returns a whole number.
- **Numbers of fewer than four digits are unchanged:** they have no
  groups.

### The tests

- **Unit tests in both directions,** for each separator: `2_000`,
  `2,000`, `2.000`, `2 000`, with U+00A0 and with U+202F, hold 2000; the
  same text with the separator removed from between the groups still holds
  it as `2000`, and with a group cut to two digits does not.
- **The boundaries:** `12,000` doesn't hold 2000, `2,0001` doesn't hold
  2000, `1,000.000` doesn't hold 1000000, `20_00` doesn't hold 2000.
- **The demo-shop end-to-end test is unchanged:** its limits are written
  without separators.
- **A free rerun by hand** on the private target: the same analysis,
  answered from the model's reply cache, so no call is made. The limit per
  hour is expected verified and proposed.

## Consequences

- **A value written as people write large numbers passes its check,** in
  code and in the languages yokla speaks.
- **`2.000` is read as two thousand when the value asked is 2000.** In
  English it could mean two. The value is a whole number of requests, and
  the person approves every entry, with the quote beside it.
- **Cached replies are checked again** on the next run, since the check
  runs on every reply, cached or not, at no cost.

## Alternatives considered

- **Stripping every separator from the quote before matching.** `1,2`
  would then hold 12. Rejected: only groups of three are read.
- **Asking the model to give the number as written.** The value's shape
  would change, and a string would need its own parse. Rejected: the check
  reads both forms instead.
- **Any separator, mixed.** `1,000.000` is a decimal in English. Rejected:
  one separator per number.
