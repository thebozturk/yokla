// A small WebSocket server for tests (ADR-0024): the handshake and the framing
// of RFC 6455 that a test needs, on node:http, with no dependency. Each test
// scripts what the server does with a message. It is test code: it trusts its
// peer, and keeps no limits beyond what a test sends.

import { createHash } from 'node:crypto';
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { Duplex } from 'node:stream';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export interface TestSocket {
  /** Sends a text message, or a binary one for a Uint8Array. */
  send(data: string | Uint8Array): void;
  /** Sends a close frame with this code and reason, then ends the connection. */
  close(code: number, reason?: string): void;
  /** Ends the TCP connection with no close frame. */
  drop(): void;
}

export interface Handshake {
  readonly path: string;
  readonly headers: IncomingHttpHeaders;
  readonly protocols: readonly string[];
}

export interface TestServerOptions {
  /** Refuses the handshake with this HTTP status instead of upgrading. */
  readonly refuse?: (handshake: Handshake) => number | undefined;
  /** The subprotocol to select, from those asked for. */
  readonly protocol?: (asked: readonly string[]) => string | undefined;
  /** Runs when a connection opens, e.g. to send a greeting. */
  readonly onOpen?: (socket: TestSocket, handshake: Handshake) => void;
  /** Runs for each text or binary message the client sends. */
  readonly onMessage?: (text: string, socket: TestSocket, handshake: Handshake) => void;
  /** Answers a plain HTTP request, such as a session opening; by default 426. */
  readonly onHttp?: (request: IncomingMessage, response: ServerResponse) => void;
}

export interface TestServer {
  readonly url: string;
  readonly handshakes: readonly Handshake[];
  /** Messages each connection received, in order. */
  readonly received: readonly string[];
  /** Close codes the clients sent. */
  readonly closes: readonly number[];
  close(): Promise<void>;
}

function frame(opcode: number, payload: Uint8Array): Buffer {
  const length = payload.byteLength;
  const head =
    length < 126
      ? Buffer.from([0x80 | opcode, length])
      : length < 65_536
        ? Buffer.from([0x80 | opcode, 126, length >> 8, length & 0xff])
        : Buffer.concat([Buffer.from([0x80 | opcode, 127]), bigLength(length)]);
  return Buffer.concat([head, payload]);
}

function bigLength(length: number): Buffer {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(length));
  return buffer;
}

interface Frame {
  readonly fin: boolean;
  readonly opcode: number;
  readonly payload: Buffer;
  readonly size: number;
}

/** The first complete frame in `data`, unmasked; undefined until it has all arrived. */
function readFrame(data: Buffer): Frame | undefined {
  if (data.length < 2) return undefined;
  const first = data[0] ?? 0;
  const second = data[1] ?? 0;
  let length = second & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (data.length < 4) return undefined;
    length = data.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    if (data.length < 10) return undefined;
    length = Number(data.readBigUInt64BE(2));
    offset = 10;
  }
  const masked = (second & 0x80) !== 0;
  const mask = masked ? data.subarray(offset, offset + 4) : undefined;
  if (masked) offset += 4;
  if (data.length < offset + length) return undefined;
  const payload = Buffer.from(data.subarray(offset, offset + length));
  if (mask !== undefined) {
    for (let index = 0; index < payload.length; index += 1) {
      payload[index] = (payload[index] ?? 0) ^ (mask[index % 4] ?? 0);
    }
  }
  return { fin: (first & 0x80) !== 0, opcode: first & 0x0f, payload, size: offset + length };
}

function closePayload(code: number, reason: string): Buffer {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16BE(code);
  return Buffer.concat([buffer, Buffer.from(reason, 'utf8')]);
}

export async function startTestServer(options: TestServerOptions = {}): Promise<TestServer> {
  const handshakes: Handshake[] = [];
  const received: string[] = [];
  const closes: number[] = [];
  const sockets = new Set<Duplex>();
  const server: Server = createServer((request, response) => {
    if (options.onHttp === undefined) response.writeHead(426).end();
    else options.onHttp(request, response);
  });
  server.on('upgrade', (request, socket: Duplex) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => sockets.delete(socket));
    const protocols = (request.headers['sec-websocket-protocol'] ?? '')
      .split(',')
      .map((name) => name.trim())
      .filter((name) => name !== '');
    const handshake: Handshake = { path: request.url ?? '/', headers: request.headers, protocols };
    handshakes.push(handshake);
    const refused = options.refuse?.(handshake);
    if (refused !== undefined) {
      socket.end(
        `HTTP/1.1 ${String(refused)} Refused\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`,
      );
      return;
    }
    const key = request.headers['sec-websocket-key'] ?? '';
    const accept = createHash('sha1')
      .update(key + GUID)
      .digest('base64');
    const protocol = options.protocol?.(protocols);
    socket.write(
      [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${accept}`,
        ...(protocol === undefined ? [] : [`Sec-WebSocket-Protocol: ${protocol}`]),
        '',
        '',
      ].join('\r\n'),
    );
    let closing = false;
    // Frames sent in the same tick go out in one write, as a busy server's often do.
    let corked = false;
    const cork = () => {
      if (corked) return;
      corked = true;
      socket.cork();
      process.nextTick(() => {
        corked = false;
        socket.uncork();
      });
    };
    const peer: TestSocket = {
      send(data) {
        if (closing) return;
        cork();
        socket.write(
          typeof data === 'string' ? frame(0x1, Buffer.from(data, 'utf8')) : frame(0x2, data),
        );
      },
      close(code, reason = '') {
        if (closing) return;
        closing = true;
        cork();
        socket.write(frame(0x8, closePayload(code, reason)));
        setTimeout(() => socket.end(), 20);
      },
      drop() {
        closing = true;
        socket.destroy();
      },
    };
    options.onOpen?.(peer, handshake);
    let buffered = Buffer.alloc(0);
    let parts: Buffer[] = [];
    socket.on('data', (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      for (let next = readFrame(buffered); next !== undefined; next = readFrame(buffered)) {
        buffered = buffered.subarray(next.size);
        if (next.opcode === 0x8) {
          closes.push(next.payload.length >= 2 ? next.payload.readUInt16BE(0) : 1005);
          if (!closing) {
            closing = true;
            socket.write(frame(0x8, next.payload.subarray(0, 2)));
          }
          socket.end();
          return;
        }
        if (next.opcode === 0x9) {
          socket.write(frame(0xa, next.payload));
          continue;
        }
        if (next.opcode !== 0x0 && next.opcode !== 0x1 && next.opcode !== 0x2) continue;
        parts.push(next.payload);
        if (!next.fin) continue;
        const text = Buffer.concat(parts).toString('utf8');
        parts = [];
        received.push(text);
        options.onMessage?.(text, peer, handshake);
      }
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    url: `ws://127.0.0.1:${String(port)}`,
    handshakes,
    received,
    closes,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
  };
}
