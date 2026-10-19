//! What the relay rewrites in the client's first frames after the handshake (`docs/remote.md`,
//! 「Network-level authentication」): the client core data block (TS_UD_CS_CORE) of the MCS Connect Initial
//! the browser sends first.
//!
//! The block is found and its field rewritten where it stands, by hand: decoding the Connect Initial with
//! `ironrdp-pdu` and encoding it again would not keep every other byte the browser wrote.

use crate::desktop::negotiation::SecurityProtocol;

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
