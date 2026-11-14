// OpenTelemetry trace exports (ADR-0029), as OTLP/HTTP sends them: JSON or
// protobuf. Only the part yokla needs is read: each span's ids, name, times,
// status and scalar attributes. The protobuf reader decodes the wire format
// itself, with no dependency, and skips every field it doesn't need. Core is
// pure: the caller decompresses the body.

export type AttributeValue = string | number | boolean;

export interface OtlpSpan {
  /** Hex, as W3C trace context writes it. */
  readonly traceId: string;
  readonly spanId: string;
  readonly name: string;
  /** Nanoseconds since the epoch. */
  readonly startNs: bigint;
  readonly endNs: bigint;
  /** The span's status is ERROR. */
  readonly error: boolean;
  readonly attributes: ReadonlyMap<string, AttributeValue>;
}

const STATUS_ERROR = 2;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** OTLP JSON writes ids as hex. */
function jsonId(value: unknown): string {
  return typeof value === 'string' && /^[0-9a-f]*$/iu.test(value) ? value.toLowerCase() : '';
}

/** UTF-8 bytes as text; a broken sequence becomes U+FFFD. Core has no TextDecoder. */
function utf8(bytes: Uint8Array): string {
  let out = '';
  for (let at = 0; at < bytes.length;) {
    const lead = bytes[at] ?? 0;
    const size =
      lead < 0x80 ? 1 : lead >> 5 === 0x6 ? 2 : lead >> 4 === 0xe ? 3 : lead >> 3 === 0x1e ? 4 : 0;
    let code =
      size === 1 ? lead : size === 2 ? lead & 0x1f : size === 3 ? lead & 0x0f : lead & 0x07;
    let ok = size > 0 && at + size <= bytes.length;
    for (let next = 1; ok && next < size; next += 1) {
      const byte = bytes[at + next] ?? 0;
      if (byte >> 6 !== 0x2) ok = false;
      code = (code << 6) | (byte & 0x3f);
    }
    if (ok && code <= 0x10ffff) {
      out += String.fromCodePoint(code);
      at += size;
    } else {
      out += '\uFFFD';
      at += 1;
    }
  }
  return out;
}

function nanos(value: unknown): bigint {
  if (typeof value === 'string' && /^\d+$/u.test(value)) return BigInt(value);
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return BigInt(value);
  return 0n;
}

function jsonValue(value: unknown): AttributeValue | undefined {
  if (!isObject(value)) return undefined;
  if (typeof value['stringValue'] === 'string') return value['stringValue'];
  if (typeof value['boolValue'] === 'boolean') return value['boolValue'];
  const int = value['intValue'];
  if (typeof int === 'number') return int;
  if (typeof int === 'string' && /^-?\d+$/u.test(int)) return Number(int);
  if (typeof value['doubleValue'] === 'number') return value['doubleValue'];
  return undefined;
}

function jsonStatusError(status: unknown): boolean {
  const code = isObject(status) ? status['code'] : undefined;
  return code === STATUS_ERROR || code === 'STATUS_CODE_ERROR';
}

/** The spans of an OTLP JSON export; undefined when it isn't one. */
export function readOtlpJson(value: unknown): OtlpSpan[] | undefined {
  if (!isObject(value) || !Array.isArray(value['resourceSpans'])) return undefined;
  const spans: OtlpSpan[] = [];
  for (const resource of list(value['resourceSpans'])) {
    const scopes = isObject(resource) ? list(resource['scopeSpans']) : [];
    for (const scope of scopes) {
      for (const span of isObject(scope) ? list(scope['spans']) : []) {
        if (!isObject(span)) continue;
        const attributes = new Map<string, AttributeValue>();
        for (const attribute of list(span['attributes'])) {
          if (!isObject(attribute) || typeof attribute['key'] !== 'string') continue;
          const read = jsonValue(attribute['value']);
          if (read !== undefined) attributes.set(attribute['key'], read);
        }
        spans.push({
          traceId: jsonId(span['traceId']),
          spanId: jsonId(span['spanId']),
          name: typeof span['name'] === 'string' ? span['name'] : '',
          startNs: nanos(span['startTimeUnixNano']),
          endNs: nanos(span['endTimeUnixNano']),
          error: jsonStatusError(span['status']),
          attributes,
        });
      }
    }
  }
  return spans;
}

/** The protobuf wire format, as far as OTLP traces need it. */
class Wire {
  readonly #bytes: Uint8Array;
  #at: number;
  readonly #end: number;

  constructor(bytes: Uint8Array, start = 0, end = bytes.length) {
    this.#bytes = bytes;
    this.#at = start;
    this.#end = end;
  }

  done(): boolean {
    return this.#at >= this.#end;
  }

