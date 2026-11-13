// The WebSocket adapter (ADR-0024), on Node.js's built-in client. A sample
// opens one connection, only to the origins it was given (ADR-0003), and sends
// one message per turn. An answer's messages are collected until the one the
// caller says ends it: the profile's done or error event. A connection that
// closes, or an answer that runs out of time, ends the answer incomplete; that
// is returned with what arrived, never thrown away.

import type { StreamChunk } from '@yokla/core';

export interface WebSocketOptions {
  /** Origins yokla may contact, e.g. ws://127.0.0.1:3000. Everything else is refused. */
  readonly allowedOrigins: readonly string[];
  /** Bounds opening the connection, and each answer. */
  readonly timeoutMs: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly protocols?: readonly string[] | undefined;
  /** The size limit of one answer, all its messages counted. */
  readonly maxAnswerBytes?: number;
  /** Waits before each message, e.g. for the profile's rate limits. */
  readonly pace?: () => Promise<void>;
}

export type WebSocketErrorKind = 'refused-host' | 'connect' | 'too-large' | 'network';

export class WebSocketError extends Error {
  override readonly name = 'WebSocketError';
  readonly kind: WebSocketErrorKind;

  constructor(kind: WebSocketErrorKind, message: string) {
    super(message);
    this.kind = kind;
  }
}

export interface Closed {
  readonly code: number;
  readonly reason: string;
}

export interface WebSocketAnswer {
  /** The answer's messages, each timed from sending the turn's message. */
  readonly messages: readonly StreamChunk[];
  readonly latencyMs: number;
  /** What ended it: a message the caller said ends it, the connection closing, or time. */
  readonly end: 'message' | 'closed' | 'timeout';
  /** How the connection closed, when it did. */
  readonly closed?: Closed;
  /** Messages that arrived after the previous answer ended, before this turn (ADR-0024). */
  readonly between: number;
  /** false when the connection had closed already, so nothing was sent. */
  readonly sent: boolean;
}

/** Whether a message, by its text, ends the answer. */
export type Ends = (text: string) => boolean;

interface Pending {
  readonly started: number;
  readonly ends: Ends;
  readonly messages: StreamChunk[];
  size: number;
  finish(end: WebSocketAnswer['end']): void;
  fail(error: WebSocketError): void;
}

const DEFAULT_LIMIT = 10 * 1024 * 1024;
const CLOSE_WAIT_MS = 1_000;

function closeText(closed: Closed): string {
  return `code ${String(closed.code)}${closed.reason === '' ? '' : `: ${closed.reason}`}`;
}

function textOf(data: unknown): string {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return new TextDecoder('utf-8').decode(data);
  return String(data);
}

export class WebSocketConnection {
  readonly #socket: WebSocket;
  readonly #options: WebSocketOptions;
  #closed: Closed | undefined;
  #pending: Pending | undefined;
  #between = 0;
  #sent = false;
  readonly #whenClosed: Promise<void>;

