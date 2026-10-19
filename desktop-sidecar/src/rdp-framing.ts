// The server's stream, cut into its PDUs (docs/remote.md, 「The relay」). The relay reads what the
// server sends only to find the pointer's shapes and a redirection, and both are read one whole PDU at
// a time: slow-path ones in TPKT framing, and fast-path ones. A PDU is held until it is whole, and a
// stream this cannot frame is passed on untouched from then on. The client's stream is only counted,
// for where the relay may type into it.

const TPKT_VERSION = 3;

const FASTPATH_ACTION_MASK = 0x03;
const FASTPATH_ENCRYPTED = 0x80;
const FASTPATH_COMPRESSION_USED = 0x2;
const PACKET_COMPRESSED = 0x20;

// The whole length of the PDU at the front of a stream, or null while its header is incomplete.
// Throws on a stream that is neither framing.
export function pduLength(bytes: Uint8Array): number | null {
  if (bytes.length < 1) return null;

  if (bytes[0] === TPKT_VERSION) {
    if (bytes.length < 4) return null;

    const length = (bytes[2]! << 8) | bytes[3]!;

    if (length < 7) throw new Error("bad TPKT length");

    return length;
  }

  if ((bytes[0]! & FASTPATH_ACTION_MASK) !== 0) throw new Error("not a PDU");
  if (bytes.length < 2) return null;

  // A length shorter than the header that states it frames nothing, and the stream never moves on.
  if (bytes[1]! & 0x80) {
    if (bytes.length < 3) return null;

    const length = ((bytes[1]! & 0x7f) << 8) | bytes[2]!;

    if (length < 3) throw new Error("bad fast-path length");

    return length;
  }

  if (bytes[1]! < 2) throw new Error("bad fast-path length");

  return bytes[1]!;
}

export interface FastPathUpdate {
  code: number;
  fragmentation: number;
  compressed: boolean;
  data: Uint8Array;
}

// The updates of a fast-path PDU, as views into it; null when the PDU cannot be read as clear text.
export function fastPathUpdates(pdu: Uint8Array): FastPathUpdate[] | null {
  if (pdu[0]! & FASTPATH_ENCRYPTED) return null;

  let at = pdu[1]! & 0x80 ? 3 : 2;
  const updates: FastPathUpdate[] = [];

  while (at < pdu.length) {
    const header = pdu[at]!;
    const compression = (header >> 6) & 0x3;
    let compressed = false;

    at += 1;

    if (compression & FASTPATH_COMPRESSION_USED) {
      if (at >= pdu.length) return null;

      compressed = (pdu[at]! & PACKET_COMPRESSED) !== 0;
      at += 1;
    }

    if (at + 2 > pdu.length) return null;

    const size = pdu[at]! | (pdu[at + 1]! << 8);

    at += 2;

    if (at + size > pdu.length) return null;

    updates.push({ code: header & 0xf, fragmentation: (header >> 4) & 0x3, compressed, data: pdu.subarray(at, at + size) });
    at += size;
  }

  return updates;
}

function concat(first: Uint8Array, second: Uint8Array): Uint8Array {
  const out = new Uint8Array(first.length + second.length);

  out.set(first);
  out.set(second, first.length);

  return out;
}

export function createServerFraming() {
  let pending = new Uint8Array();
  let passthrough = false;

  return {
    // Takes what the server sent; gives back the PDUs it completed, in order. A stream that cannot be
    // framed is given back as it came.
    push(chunk: Uint8Array): Uint8Array[] {
      if (passthrough) return [chunk];

      let buffer = pending.length ? concat(pending, chunk) : chunk;
      const out: Uint8Array[] = [];

      for (;;) {
        let length: number | null;

        try {
          length = pduLength(buffer);
        } catch {
          passthrough = true;
          out.push(buffer);
          pending = new Uint8Array();

          return out;
        }

        if (length === null || buffer.length < length) break;

        out.push(buffer.slice(0, length));
        buffer = buffer.subarray(length);
      }

      pending = buffer.slice();

      return out;
    },
    // What is still held, when the stream ends.
    flush(): Uint8Array[] {
      const out = pending.length ? [pending] : [];

      pending = new Uint8Array();

      return out;
    }
  };
}

// Counts where the client's own PDUs end, so what the relay types never lands inside one of them
// (docs/remote.md, 「The on-screen keyboard」). A slow-path PDU is TPKT-framed and says its length at
// bytes 2–3; a fast-path one says it in its second byte, or its second and third with the top bit set.
export function createClientFraming() {
  let left = 0;
  let head: number[] = [];
  let lost = false;

  function between(): boolean {
    return !lost && left === 0 && head.length === 0;
  }

  function lengthOf(bytes: number[]): number | null {
    if (bytes[0] === 3) return bytes.length >= 4 ? (bytes[2]! << 8) | bytes[3]! : null;
    if ((bytes[0]! & 0x3) !== 0) return 0;
    if (bytes.length < 2) return null;
    if (!(bytes[1]! & 0x80)) return bytes[1]!;

    return bytes.length >= 3 ? ((bytes[1]! & 0x7f) << 8) | bytes[2]! : null;
  }

  return {
    // Reads a chunk the client sent; answers whether the stream now stands between two PDUs.
    push(chunk: Uint8Array): boolean {
      if (lost) return false;

      let at = 0;

      while (at < chunk.length) {
        if (left > 0) {
          const taken = Math.min(left, chunk.length - at);

          left -= taken;
          at += taken;
          continue;
        }

        head.push(chunk[at]!);
        at++;

        const length = lengthOf(head);

        if (length === null) continue;
        if (length < head.length) {
          lost = true;

          return false;
        }

        left = length - head.length;
        head = [];
      }

      return between();
    },
    // Whether the stream stands between two PDUs, where something typed may go in.
    get between(): boolean {
      return between();
    },
    get lost(): boolean {
      return lost;
    }
  };
}
