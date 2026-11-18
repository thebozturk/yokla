# 0068. An evidence field left undecided names its candidates

Status: Proposed · Date: 2026-11-18

## Context

ADR-0067 taught the evidence match to read a decimal string as a number,
and a fallback of two paths. On the private target it changed nothing.

- **Two paths fit the price.** In every product the type probe showed,
  two fields of the answer hold the same decimal string. Both equal the
  catalog's price read as a number.
- **The match proposes none, and says nothing.** Two answers at a rule
  give no path (ADR-0047, ADR-0067). That is right: values can't tell the
  paths apart, and a guess would be a wrong entry as often as a right one.
  But the person sees only that the price is missing. They don't learn
  that two candidates were found, or which.
- **The person decides in any case.** Every entry is reviewed before use
  (ADR-0004). One who knows the target picks the right path at a glance.

## Decision

### The candidates are kept

- **When a rule of the match gives two or more answers for a column,** the
  match keeps them as that column's candidates, in the order it found
  them. It still proposes no path.
- **Only for a column that names an evidence field.** A column the pack
  doesn't map is never proposed, so its candidates aren't kept.
- **They are paths and readings only:** a path, a list of paths, and
  `as: number`. Never an answer's value. The report stays free of values
  (ADR-0047).

### They are shown

- **The summary names them** after the proposed entries, one line per
  field: `undecided: <pointer>: <candidate> | <candidate>`. Each is
  written as the proposal's evidence writes a field, such as
  `price.salePrice, read as a number`.
- **The report lists them** under `undecided`, each with its pointer, the
  probe that showed it, the number of items, and its candidates.
- **At most five candidates are named per field,** with the count of the
  rest. A fallback can fit many pairs.
- **The proposal file is unchanged.** It holds only what can be approved,
  and an undecided field has nothing to approve.

### The measure

- **Unit tests,** each with input-mutation tests: two paths, two readings
  as a number and two fallbacks kept as candidates; one answer keeps none;
  a column with no evidence field keeps none; the bound of five.
- **The demo-shop end to end:** its proposal, report and numbers don't
  change.
- **The private target again,** free, AI off, as in ADR-0067. The summary
  names the price's candidates. Precision and recall don't change.

## Consequences

- **A field the match can't decide is visible.** The person picks one
  candidate and writes it into the profile.
- **The report has one more optional key.** Its JSON Schema changes, but
  an older report is still valid.
- **Nothing gets proposed that wasn't.** The numbers stay as they are.

## Alternatives considered

- **Propose the first candidate.** The order the match finds paths in is
  the answer's key order, which means nothing here. Rejected: a wrong
  entry is worse than a missing one.
- **Propose a candidate by its key name,** such as one named like a sale
  price. The analyzer finds evidence by values, never by names (ADR-0047).
  Rejected.
- **Write the candidates into the proposal as comments.** The proposal is
  regenerated whole, and a comment carries no provenance. Rejected: the
  summary and the report are where an analysis explains itself.
