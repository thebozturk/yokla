# 0025. Tool calls: what the proxy reads, and the checks on them

Status: Proposed · Date: 2026-11-14

## Context

Most sales assistants are agents: the model asks for tools, such as a
product search, a policy lookup or adding to a cart, and the app runs them.
Whether it asked for the right ones, with the right arguments and in the
right order, often doesn't show in the answer:

- A search that drops the user's price limit can still give a right answer
  if the app filters afterwards.
- A product added to the cart without the user asking leaves the answer text
  as it was.
- A search asked for twice costs twice and says nothing.

v0.3's exit criteria ask for the demo-shop's tool-call defects to be
detected, on what the proxy records. Today the proxy records neither the
tools a call offers nor the calls the model asks for. Its prompt reader
(ADR-0015) folds a tool call's arguments into the assistant's text, as text
to inspect, not as calls. The demo-shop has no tools: its model answers
the "interpret" call with a JSON text.

## Decision

### What the proxy reads

For every call, while a recording is open:

- **The tools offered:** the names in the request's `tools`, for
  OpenAI-compatible chat completions, the Responses API and Anthropic
  Messages.
- **The tool calls asked for:** each tool name and its arguments, in order,
  from the answer.
  - Chat completions: the message's `tool_calls`.
  - The Responses API: its `function_call` output items.
  - Anthropic: its `tool_use` blocks.
  - From a JSON answer and from an event stream, the pieces of a streamed
    call joined.
- **Arguments** are kept as the text the model sent. A check parses them as
  JSON. An answer the proxy can't read gives no list rather than an empty
  one, so a check that needs it says it couldn't measure.

### What is stored

- **The names** of tools offered and asked for are always stored.
- **Arguments** can hold personal data, so they follow `prompts.store`, as
  prompt text does (ADR-0015):
  - `sizes` keeps their length;
  - `hashed` adds their SHA-256;
  - `redacted` keeps them with the profile's patterns replaced;
  - `full` keeps them.
- **The checks** see the full arguments during the run, whatever is stored.
- **Results.** results.v1 gains these as optional fields of each model call
  (ADR-0007). The HTML report shows the names (ADR-0023).

### The turn's trajectory

- **Which calls count.** A turn's tool calls are those of the model calls
  the proxy tied to it (ADR-0012), in the order the calls started. Within a
  call, they keep the order the model gave.
- **What it includes.** Calls the target makes after its answer count too
  (ADR-0016).

### Two checks

**`tool-calls`** judges what the turn's case expects of its tool calls:

```yaml
expect:
  tools:
    called: [search_products]                  # each, at least once
    notCalled: [add_to_cart]                   # none of these
    args:                                      # some call of the tool has these values
      search_products: { productType: tent, priceMax: 500 }
    order: [search_products, add_to_cart]      # in this order, others between allowed
    maxCalls: 2                                # at most this many tool calls
```

- **`args`.** A field is a dotted path into the parsed arguments. Its value
  must equal the expected one, as JSON. A call whose arguments aren't valid
  JSON matches nothing.
- **Applicability.** It is not applicable without a `tools` expectation. It
  is `unmeasured` without proxy data for the turn, or when an answer couldn't
  be read: a trajectory yokla didn't see is never a pass.
- **The finding** names what is missing or extra, by tool and field. It
  never quotes the target's arguments, which the results may not keep.

**`tool-call-valid`** needs no expectation. Every tool a model asks for was
offered by that same call, and its arguments are valid JSON.

- **When it applies.** Only when a call of the turn offered tools.
- **What it guards against.** An app that runs an unoffered tool, or reads
  broken arguments, is relying on the model to get it right.

Both checks use the dimension `tool-use`.

### The demo-shop

With the model over HTTP, the demo-shop becomes a tool-using app:

- **The tools.**
  - Its interpret call offers `search_products`, `get_policy` and
    `cheapest_shown`. The fake provider answers with the matching tool call,
    in JSON and in a stream. Refusals and fallbacks stay plain answers.
  - The call that writes about products offers `add_to_cart`.
- **The cart.** The app runs the calls, and keeps a cart per session.
- **Two new defects:**
  - **`unrequested-cart`.** When it writes about products, the model also
    asks to add the first one to the cart, and the app does it without being
    asked.
  - **`repeated-search`.** The app asks the model for the same search twice
    in one turn.
- **Their cases.** A new case set, `cases-tools`, expects the trajectory of
  each turn. It runs in the proxy end-to-end test.
  - Without defects, every case passes.
  - With each defect, exactly `tool-calls` fails, on exactly the expected
    cases.
- **The in-process run is unchanged.** Its answers stay the same, and the
  acceptance cases set no tool expectations, which would be unmeasured
  there.

## Consequences

- **A trajectory is checked as a claim.** It is checked against what the case
  expects. Deterministic checks still come first: no model judges whether a
  call was sensible.
- **What a case can and can't say.**
  - "Never add to the cart unless asked" is a case expectation, per turn.
  - A profile-wide list of side-effect tools is left for when cases show
    it's needed.
- **Arguments are as private as prompts.** `sizes`, the default, stores none.
- **The finding never quotes arguments.** A person who wants to see a failing
  call's arguments sets `prompts.store` to `full` for that run.
- **Calls the proxy can't see stay unmeasured.** OpenTelemetry spans,
  planned for v0.3, are the way to reach them.

## Alternatives considered

- **Reading tool calls from the next request's history** instead of from the
  answer. A turn's last call has no next request, and the history can be
  trimmed. Rejected.
- **A generic check that the same call is never repeated.** A retry after a
  tool error repeats a call legitimately. `maxCalls` lets a case say how many
  calls are fine. Rejected.
- **Judging a trajectory with a model.** It would make expectations depend
  on a judge, against ADR-0005's order. Deferred to the judge checks of
  v0.5.
- **Stopping the turn at a call the case forbids.** yokla observes; it
  doesn't block the target's calls. Rejected.
