// A network guard for tests (ADR-0003): it records every outgoing TCP
// connection and DNS lookup of this process, and stops those to hosts that
// aren't allowed before any packet or lookup leaves. TLS and fetch connect
// through net.Socket, so they are covered too. Child processes are not.

import dns from 'node:dns';
import net from 'node:net';

export interface NetworkAttempt {
  readonly kind: 'tcp' | 'dns';
  /** A host name or address; `unix:<path>` for a local socket. */
  readonly host: string;
  readonly port: number | undefined;
  readonly allowed: boolean;
}

export interface NetworkGuard {
  readonly attempts: readonly NetworkAttempt[];
  /** Restores the patched functions. */
  uninstall(): void;
}

export type AllowRule = (host: string, port: number | undefined) => boolean;

type AnyFunction = (...args: unknown[]) => unknown;

function isFunction(value: unknown): value is AnyFunction {
  return typeof value === 'function';
}

function field(value: object, key: string): unknown {
  const found: unknown = Reflect.get(value, key);
  return found;
}

function blocked(host: string, port: number | undefined): Error {
  const where = port === undefined ? host : `${host}:${String(port)}`;
  return new Error(`network guard: blocked ${where}`);
}

/** Where a Socket#connect call goes, for each of its call forms. */
function destination(args: readonly unknown[]): { host: string; port: number | undefined } {
  // net.connect passes its normalised arguments as one array.
  const [head] = args;
  const list: readonly unknown[] = Array.isArray(head) ? head : args;
  const [first, second] = list;
  if (typeof first === 'object' && first !== null) {
    const path = field(first, 'path');
    if (typeof path === 'string') return { host: `unix:${path}`, port: undefined };
    const host = field(first, 'host');
    const port = field(first, 'port');
    return {
      host: typeof host === 'string' && host !== '' ? host : 'localhost',
      port: port === undefined ? undefined : Number(port),
    };
  }
  if (typeof first === 'string' && !/^\d+$/u.test(first))
    return { host: `unix:${first}`, port: undefined };
  return { host: typeof second === 'string' ? second : 'localhost', port: Number(first) };
}

/** The own property `key` of `target`, which must be a function. */
function own(target: object, key: string): { descriptor: PropertyDescriptor; fn: AnyFunction } {
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  const fn: unknown = descriptor?.value;
  if (descriptor === undefined || !isFunction(fn)) {
    throw new Error(`network guard: ${key} is not a function to guard`);
  }
  return { descriptor, fn };
}

export function installNetworkGuard(allow: AllowRule): NetworkGuard {
  const attempts: NetworkAttempt[] = [];
  const connect = own(net.Socket.prototype, 'connect');
  const lookup = own(dns, 'lookup');
  const promisesLookup = own(dns.promises, 'lookup');

  function check(kind: NetworkAttempt['kind'], host: string, port: number | undefined): boolean {
    const allowed = allow(host, port);
    attempts.push({ kind, host, port, allowed });
    return allowed;
  }

  Object.defineProperty(net.Socket.prototype, 'connect', {
    ...connect.descriptor,
    value: function guardedConnect(this: net.Socket, ...args: unknown[]): net.Socket {
      const { host, port } = destination(args);
      if (check('tcp', host, port)) {
        Reflect.apply(connect.fn, this, args);
      } else {
        process.nextTick(() => this.destroy(blocked(host, port)));
      }
      return this;
    },
  });
  Object.defineProperty(dns, 'lookup', {
    ...lookup.descriptor,
    value: function guardedLookup(host: unknown, ...rest: unknown[]): unknown {
      const name = String(host);
      if (check('dns', name, undefined)) return lookup.fn(host, ...rest);
      const callback = rest.at(-1);
      if (isFunction(callback)) process.nextTick(() => callback(blocked(name, undefined)));
      return undefined;
    },
  });
  Object.defineProperty(dns.promises, 'lookup', {
    ...promisesLookup.descriptor,
    value: async function guardedPromisesLookup(host: unknown, ...rest: unknown[]) {
      const name = String(host);
      if (!check('dns', name, undefined)) throw blocked(name, undefined);
      const found: unknown = await promisesLookup.fn(host, ...rest);
      return found;
    },
  });

  return {
    attempts,
    uninstall() {
      Object.defineProperty(net.Socket.prototype, 'connect', connect.descriptor);
      Object.defineProperty(dns, 'lookup', lookup.descriptor);
      Object.defineProperty(dns.promises, 'lookup', promisesLookup.descriptor);
    },
  };
}
