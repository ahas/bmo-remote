//! What the relay rewrites in the client's first frames after the handshake: the client core data block
//! (TS_UD_CS_CORE) of the MCS Connect Initial the browser sends first (`docs/remote.md`, 「Network-level
//! authentication」), and the logon packet (TS_INFO_PACKET) after it (「Credentials」, 「Connection
//! settings」).
//!
//! Both are read and rewritten by hand: decoding them with `ironrdp-pdu` and encoding them again would not
//! keep every other byte the browser wrote.

use crate::desktop::negotiation::SecurityProtocol;
use crate::desktop::quality::Quality;

const CS_CORE_TYPE: u16 = 0xc001;
const CS_CORE_MIN_LENGTH: usize = 146;
const CS_CORE_SERVER_SELECTED_PROTOCOL: usize = 212;
// An RDP version, 0x00080001 and up, in the block's version field.
const RDP_VERSION_MAJOR: u32 = 0x0008;

fn u16_at(bytes: &[u8], at: usize) -> u16 {
  u16::from_le_bytes([bytes[at], bytes[at + 1]])
}

fn u32_at(bytes: &[u8], at: usize) -> u32 {
  u32::from_le_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]])
}

/// Rewrites the client's core data in place, and says whether the block was in these bytes.
///
/// The field rewritten is the protocol the client believes was chosen: where the relay ran NLA on the
/// browser's behalf it told the browser TLS, so the block would otherwise disagree with what the server chose
/// and the server would read it as a downgrade attack. The field is of fixed size, so it is rewritten where it
/// stands and no length around it changes. With no protocol to write, the block is only found.
pub fn rewrite_core_data(bytes: &mut [u8], server_selected: Option<SecurityProtocol>) -> bool {
  let mut at = 0;

  while at + CS_CORE_MIN_LENGTH <= bytes.len() {
    if u16_at(bytes, at) != CS_CORE_TYPE {
      at += 1;
      continue;
    }

    let length = usize::from(u16_at(bytes, at + 2));
    let version = u32_at(bytes, at + 4);

    // The block's own length, and an RDP version, say this is the block.
    if length < CS_CORE_MIN_LENGTH || at + length > bytes.len() || version >> 16 != RDP_VERSION_MAJOR {
      at += 1;
      continue;
    }

    if let Some(protocol) = server_selected
      && length >= CS_CORE_SERVER_SELECTED_PROTOCOL + 4
    {
      let field = at + CS_CORE_SERVER_SELECTED_PROTOCOL;

      bytes[field..field + 4].copy_from_slice(&protocol.bits().to_le_bytes());
    }

    return true;
  }

  false
}

/// What the browser sends as the password where the relay authenticates for it with the password the service
/// keeps; the client builds no connection without one. The screen sends the same.
pub const KEPT_PASSWORD_PLACEHOLDER: &str = "bmo-console-kept-password";

const TPKT_VERSION: u8 = 3;
const X224_DATA: [u8; 3] = [0x02, 0xf0, 0x80];
const MCS_SEND_DATA_REQUEST: u8 = 0x64;
// Where the MCS request starts, and where the length of its user data stands after the initiator, the
// channel and the priority byte.
const MCS_HEAD_AT: usize = 7;
const MCS_LENGTH_AT: usize = MCS_HEAD_AT + 1 + 2 + 2 + 1;
const SECURITY_HEADER: usize = 4;
const SEC_INFO_PKT: u16 = 0x0040;
const INFO_AUTOLOGON: u32 = 0x0008;
const INFO_UNICODE: u32 = 0x0010;
// CodePage, flags and the five string lengths.
const INFO_FIXED: usize = 18;
const INFO_FLAGS_AT: usize = 4;
const INFO_LENGTHS_AT: usize = 8;
const INFO_STRINGS: usize = 5;
const INFO_PASSWORD: usize = 2;
// The client's time zone, which stands between the client directory and the performance flags.
const TIME_ZONE_LENGTH: usize = 172;
const SESSION_ID_LENGTH: usize = 4;

/// The PER length of the MCS user data and the bytes it takes: one byte below 0x80, two bytes with the top
/// bit set otherwise.
fn read_per_length(bytes: &[u8], at: usize) -> Option<(usize, usize)> {
  let first = *bytes.get(at)?;

  if first & 0x80 == 0 {
    return Some((usize::from(first), 1));
  }

  let second = *bytes.get(at + 1)?;

  Some(((usize::from(first & 0x3f) << 8) | usize::from(second), 2))
}

fn write_per_length(length: usize) -> Vec<u8> {
  if length < 0x80 {
    vec![length as u8]
  } else {
    vec![(0x80 | (length >> 8)) as u8, length as u8]
  }
}

/// One TPKT packet read as a logon packet: its MCS head, its security header and the packet itself.
struct LogonPacket<'a> {
  head: &'a [u8],
  security: &'a [u8],
  info: &'a [u8],
}

