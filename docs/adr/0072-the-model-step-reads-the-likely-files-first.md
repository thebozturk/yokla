# 0072. The model step reads the likely files first, and answers at length

Status: Accepted · Date: 2026-11-20 · Amends 0049

## Context

ADR-0049's model step reads files by kind (`doc`, `prompt`, `contract`,
`manifest`, `env-example`, `code`), then by path, until `--max-tokens` is
spent. Claims came first so that a budget that runs out leaves code unread
rather than docs. Every reply is cut at the model's `maxTokens`, 400 by
default, the same default as the simulated customer's (ADR-0028); a cut reply
gives no entry and is named (ADR-0051).

A run with a real model on a large private target (design §19) showed two
gaps:

- **The budget went to docs.** The default 200,000 tokens were spent on
  docs and prompts; most of the repository, the code that sets the rate
  limits and the cache layers among it, was left out. The step found no
  value, and the limits and the cache bypass stayed missed.
- **Replies stopped at 400 tokens.** Each was a long doc whose reply listed
  many candidates. They gave nothing, though their cost counted.

On the demo-shop neither shows: every file fits in the budget, and the fake
provider's replies are short. A large repository is where the model step is
meant to help, since rules alone can't find what each project writes its own
way.

## Decision

### Files that name a field go first

- **Each field has a short list of markers,** in core, matched in any case
  against a file's path and text:

  | Field | A file is marked when it holds |
  |---|---|
  | `limits` | `rate limit` (with a space, `-`, `_` or nothing), `throttl`, `retry-after`, `too many requests`, `429` standing alone, `burst`, or `per second`, `per minute`, `per hour` (also `perMinute`, `per_minute`) |
  | `cacheBypass` | `cache`, and one of `bypass`, `no-cache`, `no-store` |
  | `refusal` | `refus` or `declin`; and every file of kind `prompt`, where refusals are written |

  The markers are English and name no target (P9). They only order the
  files: what the model returns is still checked against its line
  (ADR-0049), so a marker that matches too much costs budget, never
  precision.
- **A file's rank is how many fields mark it,** from 0 to 3. The model
  reads the files by rank, highest first. Within a rank, ADR-0049's order
  holds: by kind, then by path.
- **Test files, data, environment files and files of kind `other` stay
  unread,** as ADR-0049 says.

### What the estimate says

- **Before the first call,** with the files sent and left out, the
  analyzer says how many of each are marked. A marked file left out means
  the budget was too small for what was asked; the line says
  `--max-tokens` is the setting to raise.

### The analyzer's model answers in up to 2,000 tokens by default

- **`models.analyzer.maxTokens` defaults to 2,000.** `models.customer` and
  `models.transform` keep 400: a customer's turn and a rewrite are short.
- **The estimate grows with it:** the most output tokens are chunks ×
  `maxTokens`, as ADR-0049 counts them. What is spent doesn't: a model stops
  when its reply is done.
- **A reply cut at 2,000 is still named** with its chunk's files and the
  setting to raise (ADR-0051). Nothing is asked again by itself.

### The demo-shop and the tests

- **Unit tests** of the markers in both directions: a file holding each
  marker is marked for its field, and the same file with the marker
  replaced is not. A `prompt` file is marked for `refusal` with no marker in
  its text.
- **A unit test of the order:** a marked code file goes before unmarked
  docs, and a budget that sends only one of them sends the code. Files of
  one rank keep ADR-0049's order.
- **A unit test of the default:** `models.analyzer` without `maxTokens`
  parses to 2,000, and `models.customer` to 400.
- **The end-to-end test is unchanged in what it expects:** every
  demo-shop file fits in the budget, so the same files are sent and the
  proposal is the same 37 entries. The order changes, so the chunks do, and
  their cache keys with them; the test's cache is made fresh, so that costs
  nothing.
- **One run with a real model, by hand,** on the private target of
  ADR-0049's first run (design §19), approved with its estimate. Expected:
  the marked code that sets the limits and the cache sent, no chunk cut, and
  precision and recall recorded in design §19.

## Consequences

- **The budget goes to what can answer the question.** On a large
  repository, a file that names a rate limit is read before a doc that
  doesn't, whatever its kind.
- **A field written with none of the markers is found only in budget left
  over.** That is ADR-0049's behaviour for every field today.
- **Adding a field adds its markers.** A later ADR that widens the fields
  also says what marks them.
- **The estimate's upper bound rises** for the analyzer by about five
  times its output share. `--max-cost` still caps what is spent.
- **Caches made before this ADR answer fewer chunks** on a repository whose
  order changes: the chunks differ, so their keys do. The first run after it
  asks them anew.

## Alternatives considered

- **Sending only marked files.** It spends least, but a value written with
  none of the markers would never reach the model. Rejected by the
  maintainer: unmarked files keep the budget left over.
- **Ranking chunks rather than files.** A large doc's one marked part
  would go first without the rest. It is more precise, but the order of
  lines within a file would scatter across the step, and the gain is
  unmeasured. Rejected for now.
- **Code before docs, by kind.** It would have found the private target's
  limits, but a project that writes them only in its README would lose them
  instead. Rejected: markers follow the question, not the kind.
- **Splitting a cut chunk and asking again.** It would recover a cut reply
  by itself, but the spend could pass the approved estimate, which ADR-0051
  rejected for the same reason. Rejected by the maintainer: the default is
  raised and a cut chunk is still named.
- **Raising the shared default.** A customer's turn and a rewrite need no
  2,000 tokens, and their estimates would grow for nothing. Rejected: only
  the analyzer's default changes.
- **A model that picks the files.** ADR-0049 rejected an agent that browses
  the repository; the same holds here.
