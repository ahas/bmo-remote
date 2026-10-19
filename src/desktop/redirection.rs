//! The server redirection PDU (MS-RDPBCGR 2.2.13.3.1), as the relay reads it out of the server's stream
//! (`docs/remote.md`, 「Redirection」). gnome-remote-desktop's system daemon sends one to hand a connection to
//! the login screen, and the login screen's daemon sends one to hand it to the session.
//!
//! It is slow-path: TPKT, X.224 data, an MCS send-data indication, a share control header whose type is
//! PDUTYPE_SERVER_REDIR_PKT, two bytes of padding, then the redirection packet — flags (SEC_REDIRECTION_PKT),
//! its length, the session id, the redirection flags and one length-prefixed field for each flag set, in a
//! fixed order. It is read by hand: `ironrdp-pdu` names the PDU type and has no decoder for the packet.

const TPKT_VERSION: u8 = 3;
const X224_DATA: [u8; 3] = [0x02, 0xf0, 0x80];
const MCS_SEND_DATA_INDICATION: u8 = 0x68;
const PDUTYPE_SERVER_REDIR_PKT: u16 = 0xa;
const SEC_REDIRECTION_PKT: u16 = 0x0400;

const LB_TARGET_NET_ADDRESS: u32 = 0x1;
const LB_LOAD_BALANCE_INFO: u32 = 0x2;
const LB_USERNAME: u32 = 0x4;
const LB_DOMAIN: u32 = 0x8;
const LB_PASSWORD: u32 = 0x10;
const LB_TARGET_FQDN: u32 = 0x100;
const LB_TARGET_NETBIOS_NAME: u32 = 0x200;
const LB_TARGET_NET_ADDRESSES: u32 = 0x800;
const LB_CLIENT_TSV_URL: u32 = 0x1000;
const LB_REDIRECTION_GUID: u32 = 0x8000;
const LB_TARGET_CERTIFICATE: u32 = 0x10000;

// The fields in the order they stand, each with the flag that says it is there.
const FIELDS: [u32; 11] = [
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
  LB_TARGET_NET_ADDRESSES,
];

/// What a redirection tells the next connection.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Redirection {
  pub session_id: u32,
  pub flags: u32,
  pub load_balance_info: Option<Vec<u8>>,
  pub username: Option<String>,
  pub domain: Option<String>,
  /// The one-time password the next connection authenticates with. gnome-remote-desktop flags it encrypted
  /// for every client that is not a phone and still sends the text in clear, so the flag is not read; a
  /// password that really was encrypted fails that authentication as a wrong one.
  pub password: Option<String>,
}

fn u16_at(bytes: &[u8], at: usize) -> u16 {
  u16::from_le_bytes([bytes[at], bytes[at + 1]])
}

fn u32_at(bytes: &[u8], at: usize) -> u32 {
  u32::from_le_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]])
}

// UTF-16LE text up to its terminating zero.
fn read_utf16z(bytes: &[u8]) -> String {
  let (pairs, _) = bytes.as_chunks::<2>();
  let units: Vec<u16> = pairs
    .iter()
    .map(|pair| u16::from_le_bytes(*pair))
    .take_while(|&unit| unit != 0)
    .collect();

  String::from_utf16_lossy(&units)
}

/// The redirection in one slow-path PDU, or none where the PDU is not one.
pub fn read_redirection(pdu: &[u8]) -> Option<Redirection> {
  if pdu.len() < 12 || pdu[0] != TPKT_VERSION || pdu[4..7] != X224_DATA {
    return None;
  }

  if pdu[7] != MCS_SEND_DATA_INDICATION {
    return None;
  }

  // Initiator, channel id and priority, then the PER length of the data.
  let mut at = 8 + 5;

  if at >= pdu.len() {
    return None;
  }

  at += if pdu[at] & 0x80 != 0 { 2 } else { 1 };

  if at + 8 > pdu.len() || u16_at(pdu, at + 2) & 0xf != PDUTYPE_SERVER_REDIR_PKT {
    return None;
  }

  // The share control header, then the padding.
  at += 6 + 2;

  if at + 12 > pdu.len() || u16_at(pdu, at) != SEC_REDIRECTION_PKT {
    return None;
  }

  let session_id = u32_at(pdu, at + 4);
  let flags = u32_at(pdu, at + 8);
  let mut fields: Vec<(u32, &[u8])> = Vec::new();

  at += 12;

  for flag in FIELDS {
    if flags & flag == 0 {
      continue;
    }

    if at + 4 > pdu.len() {
      return None;
    }

    let length = u32_at(pdu, at) as usize;

    if at + 4 + length > pdu.len() {
      return None;
    }

    fields.push((flag, &pdu[at + 4..at + 4 + length]));
    at += 4 + length;
  }

  let field = |flag: u32| fields.iter().find(|(one, _)| *one == flag).map(|(_, value)| *value);
  let text = |flag: u32| field(flag).map(read_utf16z);

  Some(Redirection {
    session_id,
    flags,
    load_balance_info: field(LB_LOAD_BALANCE_INFO).map(<[u8]>::to_vec),
    username: text(LB_USERNAME),
    domain: text(LB_DOMAIN),
    password: text(LB_PASSWORD),
  })
}
