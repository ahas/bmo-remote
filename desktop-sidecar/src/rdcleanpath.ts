// RDCleanPath, the handshake IronRDP's web client expects from a websocket gateway, and the relay
// that answers it for this PC's RDP server (docs/remote.md, 「The relay」).
//
// A PDU is a DER SEQUENCE of EXPLICIT context-tagged fields:
//   [0] version INTEGER            [1] error RDCleanPathErr     [2] destination UTF8String
//   [3] proxy_auth UTF8String      [4] server_auth UTF8String   [5] preconnection_blob UTF8String
//   [6] x224_connection_pdu OCTET STRING
//   [7] server_cert_chain SEQUENCE OF OCTET STRING               [9] server_addr UTF8String
// and an error is a SEQUENCE of [0] error_code, [1] http_status_code, [2] wsa_last_error and
// [3] tls_alert_code, all INTEGER.

export const CLEANPATH_VERSION = 3390;
export const GENERAL_ERROR = 1;
export const NEGOTIATION_ERROR = 2;

const TAG_INTEGER = 0x02;
const TAG_OCTET_STRING = 0x04;
const TAG_UTF8_STRING = 0x0c;
const TAG_SEQUENCE = 0x30;
const TAG_CONTEXT = 0xa0;

// A request is a few hundred bytes; anything far larger is not one.
const MAX_PDU_BYTES = 64 * 1024;

export class CleanPathError extends Error {}

interface Element {
  tag: number;
  content: Uint8Array;
  end: number;
}

function readElement(bytes: Uint8Array, at: number, limit: number): Element {
  if (at + 2 > limit) throw new CleanPathError("truncated element");

  const tag = bytes[at]!;
  let length = bytes[at + 1]!;
  let start = at + 2;

  if (length & 0x80) {
    const count = length & 0x7f;

    // DER forbids the indefinite form, and no length here needs more than three bytes.
    if (count === 0 || count > 3) throw new CleanPathError("unsupported length");
    if (start + count > limit) throw new CleanPathError("truncated length");

    length = 0;

    for (let index = 0; index < count; index += 1) length = length * 256 + bytes[start + index]!;

    start += count;
  }

  const end = start + length;

  if (end > limit) throw new CleanPathError("element runs past its container");

  return { tag, content: bytes.subarray(start, end), end };
}

function readFields(bytes: Uint8Array): Map<number, Element> {
  const top = readElement(bytes, 0, bytes.length);

  if (top.tag !== TAG_SEQUENCE) throw new CleanPathError("not a sequence");

  const fields = new Map<number, Element>();
  let at = 0;

  while (at < top.content.length) {
    const outer = readElement(top.content, at, top.content.length);

    if ((outer.tag & 0xe0) !== TAG_CONTEXT) throw new CleanPathError("field is not context-tagged");

    const inner = readElement(outer.content, 0, outer.content.length);

    if (inner.end !== outer.content.length) throw new CleanPathError("trailing bytes in a field");

    fields.set(outer.tag & 0x1f, inner);
    at = outer.end;
  }

  return fields;
}

function readInteger(element: Element): number {
  if (element.tag !== TAG_INTEGER || element.content.length === 0 || element.content.length > 6) {
    throw new CleanPathError("bad integer");
  }

  if (element.content[0]! & 0x80) throw new CleanPathError("negative integer");

  return element.content.reduce((sum, byte) => sum * 256 + byte, 0);
}

function readText(element: Element): string {
  if (element.tag !== TAG_UTF8_STRING) throw new CleanPathError("bad string");

  return new TextDecoder("utf-8", { fatal: true }).decode(element.content);
}

function lengthBytes(length: number): number[] {
  if (length < 0x80) return [length];

  const bytes: number[] = [];

  for (let rest = length; rest > 0; rest = Math.floor(rest / 256)) bytes.unshift(rest & 0xff);

  return [0x80 | bytes.length, ...bytes];
}

function element(tag: number, content: Uint8Array): Uint8Array {
  const head = [tag, ...lengthBytes(content.length)];
  const out = new Uint8Array(head.length + content.length);

  out.set(head);
  out.set(content, head.length);

  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;

  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }

  return out;
}

function integer(value: number): Uint8Array {
  const bytes: number[] = [];

  for (let rest = value; ; rest = Math.floor(rest / 256)) {
    bytes.unshift(rest & 0xff);

    if (rest < 256) break;
  }

  if (bytes[0]! & 0x80) bytes.unshift(0);

  return element(TAG_INTEGER, new Uint8Array(bytes));
}

const field = (tag: number, content: Uint8Array) => element(TAG_CONTEXT | tag, content);
const text = (value: string) => element(TAG_UTF8_STRING, new TextEncoder().encode(value));
const sequence = (parts: Uint8Array[]) => element(TAG_SEQUENCE, concat(parts));

export interface CleanPathRequest {
  version: number;
  destination?: string;
  x224: Uint8Array;
}

