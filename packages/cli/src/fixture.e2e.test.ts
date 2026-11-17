// Freshness (ADR-0053, ADR-0054): the demo-shop's acceptance cases run on a
// copy whose catalog has gained a hammock and lost its water bottles.
// hammock-en and water-bottle-en are fixture-missing, each with the fact that
// changed, and the shop receives no request for them; every other case
// passes, as on the unchanged catalog. The run can't be judged: it exits with
// 2 and names both. run.data names the catalog the run was judged on. No
// model cost, behind the network guard.

import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Results } from '@yokla/core';
import { HttpClient } from '@yokla/runtime';
import {
  installNetworkGuard,
  startTestServer,
  type NetworkGuard,
  type TestServer,
} from '@yokla/runtime/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { main } from './main.ts';

const DEMO = new URL('../../../examples/demo-shop/', import.meta.url).pathname;
const work = mkdtempSync(join(tmpdir(), 'yokla-fixture-'));
const shop = join(work, 'demo-shop');
const catalogPath = join(shop, 'data', 'catalog.jsonl');
const out = join(work, 'results.json');
const children: ChildProcess[] = [];
const ports = new Set<number>();
let guard: NetworkGuard | undefined;
let forwarding: TestServer | undefined;
/** The user messages the shop received, through the forwarder. */
const sent: string[] = [];
let ran: { code: number; output: string } | undefined;
let gated: { code: number; output: string } | undefined;

const HAMMOCK = {
  id: 'HMK-001',
  category_path: 'outdoor/camping/hammock',
  name_tr: 'Kamp Hamağı',
  name_en: 'Camping Hammock',
  price: 899.9,
  currency: 'TRY',
  stock: 5,
  color: 'green',
};

/** The catalog with a hammock, and without its water bottles. */
function changeCatalog(): void {
  const rows = readFileSync(catalogPath, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '' && !line.includes('"outdoor/hydration/water-bottle"'));
  writeFileSync(catalogPath, `${[...rows, JSON.stringify(HAMMOCK)].join('\n')}\n`);
}

/** Starts the copy's shop, which reads the copy's catalog, and resolves with its URL. */
function startShop(): Promise<string> {
  const child = spawn(
    process.execPath,
    [join(shop, 'src/main.ts'), '--port', '0', '--rate-limit', 'off'],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  children.push(child);
  return new Promise<string>((resolve, reject) => {
    let output = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
      const url = /http:\/\/127\.0\.0\.1:\d+/u.exec(output)?.[0];
      if (url !== undefined) {
        ports.add(Number(new URL(url).port));
        resolve(url);
      }
    });
    child.on('exit', (code) => {
      reject(new Error(`demo-shop exited early with ${String(code)}`));
    });
  });
}

/** The message a request body sends, if it sends one. */
function messageOf(body: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(body);
    const message: unknown =
      typeof parsed === 'object' && parsed !== null ? Reflect.get(parsed, 'message') : undefined;
    return typeof message === 'string' ? message : undefined;
  } catch {
    return undefined;
  }
}

const HOP_BY_HOP = new Set([
  'connection',
  'content-length',
  'content-encoding',
  'transfer-encoding',
]);

/** Sends a request on to the shop, and gives back its status, headers and body. */
async function forward(
  base: string,
  method: string,
  path: string,
  headers: Readonly<Record<string, string | string[] | undefined>>,
  body: string,
): Promise<[number, Record<string, string>, string]> {
  const sentHeaders = Object.fromEntries(
    Object.entries(headers).flatMap(([name, value]) =>
      typeof value === 'string' && !HOP_BY_HOP.has(name) && name !== 'host' ? [[name, value]] : [],
    ),
  );
  // yokla's own client: network access lives in runtime (ADR-0006).
  const client = new HttpClient({ allowedOrigins: [base], timeoutMs: 30_000, maxRetries: 0 });
  const answer = await client.send({
    url: `${base}${path}`,
    method,
    headers: sentHeaders,
    body: method === 'GET' || method === 'HEAD' ? undefined : body,
  });
  const kept = Object.fromEntries(
    Object.entries(answer.headers).filter(([name]) => !HOP_BY_HOP.has(name)),
  );
  return [answer.status, kept, answer.text];
}