/// One TPKT packet read as a logon packet, or none where it is some other packet.
fn parse(packet: &[u8]) -> Option<LogonPacket<'_>> {
  if packet.len() < 4 || packet[0] != TPKT_VERSION {
    return None;
  }

  let tpkt = usize::from(u16::from_be_bytes([packet[2], packet[3]]));

  if tpkt != packet.len() || packet.get(4..MCS_HEAD_AT)? != X224_DATA {
    return None;
  }

  if *packet.get(MCS_HEAD_AT)? != MCS_SEND_DATA_REQUEST {
    return None;
  }

  let (length, size) = read_per_length(packet, MCS_LENGTH_AT)?;
  let body_at = MCS_LENGTH_AT + size;

  if body_at + length != packet.len() || length < SECURITY_HEADER + INFO_FIXED {
    return None;
  }

  if u16_at(packet, body_at) & SEC_INFO_PKT == 0 {
    return None;
  }

  Some(LogonPacket {
    head: &packet[MCS_HEAD_AT..MCS_LENGTH_AT],
    security: &packet[body_at..body_at + SECURITY_HEADER],
    info: &packet[body_at + SECURITY_HEADER..],
  })
}

/// Whether a password field holds the placeholder, read as UTF-16 code units, a last odd byte left out.
fn is_placeholder(password: &[u8]) -> bool {
  let (units, _) = password.as_chunks::<2>();

  units
    .iter()
    .map(|unit| u16::from_le_bytes(*unit))
    .eq(KEPT_PASSWORD_PLACEHOLDER.encode_utf16())
}

/// Writes performance flags into the extended part of the logon packet, where it is long enough to hold them.
/// The address family, the address, the client directory, the time zone and the session id stand before the
/// flags.
fn write_performance_flags(extra: &mut [u8], flags: u32) {
  if extra.len() < 4 {
    return;
  }

  let directory_at = 4 + usize::from(u16_at(extra, 2));

  if directory_at + 2 > extra.len() {
    return;
  }

  let flags_at =
    directory_at + 2 + usize::from(u16_at(extra, directory_at)) + TIME_ZONE_LENGTH + SESSION_ID_LENGTH;

  if flags_at + 4 <= extra.len() {
    extra[flags_at..flags_at + 4].copy_from_slice(&flags.to_le_bytes());
  }
}

/// The logon packet rewritten, or none where this packet is not one or cannot be read as one.
///
/// Where the password is the placeholder it is emptied and the automatic-logon flag cleared, so no server logs
/// a session on by itself; a quality's performance flags, where one is given, replace the client's own. The
/// packet is rebuilt whole, so the TPKT and MCS user data lengths around it are written again.
pub fn rewrite_client_info(packet: &[u8], quality: Option<Quality>) -> Option<Vec<u8>> {
  let parsed = parse(packet)?;
  let info = parsed.info;
  let mut flags = u32_at(info, INFO_FLAGS_AT);

  if flags & INFO_UNICODE == 0 {
    return None;
  }

  let mut strings: Vec<&[u8]> = Vec::with_capacity(INFO_STRINGS);
  let mut at = INFO_FIXED;

  for index in 0..INFO_STRINGS {
    let length = usize::from(u16_at(info, INFO_LENGTHS_AT + index * 2));

    // Each string is followed by its two-byte terminator.
    if at + length + 2 > info.len() {
      return None;
    }

    strings.push(&info[at..at + length]);
    at += length + 2;
  }

  let mut extra = info[at..].to_vec();

  if is_placeholder(strings[INFO_PASSWORD]) {
    strings[INFO_PASSWORD] = &[];
    flags &= !INFO_AUTOLOGON;
  }

  if let Some(quality) = quality {
    write_performance_flags(&mut extra, quality.performance_flags());
  }

  let mut rebuilt = Vec::with_capacity(info.len());

  rebuilt.extend_from_slice(&info[..INFO_FLAGS_AT]);
  rebuilt.extend_from_slice(&flags.to_le_bytes());

  for one in &strings {
    rebuilt.extend_from_slice(&(one.len() as u16).to_le_bytes());
  }

  for one in &strings {
    rebuilt.extend_from_slice(one);
    rebuilt.extend_from_slice(&[0, 0]);
  }

  rebuilt.extend_from_slice(&extra);

  let body = SECURITY_HEADER + rebuilt.len();
  let per = write_per_length(body);
  let total = MCS_HEAD_AT + parsed.head.len() + per.len() + body;
  let mut out = Vec::with_capacity(total);

  out.extend_from_slice(&[TPKT_VERSION, 0, (total >> 8) as u8, total as u8]);
  out.extend_from_slice(&X224_DATA);
  out.extend_from_slice(parsed.head);
  out.extend_from_slice(&per);
  out.extend_from_slice(parsed.security);
  out.extend_from_slice(&rebuilt);

  Some(out)
}
