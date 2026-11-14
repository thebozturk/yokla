# 0026. Evidence from the tool results the model saw

Status: Accepted · Date: 2026-11-14

## Context

On the open-source target, an answer said that "the closest match is the
ACME Signature 15-Bar Espresso Machine at $329, and it's currently out of
stock". Both facts were right. The target showed only one product, though: a
drip coffee maker it offered as a stand-in. So yokla judged the answer
against that product alone.

- **`price-grounded`** couldn't ground "$329". The `$199` cooler earlier had
  the same gap; design §20 lists it for later.
- **`stock-claim`** read "it's currently out of stock" as a claim that names
  no returned product. It applied the claim to the drip coffee maker, which
  is in stock, and failed it.

The facts the answer used were in front of the model. Its `search_products`
call returned the espresso machine with its price and its stock. The app
sent that result back to the model in the next call, and the model proxy saw
it there. ADR-0015 captures it as a `tool` message, but nothing reads it as
evidence.

## Decision

### What the proxy reads

- **Which tool a result answers.** For each tool result in a call's request,
  the proxy records the name of the tool it answers.
- **How it finds the name.** From the tool call with the same id in the same
  request:
  - chat completions: `tool_call_id`;
  - the Responses API: `call_id`;
  - Anthropic: `tool_use_id`.
- **Where it goes.** The name is kept on the prompt message, as `tool`, and
  always stored. results.v1 gains it as an optional field. The text stays as
  `prompts.store` keeps it (ADR-0015).

### What the profile maps

`modelProxy.toolResults` maps, per tool, evidence collections in the same
form as `response.evidence`:

```yaml
modelProxy:
  toolResults:
    search_products:
      products:
        items: $.results[*]
        fields: { id: product_id, name: title, price: price, inStock: { from: in_stock, as: boolean } }
```

- **Collection names.** A collection must be one that `response.evidence`
  maps, so the packs know what it holds.
- **Reading a result.** A result is read as JSON: its whole text, or else
  the text from its first `{` to its last `}`. That covers a payload behind
  a header line or between fence tags.
  - A mapped tool's result that is neither gives nothing. The turn notes it
    as an issue.

### What the checks see

- **A turn's seen evidence.** It is the items of every mapped tool result in
  the prompts of the turn's model calls.
  - Results an app sends again from earlier turns count, as earlier turns'
    products do for `price-grounded`.
  - Items are deduplicated by id.
- **Kept apart from the returned evidence.** Seen items are what the model
  was given, not what the user was shown.
  - The checks that judge what the answer shows don't see them: filters,
    types, duplicates and evidence counts.
  - The results keep the seen items with the turn, as `seen`, next to
    `evidence`.
- **`price-grounded`.** The price of a product the model saw grounds an
  amount, as a returned product's price does.
  - The same rules apply to it: a stated quantity (ADR-0021), and totals
    (ADR-0022).
  - The finding names where the price came from: "product AR-1009, seen in
    search_products".
- **`stock-claim`.** A claim in a sentence that names a seen product, and no
  returned one, is judged against that product's stock. It no longer applies
  to the returned products. A sentence that names no product at all still
  applies to every returned product (ADR-0021).
- **Applicability.** Both checks now apply when a returned or seen product
  has the field they need.

### Without the proxy or a mapping

Nothing changes. A target whose calls the proxy can't see has no seen
evidence. Its answers are judged as before.

## Consequences

- **Agents are judged on what they were told.** On the open-source target,
  "$329" and the claim that the espresso machine is out of stock are judged
  against the search result the model got.
  - A product the model saw but the answer misprices still fails.
  - So does a stock claim that contradicts what the model saw.
- **Fewer false alarms where answers name products they don't show:**
  stand-ins, comparisons, and items left out of a plan.
- **Tool results can hold personal data,** such as an order history or a
  profile.
  - Only the fields the profile maps are kept, as with `response.evidence`,
    and only for the tools it names.
  - The prompt text stays as `prompts.store` keeps it.
- **The design §20 gap narrows.** The price of a product an answer names but
  doesn't return is grounded when the model saw it in a tool result. It
  stays a gap when the proxy can't see the target's calls.
- **The demo-shop is unchanged.** It passes its products to the model in the
  user message, not as tool results.
  - Unit tests and a runner test cover the feature.
  - So does a run on the open-source target, which costs money and is
    approved separately.

## Alternatives considered

- **Finding named products in the catalog snapshot.** A snapshot can be
  older than what the model saw. The real target's workspace has none, and
  matching names across a whole catalog is looser than matching the few
  products the model got. Deferred, as a complement.
- **Adding seen items to the returned evidence.** The filter, type and
  duplicate checks would then judge products the user never saw. Rejected.
- **Reading the tool results the target streams to its UI.** That is
  specific to one target, and a UI often shows a summary only. Rejected:
  the model's own input is the same for every agent.
- **Grounding on any number in a tool result.** Any amount near any number
  would pass. Rejected: only mapped fields count.
