# 0077. Tags group the summary and select a run

Status: Accepted · Date: 2026-11-20

## Context

A case can carry free `tags`, but nothing reads them. `suite` is a fixed
list (quality, factual, redteam, robustness, perf, resilience), so cases
mined from logs into a dozen categories — greetings, handoff requests,
order questions, product searches — can only show their category in the
case id. The summary has no per-category rate, and a person who fixed one
category has to run every case to see it.

## Decision

- **The summary groups by tag:** for each tag, the number of cases, each
  status, and the pass rate with its Wilson interval (and the weighted
  rate of ADR-0076 when weights are set). A case with several tags counts
  in each.
- **The report gets a "By tag" table,** sorted by failing cases, and each
  failing case shows its tags.
- **`yokla run --tag <tag>`** runs only cases with that tag; repeatable,
  a case runs when it has any of them.
- **The baseline and the gate are unchanged.** A run limited by `--tag`
  compares only the cases it ran; a case it didn't run is not a
  regression.
- **Tags keep their current form** (lowercase id). No reserved tags.

### The tests

- **Unit tests:** grouping with a case in two tags; the empty-tags case
  in no group; `--tag` selecting by any of several tags; the gate with a
  tag-limited run.
- **The report snapshot** with tags.

## Consequences

- **A category-level view without new suites.** The suite list stays a
  short, fixed vocabulary for the kind of test; tags are the author's.
- **A fix can be checked on its category alone,** in seconds, then on the
  full set before merge.

## Alternatives considered

- **Opening `suite` to free values.** Suites carry defaults (dimensions,
  gates); free values would need defaults for each.
- **Grouping by id prefix.** Ids are stable keys, not labels; a case
  belongs to one prefix, but can have many tags.
