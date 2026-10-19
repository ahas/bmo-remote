// The X.224 connection request and confirm as the relay rewrites them (docs/remote.md, 「The relay」):
// the security protocols asked for, the routing token a redirected connection must carry, and the
// protocol the browser is told was chosen.
//
// A request is TPKT (4) and the X.224 header (7), then an optional cookie or routing token ending
// in CR LF, then an optional RDP_NEG_REQ (type 1, flags, length 8, requestedProtocols) and, where
// its flags say so, 36 bytes of correlation info. A confirm is the same header with an RDP_NEG_RSP
// (type 2) or an RDP_NEG_FAILURE (type 3) after it.

export const PROTOCOL_SSL = 0x1;
export const PROTOCOL_HYBRID = 0x2;

const HEADER = 11;
const NEG_REQ = 1;
const NEG_RSP = 2;
const NEG_LENGTH = 8;

export interface ConnectionRequest {
  // The cookie or routing token, CR LF included, as it stood.
  token: Uint8Array;
  // The protocols asked for, or null where the request carries no negotiation.
  protocols: number | null;
  flags: number;
  // What followed the negotiation, the correlation info.
  rest: Uint8Array;
}

export function readConnectionRequest(bytes: Uint8Array): ConnectionRequest | null {
  if (bytes.length < HEADER || bytes[0] !== 3 || bytes[5] !== 0xe0) return null;

  let at = HEADER;
  let token = new Uint8Array();

  // A cookie and a routing token are both text ending in CR LF.
  if (bytes.length - at >= 2 && bytes[at] !== NEG_REQ) {
    let end = -1;

    for (let index = at; index + 1 < bytes.length; index += 1) {
      if (bytes[index] === 0x0d && bytes[index + 1] === 0x0a) {
        end = index + 2;
        break;
      }
    }

    if (end < 0) return null;

    token = bytes.slice(at, end);
    at = end;
  }

  if (bytes.length - at < NEG_LENGTH || bytes[at] !== NEG_REQ) return { token, protocols: null, flags: 0, rest: bytes.slice(at) };

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  return { token, protocols: view.getUint32(at + 4, true), flags: bytes[at + 1]!, rest: bytes.slice(at + NEG_LENGTH) };
}

// The request written out again, with its lengths.
export function writeConnectionRequest(original: Uint8Array, request: ConnectionRequest): Uint8Array {
  const negotiation = request.protocols === null ? new Uint8Array() : new Uint8Array(NEG_LENGTH);

  if (request.protocols !== null) {
    const view = new DataView(negotiation.buffer);

    negotiation[0] = NEG_REQ;
    negotiation[1] = request.flags;
    view.setUint16(2, NEG_LENGTH, true);
    view.setUint32(4, request.protocols, true);
  }

  const length = HEADER + request.token.length + negotiation.length + request.rest.length;
  const out = new Uint8Array(length);

  out.set(original.subarray(0, HEADER));
  out[2] = length >> 8;
  out[3] = length & 0xff;
  // The X.224 length indicator counts the header after itself.
  out[4] = length - 5;
  out.set(request.token, HEADER);
  out.set(negotiation, HEADER + request.token.length);
  out.set(request.rest, HEADER + request.token.length + negotiation.length);

  return out;
}

// A routing token as the request carries it: the redirection's load-balance info, ending in CR LF.
export function routingToken(loadBalanceInfo: Uint8Array): Uint8Array {
  const ends = loadBalanceInfo.length >= 2 && loadBalanceInfo.at(-2) === 0x0d && loadBalanceInfo.at(-1) === 0x0a;

  if (ends) return loadBalanceInfo.slice();

  const out = new Uint8Array(loadBalanceInfo.length + 2);

  out.set(loadBalanceInfo);
  out.set([0x0d, 0x0a], loadBalanceInfo.length);

  return out;
}

// The protocol a confirm says the server chose, or null where it chose none (a failure, or an old
// server that negotiates nothing).
export function selectedProtocol(confirm: Uint8Array): number | null {
  if (confirm.length < HEADER + NEG_LENGTH || confirm[HEADER] !== NEG_RSP) return null;

  return new DataView(confirm.buffer, confirm.byteOffset, confirm.byteLength).getUint32(HEADER + 4, true);
}

// The confirm with another protocol said to be chosen, in a copy.
export function withSelectedProtocol(confirm: Uint8Array, protocol: number): Uint8Array {
  const out = confirm.slice();

  if (selectedProtocol(out) !== null) new DataView(out.buffer).setUint32(HEADER + 4, protocol, true);

  return out;
}