  constructor(socket: WebSocket, options: WebSocketOptions) {
    this.#socket = socket;
    this.#options = options;
    socket.addEventListener('message', (event) => {
      this.#receive(textOf(event.data));
    });
    this.#whenClosed = new Promise((resolve) => {
      socket.addEventListener('close', (event) => {
        this.#closed = { code: event.code, reason: event.reason };
        this.#pending?.finish('closed');
        resolve();
      });
    });
  }

  /** How the connection closed; undefined while it is open. */
  get closed(): Closed | undefined {
    return this.#closed;
  }

  #receive(text: string): void {
    const pending = this.#pending;
    if (pending === undefined) {
      // A greeting before the first message is left unread; later ones are counted.
      if (this.#sent) this.#between += 1;
      return;
    }
    pending.size += Buffer.byteLength(text);
    const limit = this.#options.maxAnswerBytes ?? DEFAULT_LIMIT;
    if (pending.size > limit) {
      pending.fail(new WebSocketError('too-large', 'the answer exceeds the size limit'));
      // A client may close only with 1000 or 3000–4999.
      this.#socket.close(1000, 'answer too large');
      return;
    }
    pending.messages.push({ atMs: performance.now() - pending.started, text });
    if (pending.ends(text)) pending.finish('message');
  }

  /** Sends one turn's message and collects its answer. */
  async exchange(message: string, ends: Ends): Promise<WebSocketAnswer> {
    if (this.#pending !== undefined) throw new Error('a turn is already waiting for its answer');
    await this.#options.pace?.();
    // A server that closed after the previous answer: wait to learn how, rather than send.
    if (this.#closed === undefined && this.#socket.readyState !== WebSocket.OPEN) {
      await this.#closedWithin(this.#options.timeoutMs);
    }
    const between = this.#between;
    this.#between = 0;
    if (this.#closed !== undefined) {
      return {
        messages: [],
        latencyMs: 0,
        end: 'closed',
        closed: this.#closed,
        between,
        sent: false,
      };
    }
    this.#sent = true;
    return new Promise<WebSocketAnswer>((resolve, reject) => {
      const started = performance.now();
      const messages: StreamChunk[] = [];
      const done = () => {
        clearTimeout(timer);
        this.#pending = undefined;
      };
      const pending: Pending = {
        started,
        ends,
        messages,
        size: 0,
        finish: (end) => {
          done();
          resolve({
            messages,
            latencyMs: performance.now() - started,
            end,
            ...(end === 'closed' && this.#closed !== undefined ? { closed: this.#closed } : {}),
            between,
            sent: true,
          });
        },
        fail: (error) => {
          done();
          reject(error);
        },
      };
      const timer = setTimeout(() => {
        pending.finish('timeout');
      }, this.#options.timeoutMs);
      this.#pending = pending;
      try {
        this.#socket.send(message);
      } catch (error) {
        pending.fail(
          new WebSocketError('network', error instanceof Error ? error.message : String(error)),
        );
      }
    });
  }

  /** Waits until the connection has closed, or `ms` has passed. */
  async #closedWithin(ms: number): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      this.#whenClosed,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms);
      }),
    ]);
    clearTimeout(timer);
  }

  /** Closes the connection normally, and waits briefly for the server to agree. */
  async close(): Promise<void> {
    if (this.#closed !== undefined) return;
    if (this.#socket.readyState === WebSocket.OPEN) this.#socket.close(1000, 'done');
    await this.#closedWithin(CLOSE_WAIT_MS);
  }
}

/** Opens a connection to an allowed origin; fails with what Node.js says about it. */
export async function openWebSocket(
  url: string,
  options: WebSocketOptions,
): Promise<WebSocketConnection> {
  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    throw new WebSocketError('refused-host', `invalid url "${url}"`);
  }
  const allowed = new Set(options.allowedOrigins.map((entry) => new URL(entry).origin));
  if (!allowed.has(origin)) {
    throw new WebSocketError(
      'refused-host',
      `refusing to contact ${origin}: not a configured target`,
    );
  }
  let socket: WebSocket;
  try {
    socket = new WebSocket(url, {
      headers: { ...options.headers },
      ...(options.protocols === undefined ? {} : { protocols: [...options.protocols] }),
    });
  } catch (error) {
    throw new WebSocketError('connect', error instanceof Error ? error.message : String(error));
  }
  socket.binaryType = 'arraybuffer';
  // Listening from the start, so no message after the opening is missed.
  const connection = new WebSocketConnection(socket, options);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.close();
      reject(
        new WebSocketError(
          'connect',
          `the connection did not open within ${String(options.timeoutMs)} ms`,
        ),
      );
    }, options.timeoutMs);
    socket.addEventListener('open', () => {
      clearTimeout(timer);
      resolve();
    });
    socket.addEventListener('close', (event) => {
      clearTimeout(timer);
      reject(
        new WebSocketError(
          'connect',
          `the connection could not be opened (${closeText({ code: event.code, reason: event.reason })})`,
        ),
      );
    });
  });
  return connection;
}

export { closeText };
