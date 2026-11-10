// Starts the fake provider: node src/provider-main.ts [--port 0] [--key demo-key]
//   [--usage-log <file>] [--defect <model defect>]

import { appendFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { parseDefect } from './defects.ts';
import { createFakeProvider } from './fake-provider.ts';

function main(): void {
  const { values } = parseArgs({
    options: {
      port: { type: 'string' },
      key: { type: 'string' },
      'usage-log': { type: 'string' },
      defect: { type: 'string' },
    },
  });
  const port = Number(values.port ?? '0');
  if (!Number.isInteger(port) || port < 0 || port > 65_535)
    throw new Error(`invalid port "${String(values.port)}"`);
  const log = values['usage-log'];
  const server = createFakeProvider({
    key: values.key ?? 'demo-key',
    defect: parseDefect(values.defect),
    ...(log === undefined
      ? {}
      : {
          onUsage: (entry) => {
            appendFileSync(log, `${JSON.stringify(entry)}\n`);
          },
        }),
  });
  server.listen(port, '127.0.0.1', () => {
    const address = server.address();
    const actual = typeof address === 'object' && address !== null ? address.port : port;
    console.log(`fake provider listening on http://127.0.0.1:${String(actual)}/v1`);
  });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      server.close();
    });
  }
}

try {
  main();
} catch (error) {
  console.error(`fake provider: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 2;
}
