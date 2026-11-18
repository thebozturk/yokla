# 0067. An evidence field read as a number, or from a fallback

Status: Proposed · Date: 2026-11-18

## Context

With ADR-0066, `yokla analyze` found the private target's evidence mapping:
where the products are in its answer, and their id, name and currency.
Its price was not found, though the answers carry it. Recall stayed at
34.7 %.

- **The match compares values as they are.** The evidence match
  (ADR-0047) takes, for each catalog column, the one item path whose value
  equals the row's in every item shown. The target sends each price as a
  decimal string, such as `"1999.90"`. The catalog holds the number
  `1999.9`. They are not equal, so no path is proposed.
- **A profile can already read such a value.** An evidence field can be
  `{ from: <path>, as: number }`, and `from` can be a list of paths read in
  order until one is not null (ADR-0020). The hand-written profile reads
  the price as `{ from: [price.salePrice, price.listPrice], as: number }`:
  the sale price, else the list price. The match never proposes either
  form.

## Decision

### What the match proposes, in order

For each catalog column, as now, a column that is null in every row, or
equal to another column in every item, gets no path. Otherwise the first
of these rules that gives exactly one answer wins. Two or more answers at
a rule give no path, as two paths do now.

1. **A path as it is.** The item path whose value equals the row's in
   every item. Unchanged.
2. **A path read as a number.** When the row's value is a number: the
   path whose value, read as yokla reads `as: number` (a number, or a
   decimal string), equals it in every item, and is a string in at least
   one. Proposed as `{ from: <path>, as: number }`.
3. **A fallback of two paths.** The ordered pair `[a, b]` such that, read
   as the profile reads a `from` list (the first present and not null,
   then `as: number` when rule 2's reading is needed), it equals the row's
   value in every item. The first path must be null or absent in at least
   one item, and hold the value in at least one. Proposed as
   `{ from: [a, b] }`, with `as: number` when needed.

- **Every proposal is read back.** Before a field is proposed, the
  profile's own field reader reads it from each item shown. It must give
  the row's value in every one, with no conversion problem.
- **The proposal says how it was read.** Its evidence names the rule: "read
  as a number", or "a, else b".
- **A fallback is proposed only when the answers show it.** If no item
  shown has its first path null, rule 3 can't tell a fallback from a plain
  path, so it proposes none. Rule 2 may then propose the first path alone.
  The person, who reviews every proposal (ADR-0004), adds the fallback.
- **A field the catalog doesn't hold is still not found.** The match
  starts from the catalog's columns. A list price the catalog lacks has
  nothing to equal.

### The measure

- **Unit tests,** each with input-mutation tests:
  - a decimal string proposed with `as: number`, and an unparsable one not;
  - a fallback proposed when an item's first path is null, and not when no
    item's is;
  - two paths or two pairs that fit give no path;
  - a column equal to a number already proposes the path as it is.
- **The demo-shop end to end:** its proposal and its numbers don't change.
- **The private target again,** free, AI off, as in ADR-0066. The new
  precision and recall go to its findings.

## Consequences

- **A price sent as text is found.** So is a fallback that the probes'
  answers show.
- **A fallback they don't show is proposed as one path.** It reads null
  for the products whose first path is null. The person adds the rest.
- **The match does a little more work.** Rule 3 tries the pairs of the
  item paths, only for a column the first two rules didn't settle.
- **ADR-0047's match is extended,** not replaced: rule 1 is its rule.

## Alternatives considered

- **Compare every value as a string.** `"1999.90"` and `1999.9` still
  differ as strings, and `"5"` would equal `5` with no `as` proposed, so
  the profile would read the wrong type. Rejected.
- **Fallbacks of any length.** The profile allows them, but each extra
  path multiplies the candidates, and two paths cover a sale price and a
  list price. Rejected for now.
- **Guess a fallback from key names,** such as a sale price beside a list
  price. The analyzer finds evidence by values, never by names
  (ADR-0047). Rejected.
