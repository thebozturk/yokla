# yokla guide

How to test your own assistant with yokla 0.2. The
[design](../design.md) explains why yokla works this way, and the
[ADRs](../adr/README.md) record each decision.

| Page | What it covers |
|---|---|
| [The profile](profile.md) | Reaching the target, reading its answer and evidence, sessions, limits, logs, the model proxy and the e-commerce data. |
| [Cases](cases.md) | Turns, expectations, provider faults and case statuses. |
| [Checks](checks.md) | Every check: what it judges, and when it applies. |
| [The model proxy](model-proxy.md) | Seeing the app's model calls, their cost and prompts, and making the provider fail. |
| [Commands, configuration and the gate](cli.md) | Every command and option, `yokla.config.yaml`, the gate and the baseline. |

## A first run

From a checkout of this repository, with Node.js 24 or later and pnpm, run
`pnpm install` once.

1. **Write a profile** that says how to reach your assistant and where its
   answer is. For a chat API that takes `{"message": ...}` and answers
   `{"reply": ...}`:

   ```yaml
   # yokla.profile.yaml
   version: 1
   target:
     name: my-assistant
     adapter: http
     request:
       url: http://127.0.0.1:8080/chat
       headers: { authorization: 'Bearer {{env.ASSISTANT_TOKEN}}' }
       body: { message: '{{message}}', session: '{{session}}' }
     response:
       text: $.reply
   languages: [en]
   domain: ecommerce
   ```

2. **Write a case** with what the answer must and must not say:

   ```yaml
   # cases/basics.yaml
   version: 1
   cases:
     - id: greeting
       suite: quality
       language: en
       turns:
         - user: Hello! What can you help me with?
           expect:
             answer: { notContains: [error, exception] }
             deadlineMs: 5000
   ```

3. **Run it, then gate it:**

   ```sh
   export ASSISTANT_TOKEN=...      # the profile reads it; a missing one stops the run
   pnpm yokla run --profile yokla.profile.yaml --cases cases
   pnpm yokla gate --results runs/<run id>.json
   ```

   `run` prints a summary and writes the results file. `gate` exits with `0`,
   `1` or `2`, ready for CI.

4. **Grow it from there:**
   - **Product evidence:** map the products your assistant returns as
     evidence. The e-commerce checks then judge its prices, stock claims and
     filters ([profile](profile.md#evidence), [checks](checks.md)).
   - **Model calls:** put the model proxy in front of the app to see its model
     calls and cost ([model proxy](model-proxy.md)).
   - **Baseline:** accept a good run with `yokla baseline`, so a later
     regression breaks the gate ([CLI](cli.md#yokla-baseline)).

[`examples/demo-shop`](../../examples/demo-shop/README.md) is a complete,
runnable example: a small shop assistant with seeded defects, its profile and
its cases.