  varint(): bigint {
    let result = 0n;
    let shift = 0n;
    for (;;) {
      if (this.#at >= this.#end || shift > 63n) throw new Error('a broken varint');
      const byte = this.#bytes[this.#at] ?? 0;
      this.#at += 1;
      result |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return result;
      shift += 7n;
    }
  }

  #fixed(size: number): Uint8Array {
    if (this.#at + size > this.#end) throw new Error('a field runs past its message');
    const bytes = this.#bytes.subarray(this.#at, this.#at + size);
    this.#at += size;
    return bytes;
  }

  fixed64(): bigint {
    const bytes = this.#fixed(8);
    return new DataView(bytes.buffer, bytes.byteOffset, 8).getBigUint64(0, true);
  }

  double(): number {
    const bytes = this.#fixed(8);
    return new DataView(bytes.buffer, bytes.byteOffset, 8).getFloat64(0, true);
  }

  /** A length-delimited field, as a reader over its bytes. */
  nested(): Wire {
    const length = Number(this.varint());
    if (this.#at + length > this.#end) throw new Error('a field runs past its message');
    const inner = new Wire(this.#bytes, this.#at, this.#at + length);
    this.#at += length;
    return inner;
  }

  bytes(): Uint8Array {
    const length = Number(this.varint());
    return this.#fixed(length);
  }

  string(): string {
    return utf8(this.bytes());
  }

  /** The next field: its number and wire type. */
  tag(): { readonly field: number; readonly type: number } {
    const key = Number(this.varint());
    return { field: key >>> 3, type: key & 0x7 };
  }

  skip(type: number): void {
    if (type === 0) this.varint();
    else if (type === 1) this.#fixed(8);
    else if (type === 2) this.bytes();
    else if (type === 5) this.#fixed(4);
    else throw new Error(`an unknown wire type ${String(type)}`);
  }
}

/** Reads a message field by field; `read` handles the fields it knows, the rest are skipped. */
function fields(wire: Wire, read: (field: number, type: number) => boolean): void {
  while (!wire.done()) {
    const { field, type } = wire.tag();
    if (!read(field, type)) wire.skip(type);
  }
}

function anyValue(wire: Wire): AttributeValue | undefined {
  let value: AttributeValue | undefined;
  fields(wire, (field, type) => {
    if (field === 1 && type === 2) value = wire.string();
    else if (field === 2 && type === 0) value = wire.varint() !== 0n;
    else if (field === 3 && type === 0) value = Number(BigInt.asIntN(64, wire.varint()));
    else if (field === 4 && type === 1) value = wire.double();
    else return false;
    return true;
  });
  return value;
}

function readSpan(wire: Wire): OtlpSpan {
  let traceId = '';
  let spanId = '';
  let name = '';
  let startNs = 0n;
  let endNs = 0n;
  let error = false;
  const attributes = new Map<string, AttributeValue>();
  fields(wire, (field, type) => {
    if (field === 1 && type === 2) traceId = hex(wire.bytes());
    else if (field === 2 && type === 2) spanId = hex(wire.bytes());
    else if (field === 5 && type === 2) name = wire.string();
    else if (field === 7 && type === 1) startNs = wire.fixed64();
    else if (field === 8 && type === 1) endNs = wire.fixed64();
    else if (field === 9 && type === 2) {
      const pair = wire.nested();
      let key: string | undefined;
      let value: AttributeValue | undefined;
      fields(pair, (inner, innerType) => {
        if (inner === 1 && innerType === 2) key = pair.string();
        else if (inner === 2 && innerType === 2) value = anyValue(pair.nested());
        else return false;
        return true;
      });
      if (key !== undefined && value !== undefined) attributes.set(key, value);
    } else if (field === 15 && type === 2) {
      const status = wire.nested();
      fields(status, (inner, innerType) => {
        if (inner === 3 && innerType === 0) error = Number(status.varint()) === STATUS_ERROR;
        else return false;
        return true;
      });
    } else return false;
    return true;
  });
  return { traceId, spanId, name, startNs, endNs, error, attributes };
}

/** The spans of an OTLP protobuf export; undefined when the bytes can't be read. */
export function readOtlpProtobuf(bytes: Uint8Array): OtlpSpan[] | undefined {
  const spans: OtlpSpan[] = [];
  try {
    const request = new Wire(bytes);
    fields(request, (field, type) => {
      if (field !== 1 || type !== 2) return false;
      const resource = request.nested();
      fields(resource, (inner, innerType) => {
        if (inner !== 2 || innerType !== 2) return false;
        const scope = resource.nested();
        fields(scope, (deep, deepType) => {
          if (deep !== 2 || deepType !== 2) return false;
          spans.push(readSpan(scope.nested()));
          return true;
        });
        return true;
      });
      return true;
    });
  } catch {
    return undefined;
  }
  return spans;
}
