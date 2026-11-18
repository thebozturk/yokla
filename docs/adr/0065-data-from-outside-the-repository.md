# 0065. Data from outside the repository, and a comparison without the contract

Status: Accepted · Date: 2026-11-18

## Context

`yokla analyze` (ADR-0047) ran on the private target's repository, without
a model. Compared with the hand-written profile, it scored a precision of
2.2 % and a recall of 8.2 %. Two things in yokla, not the target, made the
numbers say little.

- **The catalog lives in a database.** The repository's data files were
  evaluation scenarios. The analyzer reads data only inside `--dir`, so
  the catalog export kept elsewhere couldn't be given.
  - Without a catalog, the data step proposed nothing.
  - The probes stopped after the greeting, with no type asked and nothing
    put in the cart.
  - About 19 of the 44 missed entries were the catalog's and the evidence
    mapping's.
- **One contract weighed 181 entries.** The response contract, read from
  the target's published OpenAPI document and verified against the probe
  answer, became 181 schema leaves. The hand-written profile has no schema,
  so all 181 counted as new. The other proposals were 4 right out of 5.

## Decision

### `--data <file>`

- **`yokla analyze --data <file>`, repeatable,** gives a data file from
  outside the repository.
  - It is read as the inventory's data files are: JSON Lines, a JSON
    array of objects, or CSV with a header line, up to the first 10,000
    rows.
  - The domain pack sees it beside the repository's data files.
  - Its path in the proposal is relative to the proposed file, as theirs
    is.
- **A file that doesn't exist, or of another kind, is an error** (exit
  `2`), named; nothing is probed.
- **The summary lists the files given,** beside the inventory's counts.

### The comparison, with and without the contract

- **The comparison stays entry by entry,** as ADR-0047 counts it, and its
  totals don't change.
- **It also gives the precision and the recall without
  `target.response.schema`,** on both sides. Both lines are printed, and
  the report holds both.
- **When neither side has a response schema,** the second line is left
  out: it would repeat the first.

### The measure

- **Unit tests:** a `--data` file read as a repository one, its path in
  the proposal, a missing file, a file of another kind; the comparison's
  second line with a schema on one side, on both sides, and on neither.
- **The demo-shop end to end:** its catalog moved out of the analyzed copy
  and given by `--data` gives the same proposal as before, 49 entries. Its
  second line, the 19 contract entries left out, is a precision of 100 %
  and a recall of 30 of 50 (60.0 %).
- **The private target again,** free: AI off, no model step, its catalog
  export given by `--data`. The new numbers go to its findings.

## Consequences

- **A target whose data is kept outside its repository is analyzed with
  its data,** and its probes go as far as the demo-shop's.
- **The data given is read, never sent.** As with the repository's files,
  the pack sees it; only the probes reach the target.
- **A large export is still read to its first 10,000 rows.** The catalog's
  columns and types are proposed from those.
- **The first line still counts a contract leaf by leaf.** The second line
  shows what the other entries are worth.

## Alternatives considered

- **Count a proposed subtree the profile lacks as one entry.** It changes
  every total ADR-0057 and ADR-0058 measured, and "one entry" would depend
  on what the reference happens to hold. Rejected.
- **Count the response schema as one entry, compared whole.** One changed
  keyword would make a 19-entry contract wholly different. Rejected.
- **Point `--dir` at a copy of the repository with the data in it.**
  It works, but copies the repository, and the proposal's paths then point
  into the copy. Rejected.
