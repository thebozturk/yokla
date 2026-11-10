// Starts the demo-shop: node src/main.ts [--port 3000] [--defect <name>] [--rate-limit off]
//   [--model-url <OpenAI-compatible base URL>] [--model-stream] [--model-timeout-ms 3000]

import { parseArgs } from 'node:util';
import { Assistant } from './assistant.ts';
import { loadShopData } from './catalog.ts';
import { DEFECT_DESCRIPTIONS, DEFECTS, parseDefect } from './defects.ts';
import { ScriptedModel } from './model.ts';
import { RemoteModel } from './remote-model.ts';
import { createDemoShopServer, DEFAULT_RATE_LIMIT } from './server.ts';

function main(): void {
  const { values } = parseArgs({
    options: {
      port: { type: 'string' },
      defect: { type: 'string' },
      'rate-limit': { type: 'string' },
      'list-defects': { type: 'boolean' },
      'model-url': { type: 'string' },
      'model-stream': { type: 'boolean' },
      'model-timeout-ms': { type: 'string' },
    },
  });

  if (values['list-defects'] === true) {
    for (const defect of DEFECTS) console.log(`${defect}: ${DEFECT_DESCRIPTIONS[defect]}`);
    return;
  }

  const defect = parseDefect(values.defect ?? process.env['DEMO_SHOP_DEFECT']);
  const port = Number(values.port ?? process.env['PORT'] ?? '3000');
  if (!Number.isInteger(port) || port < 0 || port > 65_535)
    throw new Error(`invalid port "${String(values.port)}"`);
  const rateLimitSetting = values['rate-limit'] ?? 'on';
  if (rateLimitSetting !== 'on' && rateLimitSetting !== 'off')
    throw new Error('--rate-limit must be "on" or "off"');

  // With a model URL both model calls of a turn go over HTTP; model defects
  // then belong to that provider, and only the app's own defects apply here.
  const modelUrl = values['model-url'] ?? process.env['DEMO_SHOP_MODEL_URL'];
  const model =
    modelUrl === undefined
      ? new ScriptedModel(defect)
      : new RemoteModel({
          url: modelUrl,
          key: process.env['DEMO_SHOP_MODEL_KEY'] ?? 'demo-key',
          stream: values['model-stream'] === true,
          timeoutMs: Number(values['model-timeout-ms'] ?? '3000'),
          defect,
        });
  const assistant = new Assistant({ data: loadShopData(), model, defect });
  const server = createDemoShopServer({
    assistant,
    rateLimit: rateLimitSetting === 'off' ? false : DEFAULT_RATE_LIMIT,
  });

  // Loopback only: the demo-shop is a local test target.
  server.listen(port, '127.0.0.1', () => {
    const address = server.address();
    const actual = typeof address === 'object' && address !== null ? address.port : port;
    console.log(
      `demo-shop listening on http://127.0.0.1:${String(actual)} (defect: ${defect ?? 'none'}, model: ${modelUrl ?? 'in process'})`,
    );
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
  console.error(`demo-shop: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 2;
}
