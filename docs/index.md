# yokla

yokla tests conversational AI assistants end to end. It sends your
assistant real conversations over HTTP or WebSocket, reads what it answered
and what its model was given, and checks every claim against your own data:
a price against your catalog, a stock claim against your stock, a policy
against your policy pages. A verdict is a set of checks, each pass, fail or
unmeasured, and your CI gates on it.

- **[A first run](guide/README.md):** a profile and starter cases from one
  message to your assistant, then a run and a gate, at no model cost.
- **[The guide](guide/README.md):** the workflows, from the analyzer to red
  teaming, and a page for each part.
- **[The design](design.md)** says why yokla works this way, and the
  **[decisions](adr/README.md)** record each choice.

```sh
npx yokla init --url http://127.0.0.1:3000/chat
npx yokla run
npx yokla gate --results runs/<run id>.json
```

No data leaves your machine unless you send it, and there is no telemetry.
yokla is Apache-2.0, and its code is on
[GitHub](https://github.com/thebozturk/yokla).
