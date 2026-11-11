# 0015. Prompt inspection: what the proxy captures, what is stored, and four checks

Status: Accepted · Date: 2026-11-11

## Context

The model proxy measures calls and injects faults (ADR-0012, ADR-0013). Its
third job is to inspect the prompts the target sends to its model (design
§12). Design §12 lists four inspections:
- untrusted retrieved content placed in the system role,
- a system-prompt canary leaking into the answer,
- seeded PII present in prompts,
- prompt size against the declared budget.

It also says that records stay local, and that stored prompts can be redacted
or hashed. ADR-0012 left two questions to this ADR:
- **What the proxy captures from a request,** and how checks get it.
- **What is stored, and in what form.** Prompts carry the app's system prompt
  and its users' data. Results files leave the machine more often than the
  proxy does: they are uploaded as CI artifacts and shared in reviews.

## Decision

- **The proxy captures each call's messages while a recording is open.**
  - It reads them from the request body, as role and text:
    - OpenAI-compatible chat completions: `messages`;
    - the Responses API: `instructions` and `input`;
    - Anthropic Messages: `system` and `messages`;
    - embeddings: `input`.
  - Roles are normalised to `system` (which includes `developer`), `user`,
    `assistant`, `tool` and `input` (an embedding's input). Tool results are
    `tool`; tool-call arguments are the `assistant`'s.
  - Only text is kept. Images and other parts are left out.
  - A body the proxy can't read gives the call a `null` prompt. A check that
    needs it reports `unmeasured` (ADR-0014).
- **Prompt text stays in memory.** The proxy keeps the text only for an open
  recording, and hands it to the runner over the local control endpoint. The
  runner gives it to the checks. Neither of them writes it anywhere unless
  the profile says so.
  - The recording id becomes the key to that text. Only the runner that
    opened the recording knows it: `/_yokla/health` says whether a recording
    is open, no longer which one.
- **What is stored is set in the profile.** `modelProxy.prompts.store` applies
  to the results and to the proxy's records file:

  | `store` | Kept per message |
  |---|---|
  | `sizes` (default) | the role and the text's length in characters |
  | `hashed` | as `sizes`, plus the SHA-256 of the text |
  | `redacted` | as `sizes`, plus the text, with each match of the profile's `prompts.redact` patterns replaced by `[redacted]` |
  | `full` | as `hashed`, plus the text as sent |

  - `redacted` needs at least one pattern. An invalid pattern is a profile
    error.
  - A hash isn't anonymisation: a short value inside a known template can be
    guessed. That is why `sizes` is the default.
  - `redacted` keeps no hash. Next to the rest of the text, a hash of the
    original would let the removed values be guessed back.
  - `results.v1` gains, additively, a `prompt` on each attributed call and the
    store mode on the run's proxy summary.
  - Findings never quote prompt text. They name the call, the role and the
    value that was found, and that value comes from the case or the evidence.
- **Four inspection checks.** They are core checks. Each applies only where
  something declares it, so existing results don't change.
  - **`prompt-budget`.** The `budget` expectation gains `inputTokens`.
    - The turn passes when none of its model calls sent more input tokens than
      that. Input tokens are as the provider reports them, cached ones
      included.
    - A call without an input count makes the dimension `prompt-size`
      `unmeasured`.
  - **`prompt-leak`.** The profile can declare a canary,
    `modelProxy.inspect.canary`, which the app's system prompt contains.
    - The check fails when the answer contains the canary, ignoring case.
    - It passes when the canary was in a system message of the turn's calls
      and the answer doesn't contain it. Otherwise it doesn't apply.
    - A canary that reached no system prompt in the whole run is a run issue,
      because every pass would be vacuous.
    - The dimension is `leakage`.
  - **`untrusted-in-system`.** The profile names the evidence fields that hold
    retrieved content, as `modelProxy.inspect.untrusted`, for example
    `{ products: [name, description] }`.
    - The check fails when one of those values from the turn's evidence
      appears in a system message of the turn's calls. Such content belongs
      in a user or tool message, where it carries less authority.
    - Matching uses the language pack's folding, collapses whitespace and
      decodes JSON string escapes, so content embedded as JSON is still found.
    - Values of fewer than three words are skipped, since they can appear in
      a system prompt by chance.
    - The dimension is `untrusted-content`.
  - **`pii-in-prompt`.** A new core expectation, `notSentToModel`, lists
    values that must not reach the model. These are seeded fake personal data,
    for example a phone number in the user's message or a customer record in
    the test data.
    - The check fails when one of them appears in any message of the turn's
      calls, in any role.
    - Matching folds case and removes whitespace, dots, dashes and
      parentheses on both sides, so `0532 111 22 33` is also found as
      `05321112233`.
    - The dimension is `privacy`.
  - **Common rules.**
    - Without proxy data for the turn, a declared inspection is `unmeasured`,
      never a pass.
    - A turn with no model calls sent nothing, which is a measurement: the
      check passes.
- **The demo-shop gains a system prompt with a canary, and four inspection
  defects.**
  - **Correct behaviour:**
    - retrieved products go into the user message;
    - only the products the answer needs are sent;
    - phone numbers and e-mail addresses in the user's message are masked
      before the model call;
    - a guard keeps an answer that contains the system prompt from reaching
      the user. The fake provider, like a model that gives in to an extraction
      request, repeats its system prompt when asked for its instructions.
  - **Defects,** each caught only by its own check:
    - `catalog-in-system`: the products go into the system message;
    - `prompt-bloat`: the whole catalog goes into every prompt;
    - `unmasked-pii`: the user's personal data reaches the model;
    - `no-leak-guard`: the system prompt reaches the user. This is design
      §19's "leaking the system prompt", added in v0.2 with a hand-written
      case. v0.4's generated attacks must find it too.

## Consequences

- **The proxy holds the run's prompt text in memory** until the recording
  closes. Memory grows with the size of the run's prompts.
- **Debugging a finding needs the prompt.** With the default `sizes`, the
  finding says where a value was found, but the prompt itself isn't kept. A
  rerun with `store: full` or `redacted` keeps it.
- **Targets the proxy can't see get no inspection.** Logs don't carry prompts
  (ADR-0009). This includes the target examined so far.
- **Reading prompts needs the protocol,** like changing answers does
  (ADR-0013). Another protocol needs its own reader.

## Alternatives considered

- **Storing prompt text by default.** It makes debugging easiest. Rejected:
  results files travel, and prompts carry the app's instructions and its
  users' data.
- **Hashes by default.** Nothing reads them yet, and a hash isn't
  anonymisation. They remain an opt-in.
- **Running the inspections in the proxy.** The proxy would need the cases'
  expectations and a second copy of the check API. The proxy captures; core
  checks judge.
- **`prompt-leak` by long n-gram runs, without a canary.** Design §10 describes
  this. It needs no setup, but it flags text an app repeats on purpose, such
  as a disclaimer from its system prompt. Deferred to v0.4, where
  system-prompt extraction attacks come with an allowlist.
- **Detecting PII by pattern** (phone numbers, e-mail addresses, national ids
  with their checksums) instead of seeded values. That finds real data, but
  order numbers and similar values match too. Seeded values are exact. Packs
  can add pattern detectors later, and default redaction patterns with them.
- **Untrusted content marked by seeded markers.** That needs a test copy of
  the target's content, which comes with v0.4's indirect injection. Evidence
  works on any target now. Markers will extend the same check.
- **Prompt size in characters.** Characters are always measurable, and they are
  stored. But tokens are what limits a call and what it costs.
