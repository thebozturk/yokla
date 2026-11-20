# 0076. A case carries a weight

Status: Accepted · Date: 2026-11-20

## Context

Cases mined from real logs are not equal. One message stands for tens of
thousands of conversations, another for three. yokla's summary counts
cases, so "N of M passed" says nothing about how much of the real
traffic the target gets wrong. On the private target of design §19, the
case pass rate and the traffic-weighted pass rate of the same run were far
apart in several categories, in both directions.

## Decision

- **A case may set `weight`:** a positive number, default 1. It is the
  case's share of traffic, in any unit the author picks (conversations,
  sessions); only ratios matter.
- **The summary adds a weighted pass rate** next to the plain one: the
  sum of the weights of passing cases over the sum of the weights of
  measured cases. `unmeasured`, `error` and `known-gap` cases are left out
  of both sums, as they are of the plain rate. Per suite and per tag
  (ADR-0077), the same.
- **The report shows both rates,** and lists failing cases by weight,
  heaviest first, when any case has a weight other than 1.
- **Gates are unchanged.** A regression is still a case that passed and
  no longer does; a weight never hides one.
- **Wilson intervals stay on the plain rate.** The weighted rate is shown
  without an interval: its effective sample size depends on the weights,
  and a misleading interval is worse than none.

### The tests

- **Unit tests:** the weighted rate with mixed weights; all weights 1
  gives the plain rate; excluded statuses leave both sums.
- **Schema:** zero and negative weights are rejected.
- **The report snapshot** with and without weights.

## Consequences

- **A real-world run answers "how much traffic fails"** next to "how many
  messages fail".
- **A heavy case's failure is visible first,** which is where a fix pays
  most.
- **Weights are the author's claim.** yokla doesn't check them; a
  generator that mines logs writes them.

## Alternatives considered

- **Repeating a case `weight` times.** Runs the same message thousands of
  times for no information.
- **Weighted gates.** A weighted threshold could pass while a light case
  regresses; gates stay per case.
