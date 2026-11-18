# 0066. A large catalog read whole, and a contract that is a schema

Status: Proposed · Date: 2026-11-18

## Context

With ADR-0065, `yokla analyze` ran on the private target with its catalog
export given by `--data`. Recall rose from 8.2 % to 26.5 %, and the probes
went as far as the demo-shop's. Two things in yokla still held it back.

- **The rows read end before the products shown.** A data file is read to
  its first 10,000 rows (ADR-0047). The export holds tens of thousands
  of products, sorted by id, so the rows read end partway through the ids.
  - The type probe's answer showed 8 products. Of that type's 9 products,
    3 are among the rows read, and 1 of its 7 in stock.
  - The evidence match takes an id path only when every product shown is
    a row it read. So no evidence path was proposed, and the 11 entries of
    the evidence mapping were missed.
- **A file that names its schema was read as one.** The inventory takes a
  JSON file with a top-level `$schema` key as a contract. A configuration
  file that names the schema it follows, such as a build tool's settings
  file, was read as a JSON Schema and reported "unusable". Nothing was
  proposed from it, but the summary named it among the contracts.

## Decision

### A data file read whole

- **A data file is read up to 1,000,000 rows,** not 10,000.
  - The pack's data step and the probes' match both see all of them.
  - A file with more rows is read to that bound. The summary and the
    report name it, since the match may then miss a product it shows.
- **The inventory's 5 MB bound on a repository file stays.** A file given
  by `--data` has none: the person chose to give it.

### A contract is a schema, or an OpenAPI document

- **A JSON or YAML file is a JSON Schema contract** when its `$schema`
  names a JSON Schema dialect: its URL is on `json-schema.org`.
- **OpenAPI and Swagger documents stay as they are,** by their `openapi`
  or `swagger` key.
- **A file whose `$schema` names anything else** is sorted as it would be
  without the key.

### The measure

- **Unit tests:**
  - the rows past 10,000 read, and a file past the bound named;
  - a probe answer whose products are past row 10,000 matched;
  - a `$schema` of each kind sorted both ways.
- **The demo-shop end to end:** its proposal and its numbers don't change.
- **The private target again,** free, AI off, as in ADR-0065. The evidence
  path is proposed; the new recall, and how long the analysis took with
  the whole export, go to its findings.

## Consequences

- **A catalog of a few hundred thousand products is analyzed whole.**
- **A very large export costs memory.** One of a million rows is held
  whole while the analysis runs; past that, the summary says what was cut.
- **ADR-0047's bound of 10,000 rows no longer holds,** and neither does
  ADR-0065's consequence that a large export is read to its first 10,000.
- **A JSON Schema without a `$schema` key is still not found,** as before.

## Alternatives considered

- **Match on the products that are read, and require a share of them.** A
  product shown that isn't read can't be told from one the target made
  up, so the match would weaken. Rejected.
- **No bound at all.** A mistaken `--data` of gigabytes would exhaust
  memory with no word. Rejected: a bound, said when it is reached.
- **Index only the ids and the matched columns past the cap.** The data
  step's proposals, such as the type separator and the price column, also
  improve with every row. Rejected for now: the plain bound is simpler.
