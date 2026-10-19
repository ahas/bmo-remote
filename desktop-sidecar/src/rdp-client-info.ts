import type { RemoteDesktopQuality } from "./quality";

// The client's logon packet (TS_INFO_PACKET) as the relay rewrites it (docs/remote.md, 「Credentials」
// and 「Connection settings」): the placeholder the browser sent as its password is emptied and the
// logon is made a manual one, so no server logs a session on by itself, and the performance flags the
// owner chose replace the client's own. The packet is rebuilt whole, so every length around it is
// written again.

// What the browser sends as the password where the relay authenticates for it with the password the
// console keeps; the client builds no connection without one.
export const KEPT_PASSWORD_PLACEHOLDER = "bmo-console-kept-password";

const X224_DATA = [0x02, 0xf0, 0x80];
const MCS_SEND_DATA_REQUEST = 0x64;
const SEC_INFO_PKT = 0x0040;
const INFO_AUTOLOGON = 0x0008;
const INFO_UNICODE = 0x0010;
// CodePage, flags and the five string lengths.
const INFO_FIXED = 18;
// The client's time zone, which stands between the client directory and the performance flags.
const TIME_ZONE_LENGTH = 172;

export interface ClientInfoChange {
  // The performance flags to ask for, in place of the client's.
  performanceFlags?: number | null;
}

interface Parsed {
  head: Uint8Array;
  security: Uint8Array;
  info: Uint8Array;
}

function readUtf16(bytes: Uint8Array): string {
  let text = "";

  for (let at = 0; at + 1 < bytes.length; at += 2) text += String.fromCharCode(bytes[at]! | (bytes[at + 1]! << 8));

  return text;
}

// The PER length of the MCS user data: one byte below 0x80, two bytes with the top bit set otherwise.
function readPerLength(bytes: Uint8Array, at: number): { length: number; size: number } | null {
  const first = bytes[at];

  if (first === undefined) return null;
  if ((first & 0x80) === 0) return { length: first, size: 1 };

  const second = bytes[at + 1];

  return second === undefined ? null : { length: ((first & 0x3f) << 8) | second, size: 2 };
}

function writePerLength(length: number): number[] {
  return length < 0x80 ? [length] : [0x80 | (length >> 8), length & 0xff];
}

// One TPKT packet read as a logon packet, or null where it is some other packet.
function parse(packet: Uint8Array): Parsed | null {
  if (packet.length < 4 || packet[0] !== 3) return null;

  const tpkt = (packet[2]! << 8) | packet[3]!;

  if (tpkt !== packet.length || packet[4] !== X224_DATA[0] || packet[5] !== X224_DATA[1] || packet[6] !== X224_DATA[2]) return null;
  if (packet[7] !== MCS_SEND_DATA_REQUEST) return null;

  // Initiator, channel and the priority byte, then the length of what follows.
  const lengthAt = 7 + 1 + 2 + 2 + 1;
  const per = readPerLength(packet, lengthAt);

  if (per === null) return null;

  const bodyAt = lengthAt + per.size;

  if (bodyAt + per.length !== packet.length || per.length < 4 + INFO_FIXED) return null;

  const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);

  if ((view.getUint16(bodyAt, true) & SEC_INFO_PKT) === 0) return null;

  return { head: packet.slice(7, lengthAt), security: packet.slice(bodyAt, bodyAt + 4), info: packet.slice(bodyAt + 4) };
}

// The logon packet rewritten, or null where this packet is not one or cannot be read as one.
export function rewriteClientInfo(packet: Uint8Array, change: ClientInfoChange): Uint8Array | null {
  const parsed = parse(packet);

  if (parsed === null) return null;

  const info = parsed.info;
  const view = new DataView(info.buffer, info.byteOffset, info.byteLength);
  let flags = view.getUint32(4, true);

  if ((flags & INFO_UNICODE) === 0) return null;

  const lengths = [8, 10, 12, 14, 16].map((at) => view.getUint16(at, true));
  const strings: Uint8Array[] = [];
  let at = INFO_FIXED;

  for (const length of lengths) {
    if (at + length + 2 > info.length) return null;

    strings.push(info.slice(at, at + length));
    at += length + 2;
  }

  const extra = info.slice(at);

  if (readUtf16(strings[2]!) === KEPT_PASSWORD_PLACEHOLDER) {
    strings[2] = new Uint8Array();
    flags &= ~INFO_AUTOLOGON;
  }

  if (change.performanceFlags !== null && change.performanceFlags !== undefined) {
    // Address family, the address, the client directory, the time zone and the session id stand
    // before the flags.
    const extraView = new DataView(extra.buffer, extra.byteOffset, extra.byteLength);

    if (extra.length >= 4) {
      const address = extraView.getUint16(2, true);
      const directoryAt = 4 + address;

      if (directoryAt + 2 <= extra.length) {
        const flagsAt = directoryAt + 2 + extraView.getUint16(directoryAt, true) + TIME_ZONE_LENGTH + 4;

        if (flagsAt + 4 <= extra.length) extraView.setUint32(flagsAt, change.performanceFlags >>> 0, true);
      }
    }
  }

  const fixed = new Uint8Array(INFO_FIXED);
  const fixedView = new DataView(fixed.buffer);

  fixed.set(info.slice(0, 4));
  fixedView.setUint32(4, flags, true);
  strings.forEach((one, index) => fixedView.setUint16(8 + index * 2, one.length, true));

  const parts: Uint8Array[] = [fixed];

  for (const one of strings) parts.push(one, new Uint8Array(2));

  parts.push(extra);

  const infoLength = parts.reduce((sum, part) => sum + part.length, 0);
  const body = 4 + infoLength;
  const perBytes = writePerLength(body);
  const total = 7 + parsed.head.length + perBytes.length + body;
  const out = new Uint8Array(total);
  let write = 0;

  const put = (bytes: ArrayLike<number>): void => {
    out.set(bytes, write);
    write += bytes.length;
  };

  put([3, 0, total >> 8, total & 0xff, ...X224_DATA]);
  put(parsed.head);
  put(perBytes);
  put(parsed.security);

  for (const part of parts) put(part);

  return out;
}

// The owner's quality choice as RDP performance flags.
export const PERFORMANCE_FLAGS: Record<RemoteDesktopQuality, number> = {
  // Everything that costs drawing is left out.
  fast: 0x01 | 0x02 | 0x04 | 0x08 | 0x20 | 0x40,
  // The wallpaper, the animations and the cursor shadow are left out.
  balanced: 0x01 | 0x04 | 0x20,
  // Everything is drawn, with smoothed fonts and composition.
  sharp: 0x80 | 0x100
};
