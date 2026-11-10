// The guard must itself be tested, or the egress test could pass vacuously.
// Blocked destinations are documentation addresses (TEST-NET-1, .invalid), so
// even a broken guard would reach no real host.

import dns from 'node:dns';
import { createServer, type Server } from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import { afterEach, describe, expect, it } from 'vitest';
import { installNetworkGuard, type NetworkGuard } from './network-guard.ts';

let guard: NetworkGuard | undefined;
let server: Server | undefined;

afterEach(async () => {
  guard?.uninstall();
  guard = undefined;
  if (server !== undefined) {
    const closing = server;
    server = undefined;
    closing.closeAllConnections();
    await new Promise<void>((resolve) => {
      closing.close(() => {
        resolve();
      });
    });
  }
});

async function localServer(): Promise<number> {
  server = createServer((_request, response) => {
    response.end('ok');
  });
  const started = server;
  await new Promise<void>((resolve) => {
    started.listen(0, '127.0.0.1', resolve);
  });
  const address = started.address();
  if (typeof address !== 'object' || address === null) throw new Error('no address');
  return address.port;
}

function failure(socket: net.Socket): Promise<string> {
  return new Promise((resolve) => {
    socket.once('error', (error) => {
      resolve(error.message);
    });
  });
}

/** The functions the guard replaces, as they are now. */
const guardedFunctions = (): unknown[] => [
  Object.getOwnPropertyDescriptor(net.Socket.prototype, 'connect')?.value,
  Object.getOwnPropertyDescriptor(dns, 'lookup')?.value,
  Object.getOwnPropertyDescriptor(dns.promises, 'lookup')?.value,
];

describe('installNetworkGuard', () => {
  it('lets allowed connections through and records them', async () => {
    const port = await localServer();
    guard = installNetworkGuard((host, p) => host === '127.0.0.1' && p === port);
    const response = await fetch(`http://127.0.0.1:${String(port)}/`);
    expect(await response.text()).toBe('ok');
    expect(guard.attempts).toContainEqual({ kind: 'tcp', host: '127.0.0.1', port, allowed: true });
  });

  it('blocks fetch to any other host before it connects', async () => {
    guard = installNetworkGuard(() => false);
    const error: unknown = await fetch('http://192.0.2.1:8080/').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    const cause: unknown = error instanceof Error ? error.cause : undefined;
    expect(cause instanceof Error ? cause.message : cause).toBe(
      'network guard: blocked 192.0.2.1:8080',
    );
    expect(guard.attempts).toEqual([
      { kind: 'tcp', host: '192.0.2.1', port: 8080, allowed: false },
    ]);
  });

  it('blocks every connect form: options, port and host, a local socket, and TLS', async () => {
    guard = installNetworkGuard(() => false);
    const messages = await Promise.all([
      failure(net.connect({ host: '192.0.2.1', port: 80 })),
      failure(net.connect(81, '192.0.2.1')),
      failure(net.connect('/tmp/yokla-guard-test.sock')),
      failure(tls.connect({ host: '192.0.2.1', port: 443, servername: 'example.invalid' })),
    ]);
    expect(messages).toEqual([
      'network guard: blocked 192.0.2.1:80',
      'network guard: blocked 192.0.2.1:81',
      'network guard: blocked unix:/tmp/yokla-guard-test.sock',
      'network guard: blocked 192.0.2.1:443',
    ]);
    expect(guard.attempts.every((attempt) => !attempt.allowed)).toBe(true);
    expect(guard.attempts).toHaveLength(4);
  });

  it('reads the call forms of Socket#connect itself', async () => {
    guard = installNetworkGuard(() => false);
    const messages = await Promise.all([
      failure(new net.Socket().connect(82, '192.0.2.1')),
      failure(new net.Socket().connect('/tmp/yokla-guard-test-2.sock')),
    ]);
    expect(messages).toEqual([
      'network guard: blocked 192.0.2.1:82',
      'network guard: blocked unix:/tmp/yokla-guard-test-2.sock',
    ]);
  });

  it('blocks DNS lookups, with callbacks and with promises', async () => {
    guard = installNetworkGuard(() => false);
    const viaCallback = await new Promise<string>((resolve) => {
      dns.lookup('example.invalid', (error) => {
        resolve(error?.message ?? 'no error');
      });
    });
    const viaPromise: unknown = await dns.promises
      .lookup('example.invalid')
      .catch((caught: unknown) => (caught instanceof Error ? caught.message : caught));
    expect([viaCallback, viaPromise]).toEqual([
      'network guard: blocked example.invalid',
      'network guard: blocked example.invalid',
    ]);
    expect(guard.attempts).toEqual([
      { kind: 'dns', host: 'example.invalid', port: undefined, allowed: false },
      { kind: 'dns', host: 'example.invalid', port: undefined, allowed: false },
    ]);
  });

  it('lets the local lookup of an IP literal pass unrecorded, as listen() needs', async () => {
    guard = installNetworkGuard(() => false);
    const viaCallback = await new Promise<string>((resolve) => {
      dns.lookup('127.0.0.1', (error, address) => {
        resolve(error?.message ?? address);
      });
    });
    const viaPromise = await dns.promises.lookup('::1');
    expect([viaCallback, viaPromise.address]).toEqual(['127.0.0.1', '::1']);
    const port = await localServer();
    expect(port).toBeGreaterThan(0);
    expect(guard.attempts).toEqual([]);
  });

  it('restores the original functions when uninstalled', () => {
    const before = guardedFunctions();
    const installed = installNetworkGuard(() => false);
    const during = guardedFunctions();
    for (const [index, fn] of during.entries()) expect(fn).not.toBe(before[index]);
    installed.uninstall();
    expect(guardedFunctions()).toEqual(before);
  });
});
