// A small WebSocket server (RFC 6455) for the demo-shop's chat over a
// WebSocket: the handshake, text and binary messages in one or more frames,
// ping, and the closing handshake. It is written for the demo-shop and needs
// no dependency. It refuses what the RFC says a server must: an unmasked
// frame, a bad handshake, and messages over the size limit.

import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export interface WebSocketPeer {
  send(text: string): void;
  close(code: number, reason?: string): void;
}

export interface AcceptOptions {
  readonly maxMessageBytes: number;
  readonly onMessage: (text: string, peer: WebSocketPeer) => void;
}

function frame(opcode: number, payload: Buffer): Buffer {
  const length = payload.length;
  if (length < 126) return Buffer.concat([Buffer.from([0x80 | opcode, length]), payload]);
  if (length < 65_536) {
    const head = Buffer.from([0x80 | opcode, 126, 0, 0]);
    head.writeUInt16BE(length, 2);
    return Buffer.concat([head, payload]);
  }
  const head = Buffer.alloc(10);
  head[0] = 0x80 | opcode;
  head[1] = 127;
  head.writeBigUInt64BE(BigInt(length), 2);
  return Buffer.concat([head, payload]);
}

function closePayload(code: number, reason: string): Buffer {
  const payload = Buffer.alloc(2);
  payload.writeUInt16BE(code);
  return Buffer.concat([payload, Buffer.from(reason, 'utf8').subarray(0, 123)]);
}

/** Refuses an upgrade with an HTTP status, and ends the socket. */
export function refuseUpgrade(socket: Duplex, status: number, reason: string): void {
  socket.end(
    `HTTP/1.1 ${String(status)} ${reason}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`,
  );
}

/** Completes the handshake and reads messages; false when the request isn't a valid one. */
export function acceptWebSocket(
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  options: AcceptOptions,
): boolean {
  const key = request.headers['sec-websocket-key'];
  const upgrade = request.headers.upgrade?.toLowerCase();
  if (
    request.method !== 'GET' ||
    upgrade !== 'websocket' ||
    request.headers['sec-websocket-version'] !== '13' ||
    typeof key !== 'string' ||
    Buffer.from(key, 'base64').length !== 16
  ) {
    refuseUpgrade(socket, 400, 'Bad Request');
    return false;
  }
  const accept = createHash('sha1')
    .update(key + GUID)
    .digest('base64');
  socket.write(
    `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );

  let closing = false;
  const peer: WebSocketPeer = {
    send(text) {
      if (!closing) socket.write(frame(0x1, Buffer.from(text, 'utf8')));
    },
    close(code, reason = '') {
      if (closing) return;
      closing = true;
      socket.write(frame(0x8, closePayload(code, reason)));
      // The client answers with its own close frame; end the TCP side after it, or soon.
      setTimeout(() => socket.end(), 1_000).unref();
    },
  };

  let buffered = head;
  let parts: Buffer[] = [];
  let partsSize = 0;
  socket.on('error', () => socket.destroy());
  // A client that ends its side gets ours ended too, so no connection stays half open.
  socket.on('end', () => socket.end());
  /** Reads every complete frame buffered so far. */
  const read = (): void => {
    while (buffered.length >= 2) {
      const first = buffered[0] ?? 0;
      const second = buffered[1] ?? 0;
      const opcode = first & 0x0f;
      if ((second & 0x80) === 0) {
        peer.close(1002, 'frames from a client must be masked');
        return;
      }
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buffered.length < 4) return;
        length = buffered.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (buffered.length < 10) return;
        const big = buffered.readBigUInt64BE(2);
        if (big > BigInt(options.maxMessageBytes)) {
          peer.close(1009, 'message too big');
          return;
        }
        length = Number(big);
        offset = 10;
      }
      if (length > options.maxMessageBytes) {
        peer.close(1009, 'message too big');
        return;
      }
      if (buffered.length < offset + 4 + length) return;
      const mask = buffered.subarray(offset, offset + 4);
      const payload = Buffer.from(buffered.subarray(offset + 4, offset + 4 + length));
      for (let index = 0; index < payload.length; index += 1) {
        payload[index] = (payload[index] ?? 0) ^ (mask[index % 4] ?? 0);
      }
      buffered = buffered.subarray(offset + 4 + length);
      const fin = (first & 0x80) !== 0;

      if (opcode === 0x8) {
        // The closing handshake: answer with the same code, then end.
        if (!closing) {
          closing = true;
          socket.write(frame(0x8, payload.subarray(0, 2)));
        }
        socket.end();
        return;
      }
      if (opcode === 0x9) {
        if (!closing) socket.write(frame(0xa, payload));
        continue;
      }
      if (opcode === 0xa) continue;
      if (opcode !== 0x0 && opcode !== 0x1 && opcode !== 0x2) {
        peer.close(1002, 'unknown opcode');
        return;
      }
      partsSize += payload.length;
      if (partsSize > options.maxMessageBytes) {
        peer.close(1009, 'message too big');
        return;
      }
      parts.push(payload);
      if (!fin) continue;
      const text = Buffer.concat(parts).toString('utf8');
      parts = [];
      partsSize = 0;
      options.onMessage(text, peer);
    }
  };
  socket.on('data', (chunk: Buffer) => {
    buffered = Buffer.concat([buffered, chunk]);
    read();
  });
  // Frames that came with the handshake.
  read();
  return true;
}
