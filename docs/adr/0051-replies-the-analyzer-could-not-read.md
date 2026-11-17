# 0051. Replies the analyzer couldn't read, and tokens counted as code takes them

Status: Accepted · Date: 2026-11-17

## Context

ADR-0049 asks a model for the values a repository writes its own way. Its
real run on the demo-shop, approved with its estimate, sent 22 files in 7
chunks to a hosted model that reasons before it answers:

- **Precision 100 %, recall 53.1 %** (34 of 64). The model found the two
  limits and the two canonical refusals, each verified in its line. Nothing
  was unverified and nothing conflicted.
- **The cache bypass was lost without a trace.** The README chunk's reply
  stopped at the model's `maxTokens`, 2000, in the middle of its JSON. The
  7 replies' visible text was about 290 tokens; the output billed was 4,887,
  most of it the model's reasoning, which counts against `maxTokens`. The
  cut reply wasn't JSON, so ADR-0049's reading gave no entry, and neither
  the summary nor the report said so. The cut reply was cached: a rerun
  returns it again.
- **The input was 63 % above its estimate:** 50,880 tokens estimated,
  82,880 billed. ADR-0049 counts one token per four characters; this code,
  with its line numbers, took one per about 2.5. The estimated cost still
  held ($0.0121 against $0.0107 spent) only because the output stayed far
  below its most. On a repository where input dominates, the estimate would
  be below the spend, and the twice-the-estimate bound close to it.

Both are ADR-0049's decisions, so this ADR changes them.

## Decision

### A reply that can't be read is said, never cached

- **The model client tells whether a reply stopped at `maxTokens`:**
  OpenAI-compatible `finish_reason` `length`, Anthropic `stop_reason`
  `max_tokens`, Gemini `finishReason` `MAX_TOKENS`. The reply gains `cut`,
  additively; the simulated customer (ADR-0028) is unchanged.
- **A reply is unread** when it was cut, whatever its text, or when it isn't
  the JSON asked for: no `entries` list in its whole text, or from its first
  `{` to its last `}`.
- **An unread reply gives no entry.** The entries before a cut aren't
  salvaged: the person raises `maxTokens` either way, and a whole reply is
  what gets verified.
- **Its cost counts,** toward `--max-cost` as any call's does, and the step
  goes on with the next chunk.
- **The summary names each unread chunk:** its files, why, and that
  `models.analyzer.maxTokens` is the setting to raise when it was cut.
- **The report gains `model.unread`,** additively: each unread chunk's files
  and reason.

### The cache keeps only what was read

- **Only a read reply is cached.** A cut reply, or one that isn't the JSON
  asked for, is asked anew on the next run.
- **A cached reply that can't be read is a miss.** That covers the replies
  cached before this ADR.
- **`maxTokens` leaves the cache key.** A reply read whole doesn't depend on
  it. Raising it for the cut chunks then asks only those anew: the others
  come from the cache, at no cost.

### Tokens counted as code takes them

- **One token per two characters,** in place of ADR-0049's four, for the
  chunks, `--chunk-tokens`, `--max-tokens` and the estimate. Code took one
  per about 2.5 on the demo-shop. Two keeps the estimate above the input of
  most code, and well above prose's.
- **The defaults stay:** 8,000 tokens a chunk and 200,000 for the step. A
  chunk holds half the text it did, so the demo-shop's files go in about 13
  chunks rather than 7.

### Guidance

- **The CLI guide** says that a model that reasons spends output tokens on
  it, counted against `maxTokens` and billed, and proposes 8000 rather than
  2000.

### The demo-shop and the tests

- **The fake provider's OpenAI-compatible endpoint honours `max_tokens`,**
  as providers do: a reply longer than it is cut there, with
  `finish_reason: length`.
- **The end-to-end test** adds an analysis whose `maxTokens` is too small
  for the README chunk's reply. The summary and the report name that chunk
  as cut, none of its values is proposed, and the next analysis asks it
  anew. A run with enough `maxTokens` then answers the other chunks from the
  cache.
- **The client's unit tests** read the stop reason of all three kinds.
- **One run with a real model, by hand,** approved with its estimate: the
  same model, with `maxTokens` 8000. Its input is expected at or below its
  estimate, no chunk unread, and the cache bypass found. Its results go to
  design §19, with the first run's.

## Consequences

- **No reply is lost silently.** What the model couldn't finish is named,
  with the setting that fixes it.
- **The estimate is higher.** On the demo-shop, the input estimate doubles,
  and more chunks mean more calls, so more system prompts and more
  reasoning. The most output, chunks × `maxTokens`, grows with 8000 and with
  the chunks: the estimate is a ceiling, often several times the spend.
  `--max-cost` still bounds what is spent.
- **A rerun after raising `maxTokens` costs only the cut chunks.**
- **`--max-tokens` reads less text by default:** about 400,000 characters
  rather than 800,000.
- **analysis.v1 gains `model.unread`,** additively.

## Alternatives considered

- **Salvaging the entries before a cut.** They would still be verified, but
  the rest of the reply is lost, and the person must raise `maxTokens` to
  get it. Rejected: an unread reply is named instead.
- **Asking again with a larger `maxTokens`, by itself.** The estimate counts
  chunks × `maxTokens`, so the step would spend beyond what was approved.
  Rejected: the person raises it.
- **Turning the model's reasoning off.** Not every provider offers it, the
  setting differs by kind, and the reasoning may be what finds the value.
  Rejected.
- **One token per 2.5 characters.** It matches the demo-shop's code, about
  2 % under, but nothing else measured it. Rejected: the estimate must not
  fall below the spend.
- **Calibrating the count from the replies' usage.** The estimate comes
  before the first call, when no usage exists, and a cache from another
  repository says little. Rejected.
