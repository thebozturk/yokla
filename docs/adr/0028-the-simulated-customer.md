# 0028. The simulated customer, and yokla's own model calls

Status: Accepted · Date: 2026-11-14

## Context

A case today is a fixed list of turns. Real customers react to what the
assistant says: they narrow a search, ask for something cheaper, pick a
product and put it in the cart. A fixed list can't follow an answer it didn't
foresee.

v0.3 plans a simulated customer: a model plays a customer with a goal, and
the deterministic checks judge every turn. Its exit criteria are:

- the simulated customer reaches each demo-shop purchase goal;
- a run repeats from its seed.

The simulated customer is the first feature that needs yokla's own model
calls. Design §6 plans a `ModelClient` in `runtime` for them, with its own
budget, using providers the user configures, local models included.
ADR-0014 counts yokla's own calls as zero until such a feature adds them.

## Decision

### yokla's own model calls

- **They are configured in `yokla.config.yaml`.** The configuration says how
  yokla judges, and this model is one of yokla's means.

  ```yaml
  models:
    customer:
      kind: openai-compatible           # or anthropic
      url: http://127.0.0.1:11434/v1    # a local model keeps everything on the machine
      model: qwen2.5:7b
      apiKeyEnv: CUSTOMER_API_KEY       # optional; the key is read from the environment
      temperature: 0                    # the default
      price: { input: 0.15, output: 0.6 }   # USD per million tokens, as in prices
  ```

- **The client.**
  - A `ModelClient` in `runtime` sends these calls. It contacts only the
    configured urls, as design §15 allows.
  - The calls never go through the model proxy, which records the target's
    calls only.
- **What leaves the machine.** A hosted model receives the conversation,
  the target's answers included.
  - Configuring one is the user's choice. Without `models.customer`, no case
    can use a simulated customer.
  - The guide says plainly what is sent.
- **Their cost is counted.**
  - Each call's usage and cost go into the results, apart from the target's.
  - A model without a price has no cost: `null`, never 0.
  - `--max-cost` counts yokla's own spend with the target's.
  - Without a model proxy, `--max-cost` caps yokla's own spend alone, and
    the run says that the target's cost is unknown. This amends ADR-0014,
    which needed a proxy for the cap.
  - `yokla plan` counts yokla's own calls from the calibration run too.

### The case

A case gives a customer instead of turns:

```yaml
- id: light-tent-to-cart-tr
  suite: quality
  language: tr
  customer:
    persona: İki kişi kamp yapacak, bütçesi 1.500 TL, hafif bir çadır istiyor.
    goal: 1.500 TL altında, stokta olan bir çadırı sepete eklemek.
    opening: Merhaba, kamp için çadır bakıyorum.   # optional: the first message, as written
    maxTurns: 6
    reached:                                        # judged after every answer
      evidence: { cart: { min: 1 } }
    expect: { language: tr, answerable: true }      # applied to every turn
```

- **How the conversation goes.** The first message is `opening`, or else the
  customer's. After each answer:
  - yokla judges `reached`;
  - when it holds, the conversation ends there;
  - otherwise the customer model writes the next message.
  - The conversation also ends at `maxTurns`.
- **`reached` is judged from the answer alone.** It uses the expectations
  `route`, `answer` and `evidence`, with the checks that judge them, so it
  needs no model proxy.
- **The customer's prompt is yokla's.** It is one template per language,
  Turkish and English, and nothing in it is about a particular assistant.
  - It holds the persona, the goal and the conversation so far.
  - It asks for the customer's next message only.
  - The target's answers go in as the other party's messages.
- **Judging.**
  - Every turn is judged by every check, with `customer.expect` as its
    expectations.
  - `goal-reached` (dimension `task-success`) judges the conversation: the
    goal was reached within `maxTurns`.
  - A customer call that fails is an error of the case, never a pass.

### Seeds and repeats

- **Each sample has a seed:** the case id and the sample number, as fault
  jitter does (ADR-0017). It is sent to the customer model where the
  provider takes one, with temperature 0 by default.
- **Customer replies are cached** in `yokla-data/customer/`. The key is the
  SHA-256 of:
  - the model's configuration;
  - the persona, the goal and the language;
  - the seed;
  - the conversation so far.
- **What a rerun repeats.** With the cache, a rerun repeats every customer
  message while the target answers the same. Once it answers differently,
  the customer is asked anew from there.
  - `--fresh-customer` ignores the cache.
  - The cache holds target data, so it stays out of version control with
    the rest of `yokla-data/` (design §15).
- **What the results keep, for each sample:**
  - the seed;
  - how the conversation ended (`reached`, or `maxTurns`) and at which turn;
  - the customer's calls, their cost, and how many came from the cache.
  - The customer's messages are the turns' `user` messages, as in any case.

### The demo-shop and CI

- **The demo-shop gains a cart route.** A message such as "add the first one
  to the cart" puts that product in the session's cart. The answer then
  lists the cart.
  - With the model over HTTP, the interpret call also offers `add_to_cart`.
    This amends ADR-0025.
  - The demo-shop profile maps the cart as the evidence collection `cart`.
- **The fake provider plays the customer too.**
  - It recognises yokla's customer prompt by its first line.
  - It answers by simple rules over the demo-shop's vocabulary: ask for the
    goal's product with its limits, then put the first fitting product in the
    cart.
  - A CI run costs nothing.
- **The cases.** `cases-customer/` holds three purchase goals, Turkish and
  English.
  - The end-to-end test checks that the customer reaches each goal, and
    that every turn passes the checks.
  - A second run from the cache gives the same conversations.
  - The egress test allows the fake customer's port only.
- **A run against a real model** is manual and costs money. `yokla plan`
  estimates it first.

## Consequences

- **Conversations follow the target.** A customer that asks for something
  cheaper after seeing the prices tests what fixed turns can't.
- **The deterministic checks keep judging.** The customer model drives the
  conversation and never judges it. A goal is reached by the answer's own
  evidence, not by the customer saying so.
- **yokla now has spend of its own,** counted, priced and capped apart from
  the target's.
- **Repeats hold while the target holds.** A different answer leads to a
  different conversation from that point. That is the target changing, and
  the gate sees it.
- **The cache holds the target's answers,** in its keys and values. It stays
  out of version control.
- **Not part of this ADR:**
  - a customer that gives up before `maxTurns`;
  - several customers in one case;
  - judging the customer's realism.

## Alternatives considered

- **Judging the goal with the customer model** ("did you get what you
  wanted?"). It would put a model's opinion in the verdict, against
  ADR-0005. Rejected.
- **Configuring the customer model in the profile.** The profile describes
  the target; yokla's own means belong to the configuration, as prices and
  thresholds do. Rejected.
- **Repeating only through the provider's seed.** Many providers ignore it,
  and local models vary across versions. The cache makes repeats exact.
  Rejected as the only means.
- **Routing the customer's calls through the model proxy.** They would mix
  with the target's calls and their correlation. Rejected.
- **A fixed script in the fake provider, per case.** It would test the loop
  but not a customer that reacts. The rules react to the answers they get.
  Rejected.
