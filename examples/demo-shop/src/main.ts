// Starts the demo-shop: node src/main.ts [--port 3000] [--defect <name>] [--rate-limit off]
//   [--model-url <OpenAI-compatible base URL>] [--model-stream] [--model-timeout-ms 3000]
//   [--model-canary <text>] [--model-summary] [--model-protocol chat-completions|gemini]
//   [--otel-url <OTLP/HTTP traces endpoint>] [--otel-protocol json|protobuf] [--otel-delay-ms 5000]
//   [--auth] [--token-ttl-ms 3600000] [--token-uses <n>]

import { parseArgs } from 'node:util';
import { Assistant } from './assistant.ts';
import { loadShopData } from './catalog.ts';
import { DEFECT_DESCRIPTIONS, DEFECTS, parseDefect } from './defects.ts';
import { ScriptedModel } from './model.ts';
import { TokenIssuer } from './auth.ts';
import { parseOtelProtocol, SpanExporter } from './otel.ts';
import { parseModelProtocol, RemoteModel } from './remote-model.ts';
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
      'model-canary': { type: 'string' },
      'model-summary': { type: 'boolean' },
      'model-protocol': { type: 'string' },
      'otel-url': { type: 'string' },
      'otel-protocol': { type: 'string' },
      'otel-delay-ms': { type: 'string' },
      auth: { type: 'boolean' },
      'token-ttl-ms': { type: 'string' },
      'token-uses': { type: 'string' },
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
  // A GenAI span for each model call over HTTP, as OpenTelemetry's exporter settings name it (ADR-0029).
  const otelUrl = values['otel-url'] ?? process.env['OTEL_EXPORTER_OTLP_TRACES_ENDPOINT'];
  const protocol = parseOtelProtocol(values['otel-protocol'] ?? 'json');
  if (protocol === undefined) throw new Error('--otel-protocol must be "json" or "protobuf"');
  const delayMs = Number(
    values['otel-delay-ms'] ?? process.env['OTEL_BSP_SCHEDULE_DELAY'] ?? '5000',
  );
  if (!Number.isInteger(delayMs) || delayMs < 0)
    throw new Error('--otel-delay-ms must be a whole number of milliseconds');
  if (otelUrl !== undefined && modelUrl === undefined)
    throw new Error('--otel-url needs --model-url: only model calls over HTTP become spans');
  const modelProtocol = parseModelProtocol(values['model-protocol'] ?? 'chat-completions');
  if (modelProtocol === undefined)
    throw new Error('--model-protocol must be "chat-completions" or "gemini"');
  const spans =
    otelUrl === undefined ? undefined : new SpanExporter({ url: otelUrl, protocol, delayMs });
  const model =
    modelUrl === undefined
      ? new ScriptedModel(defect)
      : new RemoteModel({
          url: modelUrl,
          key: process.env['DEMO_SHOP_MODEL_KEY'] ?? 'demo-key',
          stream: values['model-stream'] === true,
          timeoutMs: Number(values['model-timeout-ms'] ?? '3000'),
          defect,
          ...(values['model-canary'] === undefined ? {} : { canary: values['model-canary'] }),
          ...(spans === undefined ? {} : { spans }),
          protocol: modelProtocol,
          // Gemini names its models; the provider answers as it does over chat completions.
          ...(modelProtocol === 'gemini' ? { model: 'gemini-demo-1' } : {}),
        });
  // Bearer tokens the chat requires, from the shop's own token endpoints (ADR-0031).
  const ttlMs = Number(values['token-ttl-ms'] ?? '3600000');
  const maxUses = values['token-uses'] === undefined ? undefined : Number(values['token-uses']);
  if (!Number.isInteger(ttlMs) || ttlMs < 1)
    throw new Error('--token-ttl-ms must be a whole number of milliseconds, 1 or more');
  if (maxUses !== undefined && (!Number.isInteger(maxUses) || maxUses < 1))
    throw new Error('--token-uses must be a whole number, 1 or more');
  const auth =
    values.auth === true
      ? new TokenIssuer({
          clientId: process.env['DEMO_SHOP_CLIENT_ID'] ?? 'demo-shop-client',
          clientSecret: process.env['DEMO_SHOP_CLIENT_SECRET'] ?? 'demo-shop-secret',
          username: process.env['DEMO_SHOP_USER'] ?? 'tester',
          password: process.env['DEMO_SHOP_PASSWORD'] ?? 'demo-password',
          ttlMs,
          ...(maxUses === undefined ? {} : { maxUses }),
        })
      : undefined;
  const assistant = new Assistant({ data: loadShopData(), model, defect });
  const server = createDemoShopServer({
    assistant,
    rateLimit: rateLimitSetting === 'off' ? false : DEFAULT_RATE_LIMIT,
    summarizeAfterAnswer: values['model-summary'] === true,
    ...(auth === undefined ? {} : { auth }),
  });

  // Loopback only: the demo-shop is a local test target.
  server.listen(port, '127.0.0.1', () => {
    const address = server.address();
    const actual = typeof address === 'object' && address !== null ? address.port : port;
    console.log(
      `demo-shop listening on http://127.0.0.1:${String(actual)} (defect: ${defect ?? 'none'}, model: ${modelUrl ?? 'in process'}${otelUrl === undefined ? '' : `, spans: ${protocol}`}${auth === undefined ? '' : ', auth: bearer tokens'})`,
    );
  });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      server.close();
      // The spans still waiting for their batch go out before the process ends.
      void spans?.flush();
    });
  }
}

try {
  main();
} catch (error) {
  console.error(`demo-shop: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 2;
}
