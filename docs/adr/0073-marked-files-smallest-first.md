# 0073. Marked files go smallest first

Status: Accepted · Date: 2026-11-20 · Amends 0072

## Context

ADR-0072 sends first the files that name the most fields asked: a file
that names the rate limits, the cache bypass and the refusals goes before
one that names only the limits.

The estimate for the large private target of design §19, before any call,
showed that this order fails there:

- **A handful of very large docs name all three fields.** A long document
  is likely to mention a rate limit, a cache and a refusal somewhere. Those
  docs went first and filled the whole token budget on their own.
- **The code that sets the values is small and names one field.** A
  throttler's storage or a module's setup is a few kilobytes and names only
  the limits. It came after the large docs, and the budget never reached
  it: fewer files were sent than under ADR-0049's order.

How many fields a file names grows with its size, so it says little about
whether the file states a value. A free simulation of other orders on the
same target, from the files' text alone, sent many times more marked files
when they went smallest first, and the throttler code among them.

The paid run ADR-0072 planned was stopped at its estimate, and nothing was
sent.

## Decision

- **Marked files go first, smallest first.** A file is marked when it
  names any field asked, by ADR-0072's markers. Among the marked files, the
  one with the shortest text goes first. Files of the same length keep
  ADR-0049's order: by kind, then by path.
- **Unmarked files follow,** in ADR-0049's order, as ADR-0072 says.
- **How many fields a file names no longer orders it.** The markers still
  decide which files are marked.
- **The estimate's line is unchanged:** how many marked files are sent,
  and how many the budget leaves out (ADR-0072).

### The demo-shop and the tests

- **A unit test:** a large file that names all three fields goes after a
  small one that names one, and a budget that holds only the small one
  sends it. Unmarked files come after every marked one, whatever their
  size.
- **The end-to-end test:** the same 37 entries and the same evidence. The
  values found come in the order their files were sent, now the code
  before the README, and the test's expected order follows.
- **The paid run by hand,** as ADR-0072 planned it, with a new estimate
  approved before it.

## Consequences

- **The budget reaches as many marked files as it can.** No single large
  doc can spend it on its own.
- **A large file that states a value is read late,** after the smaller
  marked files. When the budget runs out first, the estimate says how many
  marked files are left out and that `--max-tokens` is the setting to
  raise.
- **A value written in a file no marker names is still read only in
  budget left over,** as ADR-0072 says.

## Alternatives considered

- **Fields named per character of text.** It favours small files that
  name many fields. The simulation sent about as many files, but the rule is
  harder to explain and to test. Rejected for the simpler order.
- **A cap on one file's share of the budget.** The large docs would still
  go first and be cut, so their first part would be read and the rest not.
  Rejected: it spends the budget on what is likely least useful.
- **Leaving ADR-0072 as it is.** On a large repository the code that
  states the values is still not read, which is what ADR-0072 was for.
  Rejected.
