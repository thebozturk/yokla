# @yokla/proxy

The model proxy of [yokla](https://www.npmjs.com/package/yokla). It sits
between an app and its model providers (OpenAI-compatible, Anthropic and
Gemini), records each model call with its tokens, cost and latency, can
inject provider faults a case declares, and can change the tools' results and
descriptions before the model sees them.

It listens on `127.0.0.1` only, and forwards the app's own calls to the
upstreams the profile names.

It depends only on `@yokla/core`. Most people run `yokla proxy` instead. The
guide in the yokla repository (`docs/guide/`) documents it.

## License

Apache-2.0