export function decodeRequest(bytes: Uint8Array): CleanPathRequest {
  if (bytes.length > MAX_PDU_BYTES) throw new CleanPathError("request too large");

  const fields = readFields(bytes);
  const version = fields.get(0);
  const x224 = fields.get(6);

  if (!version || readInteger(version) !== CLEANPATH_VERSION) throw new CleanPathError("unsupported version");
  if (!x224 || x224.tag !== TAG_OCTET_STRING || x224.content.length < 4) {
    throw new CleanPathError("no X.224 connection request");
  }

  const destination = fields.get(2);

  return {
    version: CLEANPATH_VERSION,
    destination: destination ? readText(destination) : undefined,
    x224: x224.content.slice()
  };
}

export function encodeRequest(request: { destination?: string; x224: Uint8Array }): Uint8Array {
  return sequence([
    field(0, integer(CLEANPATH_VERSION)),
    ...(request.destination !== undefined ? [field(2, text(request.destination))] : []),
    field(6, element(TAG_OCTET_STRING, request.x224))
  ]);
}

export interface CleanPathResponse {
  x224: Uint8Array;
  certChain: Uint8Array[];
  serverAddr: string;
}

export function encodeResponse(response: CleanPathResponse): Uint8Array {
  return sequence([
    field(0, integer(CLEANPATH_VERSION)),
    field(6, element(TAG_OCTET_STRING, response.x224)),
    field(7, sequence(response.certChain.map((cert) => element(TAG_OCTET_STRING, cert)))),
    field(9, text(response.serverAddr))
  ]);
}

export interface CleanPathFailure {
  code: number;
  httpStatus?: number;
  wsaError?: number;
  tlsAlert?: number;
}

export function encodeError(failure: CleanPathFailure): Uint8Array {
  const parts = [field(0, integer(failure.code))];

  if (failure.httpStatus !== undefined) parts.push(field(1, integer(failure.httpStatus)));
  if (failure.wsaError !== undefined) parts.push(field(2, integer(failure.wsaError)));
  if (failure.tlsAlert !== undefined) parts.push(field(3, integer(failure.tlsAlert)));

  return sequence([field(0, integer(CLEANPATH_VERSION)), field(1, sequence(parts))]);
}

// What a response carries, read back: a check on the encoder and what a test client reads.
export function decodeResponse(bytes: Uint8Array): { error?: CleanPathFailure } & Partial<CleanPathResponse> {
  const fields = readFields(bytes);
  const failure = fields.get(1);

  if (failure) {
    if (failure.tag !== TAG_SEQUENCE) throw new CleanPathError("bad error");

    const inner = readFields(element(TAG_SEQUENCE, failure.content));
    const read = (tag: number) => (inner.has(tag) ? readInteger(inner.get(tag)!) : undefined);

    return { error: { code: read(0) ?? 0, httpStatus: read(1), wsaError: read(2), tlsAlert: read(3) } };
  }

  const chain = fields.get(7);
  const certChain: Uint8Array[] = [];

  if (chain) {
    for (let at = 0; at < chain.content.length; ) {
      const cert = readElement(chain.content, at, chain.content.length);

      certChain.push(cert.content.slice());
      at = cert.end;
    }
  }

  return {
    x224: fields.get(6)?.content.slice(),
    certChain,
    serverAddr: fields.has(9) ? readText(fields.get(9)!) : undefined
  };
}

// One TPKT packet from the front of a stream: its whole length, or null while it is incomplete.
export function tpktLength(bytes: Uint8Array): number | null {
  if (bytes.length < 4) return null;
  if (bytes[0] !== 3) throw new CleanPathError("not a TPKT packet");

  const length = (bytes[2]! << 8) | bytes[3]!;

  if (length < 7) throw new CleanPathError("bad TPKT length");

  return bytes.length >= length ? length : null;
}

// The client core data block (TS_UD_CS_CORE) of the MCS Connect Initial the browser sends first.
const CS_CORE_TYPE = 0xc001;
const CS_CORE_MIN_LENGTH = 146;
const CS_CORE_SERVER_SELECTED_PROTOCOL = 212;

// Rewrites the client's core data in place, and says whether the block was in these bytes.
//
// The field rewritten is the protocol the client believes was chosen: where the relay ran NLA on
// the browser's behalf it told the browser TLS, so the block would otherwise disagree with what the
// server chose and the server would read it as a downgrade attack. The field is of fixed size, so it
// is rewritten where it stands and no length around it changes.
export function rewriteCoreData(bytes: Uint8Array, serverSelected: number | null): boolean {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  for (let at = 0; at + CS_CORE_MIN_LENGTH <= bytes.length; at += 1) {
    if (view.getUint16(at, true) !== CS_CORE_TYPE) continue;

    const length = view.getUint16(at + 2, true);
    const version = view.getUint32(at + 4, true);

    // The block's own length, and an RDP version (0x00080001 and up), say this is the block.
    if (length < CS_CORE_MIN_LENGTH || at + length > bytes.length || version >>> 16 !== 0x0008) continue;

    if (serverSelected !== null && length >= CS_CORE_SERVER_SELECTED_PROTOCOL + 4) {
      view.setUint32(at + CS_CORE_SERVER_SELECTED_PROTOCOL, serverSelected, true);
    }

    return true;
  }

  return false;
}
