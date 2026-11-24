# @yokla/report

The reports of [yokla](https://www.npmjs.com/package/yokla): a terminal
summary, JUnit XML for CI, a Markdown summary for a CI job's page, an offline
HTML report that shows each answer next to its findings, and a page that sets
runs of the same cases side by side. The terminal summary and the HTML report
group failing findings by the frameworks they map to, with each attack kind's
risk.

It depends only on `@yokla/core`. Most people run `yokla report`,
`yokla gate --markdown` or `yokla compare --html` instead. The guide in the
yokla repository (`docs/guide/`) documents it.

## License

Apache-2.0
