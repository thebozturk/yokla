// The network guard (ADR-0003) in a child yokla process, for the MCP
// end-to-end test: `node --import` loads it before yokla mcp starts. It allows
// connections to 127.0.0.1 on the ports YOKLA_GUARD_PORTS lists, stops every
// other, and appends each attempt to YOKLA_GUARD_LOG for the test to read.
// Test code: a *.test.* file, so no package ships it.

import { appendFileSync } from 'node:fs';
import { installNetworkGuard } from '@yokla/runtime/testing';

const ports = new Set(
  (process.env['YOKLA_GUARD_PORTS'] ?? '')
    .split(',')
    .filter((port) => port !== '')
    .map(Number),
);
const log = process.env['YOKLA_GUARD_LOG'];

installNetworkGuard((host, port) => {
  const allowed = host === '127.0.0.1' && port !== undefined && ports.has(port);
  if (log !== undefined) appendFileSync(log, `${JSON.stringify({ host, port, allowed })}\n`);
  return allowed;
});
