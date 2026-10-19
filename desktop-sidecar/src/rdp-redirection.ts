// The server redirection PDU (MS-RDPBCGR 2.2.13.3.1), as the relay reads it out of the server's stream
// (docs/remote.md, 「Redirection」). gnome-remote-desktop's system daemon sends one to hand a
// connection to the login screen, and the login screen's daemon sends one to hand it to the session.
//
// It is slow-path: TPKT, X.224 data, an MCS send-data indication, a share control header whose type
// is PDUTYPE_SERVER_REDIR_PKT, two bytes of padding, then the redirection packet — flags
// (SEC_REDIRECTION_PKT), its length, the session id, the redirection flags and one length-prefixed
// field for each flag set, in a fixed order.

const X224_DATA = [0x02, 0xf0, 0x80];
const MCS_SEND_DATA_INDICATION = 0x68;
const PDUTYPE_SERVER_REDIR_PKT = 0xa;
const SEC_REDIRECTION_PKT = 0x0400;

const LB_TARGET_NET_ADDRESS = 0x1;
const LB_LOAD_BALANCE_INFO = 0x2;
const LB_USERNAME = 0x4;
const LB_DOMAIN = 0x8;
const LB_PASSWORD = 0x10;
const LB_TARGET_FQDN = 0x100;
const LB_TARGET_NETBIOS_NAME = 0x200;
const LB_TARGET_NET_ADDRESSES = 0x800;
const LB_CLIENT_TSV_URL = 0x1000;
const LB_REDIRECTION_GUID = 0x8000;
const LB_TARGET_CERTIFICATE = 0x10000;

// The fields in the order they stand, each with the flag that says it is there.
const FIELDS = [
  LB_TARGET_NET_ADDRESS,
  LB_LOAD_BALANCE_INFO,
  LB_USERNAME,
  LB_DOMAIN,
  LB_PASSWORD,
  LB_TARGET_FQDN,
  LB_TARGET_NETBIOS_NAME,
  LB_CLIENT_TSV_URL,
  LB_REDIRECTION_GUID,
  LB_TARGET_CERTIFICATE,
  LB_TARGET_NET_ADDRESSES
] as const;

export interface Redirection {
  sessionId: number;
  flags: number;
  loadBalanceInfo: Uint8Array | null;
  username: string | null;
  domain: string | null;
  // The one-time password the next connection authenticates with. gnome-remote-desktop flags it
  // encrypted for every client that is not a phone and still sends the text in clear, so the flag is
  // not read; a password that really was encrypted fails that authentication as a wrong one.
  password: string | null;
}

function readUtf16z(bytes: Uint8Array): string {
  let text = "";

  for (let at = 0; at + 1 < bytes.length; at += 2) {
    const code = bytes[at]! | (bytes[at + 1]! << 8);

    if (code === 0) break;

    text += String.fromCharCode(code);
  }

  return text;
}

// The redirection in one slow-path PDU, or null where the PDU is not one.
export function readRedirection(pdu: Uint8Array): Redirection | null {
  if (pdu.length < 12 || pdu[0] !== 3) return null;
  if (pdu[4] !== X224_DATA[0] || pdu[5] !== X224_DATA[1] || pdu[6] !== X224_DATA[2]) return null;
  if (pdu[7] !== MCS_SEND_DATA_INDICATION) return null;

  // Initiator, channel id and priority, then the PER length of the data.
  let at = 8 + 5;

  if (at >= pdu.length) return null;

  at += pdu[at]! & 0x80 ? 2 : 1;

  const view = new DataView(pdu.buffer, pdu.byteOffset, pdu.byteLength);

  if (at + 8 > pdu.length || (view.getUint16(at + 2, true) & 0xf) !== PDUTYPE_SERVER_REDIR_PKT) return null;

  // The share control header, then the padding.
  at += 6 + 2;

  if (at + 12 > pdu.length || view.getUint16(at, true) !== SEC_REDIRECTION_PKT) return null;

  const sessionId = view.getUint32(at + 4, true);
  const flags = view.getUint32(at + 8, true);
  const fields = new Map<number, Uint8Array>();

  at += 12;

  for (const flag of FIELDS) {
    if (!(flags & flag)) continue;
    if (at + 4 > pdu.length) return null;

    const length = view.getUint32(at, true);

    if (at + 4 + length > pdu.length) return null;

    fields.set(flag, pdu.slice(at + 4, at + 4 + length));
    at += 4 + length;
  }

  const text = (flag: number) => (fields.has(flag) ? readUtf16z(fields.get(flag)!) : null);

  return {
    sessionId,
    flags,
    loadBalanceInfo: fields.get(LB_LOAD_BALANCE_INFO) ?? null,
    username: text(LB_USERNAME),
    domain: text(LB_DOMAIN),
    password: text(LB_PASSWORD)
  };
}
