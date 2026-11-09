# 0001. Apache-2.0 licence

Status: Accepted · Date: 2026-11-09

## Context

yokla is meant to be adopted by companies, including in regulated industries.
Their legal teams review the licences of the tools they use. yokla will borrow
ideas, and possibly small pieces of code, from MIT-licensed projects.

## Decision

yokla is licensed under the Apache License 2.0. The full licence text is in
`LICENSE`. Its SHA-256 is
`cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30`, the
canonical text from apache.org.

## Consequences

- Contributors grant an explicit patent licence (section 3). Patent litigation
  over the work terminates that licence. Corporate legal teams ask for this, and
  MIT doesn't provide it.
- MIT-licensed code can be included as long as its copyright and permission
  notice are kept. Borrowed files carry their original notice in a header, and
  are listed in `NOTICE`.
- Code whose licence is unclear is never borrowed. One example is a file that
  refers to a licence file its repository doesn't contain.
- A `NOTICE` file is added once the copyright holder's name is settled.
- Contribution terms (DCO or CLA) are a separate decision.

## Alternatives considered

- **MIT.** Simpler and the most common licence in this ecosystem, but it has no
  patent grant. Rejected.
- **AGPL-3.0.** It would protect against closed hosted forks, but many companies
  ban it outright. That conflicts with the adoption goal. Rejected.