/** A server in front of the shop that keeps the message of every request it passes on. */
async function startForwarder(base: string): Promise<string> {
  forwarding = await startTestServer({
    onHttp: (request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        const message = messageOf(body);
        if (message !== undefined) sent.push(message);
        forward(base, request.method ?? 'GET', request.url ?? '/', request.headers, body).then(
          ([status, headers, text]) => {
            response.writeHead(status, headers);
            response.end(text);
          },
          () => {
            response.writeHead(502);
            response.end();
          },
        );
      });
    },
  });
  const url = forwarding.url.replace(/^ws:/u, 'http:');
  ports.add(Number(new URL(url).port));
  return url;
}

beforeAll(async () => {
  cpSync(DEMO, shop, {
    recursive: true,
    filter: (path) => !/(?:node_modules|dist|tsbuildinfo|yokla-data)$/u.test(path),
  });
  changeCatalog();
  guard = installNetworkGuard(
    (host, port) => host === '127.0.0.1' && port !== undefined && ports.has(port),
  );
  const base = await startForwarder(await startShop());
  const lines: string[] = [];
  const code = await main(
    [
      'run',
      '--profile',
      join(shop, 'yokla.profile.yaml'),
      // The demo-shop's own check loads where it lives, with the repository's tsconfig.
      '--config',
      join(DEMO, 'yokla.config.yaml'),
      '--cases',
      join(shop, 'cases'),
      '--target-url',
      `${base}/v1/chat`,
      '--out',
      out,
    ],
    { out: (line) => lines.push(line), err: (line) => lines.push(line) },
  );
  ran = { code, output: lines.join('\n') };
  const gateLines: string[] = [];
  const gateCode = await main(['gate', '--results', out], {
    out: (line) => gateLines.push(line),
    err: (line) => gateLines.push(line),
  });
  gated = { code: gateCode, output: gateLines.join('\n') };
}, 120_000);

afterAll(async () => {
  guard?.uninstall();
  await forwarding?.close();
  for (const child of children) child.kill();
});

const results = () => Results.parse(JSON.parse(readFileSync(out, 'utf8')));
const STALE = ['hammock-en', 'water-bottle-en'];

describe('cases the data no longer holds (ADR-0053, ADR-0054)', () => {
  it('marks them fixture-missing, each with the fact that changed', () => {
    const stale = results().cases.filter((c) => c.status === 'fixture-missing');
    expect(stale.map((c) => [c.id, c.fixture, c.samples])).toEqual([
      ['water-bottle-en', ['the catalog holds no outdoor/hydration/water-bottle'], []],
      ['hammock-en', ['the catalog now holds hammock: 1 product, such as HMK-001'], []],
    ]);
  });

  it('sends the shop nothing for them, and every other case as before', () => {
    const asked = results()
      .cases.filter((c) => STALE.includes(c.id))
      .flatMap((c) => c.samples);
    expect(asked).toEqual([]);
    expect(sent).not.toContain('Do you sell hammocks?');
    expect(sent).not.toContain('Do you have a water bottle under 300?');
    expect(sent).toContain('Uyku matı var mı?');
  });

  it('keeps the status every other case has on the unchanged catalog: pass', () => {
    const others = results().cases.filter((c) => !STALE.includes(c.id));
    expect(others.length).toBeGreaterThan(10);
    expect(others.filter((c) => c.status !== 'pass').map((c) => [c.id, c.status])).toEqual([]);
  });

  it("can't be judged: the run and the gate exit with 2, and name both", () => {
    expect(ran?.code, ran?.output).toBe(2);
    expect(ran?.output).toMatch(
      /water-bottle-en +fixture missing: the catalog holds no outdoor\/hydration\/water-bottle/u,
    );
    expect(ran?.output).toMatch(
      /hammock-en +fixture missing: the catalog now holds hammock: 1 product, such as HMK-001/u,
    );
    expect(gated?.code, gated?.output).toBe(2);
    expect(gated?.output).toContain('2 fixture-missing cases: water-bottle-en, hammock-en');
  });

  it('names the catalog the run was judged on', () => {
    const text = readFileSync(catalogPath, 'utf8');
    const catalog = results().run.data?.find((file) => file.path === './data/catalog.jsonl');
    expect(catalog).toMatchObject({
      sha256: createHash('sha256').update(text).digest('hex'),
      rows: text.split('\n').filter((line) => line.trim() !== '').length,
    });
    expect(catalog?.modifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
  });

  // Last, so it sees the traffic of everything above.
  it('contacts nothing but the shop and the forwarder (ADR-0003)', () => {
    const attempts = guard?.attempts ?? [];
    expect(attempts.filter((attempt) => !attempt.allowed)).toEqual([]);
  });
});
