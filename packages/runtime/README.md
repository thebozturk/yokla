# @yokla/runtime

The runtime of [yokla](https://www.npmjs.com/package/yokla): the runner, which
also judges answers another tool got as a run would, the HTTP and WebSocket
target adapters, tokens yokla obtains, yokla's own models (the simulated
customer, the transforms, the attacker and the judge) with their reply
caches, the cost cap and file system access.

- `@yokla/runtime` runs cases against a target.
- `@yokla/runtime/testing` holds helpers for tests that must not reach the
  network.

It depends only on `@yokla/core`. Most people run the `yokla` command instead.
The guide in the yokla repository (`docs/guide/`) documents it.

## License

Apache-2.0
