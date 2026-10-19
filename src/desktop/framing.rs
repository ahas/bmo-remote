//! The two streams cut into their PDUs (`docs/remote.md`, 「The relay」). The relay reads what the server
//! sends only to find the pointer's shapes and a redirection, and both are read one whole PDU at a time:
//! slow-path ones in TPKT framing, and fast-path ones. A PDU is held until it is whole, and a stream this
//! cannot frame is passed on untouched from then on. The client's stream is only counted, for where the
//! relay may type into it.

use ironrdp_pdu::fast_path::{EncryptionFlags, FastPathHeader, FastPathUpdatePdu};
use ironrdp_pdu::rdp::headers::CompressionFlags;
use ironrdp_pdu::tpkt::TpktHeader;
use ironrdp_pdu::{Action, Decode, PduInfo, ReadCursor, find_size};

// The shortest TPKT packet that frames anything: its header and an X.224 one.
const MIN_TPKT_LENGTH: usize = 7;
// A fast-path length's top bit says it takes two bytes.
const FASTPATH_LONG_LENGTH: u8 = 0x80;

// The action bits of a PDU's first byte, both set for slow-path.
const ACTION_MASK: u8 = 0x03;

/// A stream that is neither framing, or a TPKT packet that is not one.
#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct FramingError(&'static str);

/// The whole length of the TPKT packet at the front of a stream once all of it is there, or none while it
/// is incomplete.
pub fn tpkt_length(bytes: &[u8]) -> Result<Option<usize>, FramingError> {
  if bytes.len() < TpktHeader::SIZE {
    return Ok(None);
  }

  let header =
    TpktHeader::read(&mut ReadCursor::new(bytes)).map_err(|_| FramingError("not a TPKT packet"))?;
  let length = header.packet_length();

  if length < MIN_TPKT_LENGTH {
    return Err(FramingError("bad TPKT length"));
  }

  Ok((bytes.len() >= length).then_some(length))
}

// The PDU at the front of a stream, or none while its header is incomplete. A first byte with both action
// bits set is the TPKT version or no PDU at all, which is known from that byte alone, before the TPKT header
// the crate waits for.
fn find_pdu(bytes: &[u8]) -> Result<Option<PduInfo>, FramingError> {
  if bytes
    .first()
    .is_some_and(|&first| first & ACTION_MASK == ACTION_MASK && first != TpktHeader::VERSION)
  {
    return Err(FramingError("not a PDU"));
  }

  find_size(bytes).map_err(|_| FramingError("not a PDU"))
}

/// The whole length of the PDU at the front of a stream, or none while its header is incomplete.
pub fn pdu_length(bytes: &[u8]) -> Result<Option<usize>, FramingError> {
  let Some(info) = find_pdu(bytes)? else {
    return Ok(None);
  };

  // A length shorter than the header that states it frames nothing, and the stream never moves on.
  let shortest = match info.action {
    Action::X224 => MIN_TPKT_LENGTH,
    Action::FastPath if bytes[1] & FASTPATH_LONG_LENGTH != 0 => 3,
    Action::FastPath => 2,
  };

  if info.length < shortest {
    return Err(FramingError(match info.action {
      Action::X224 => "bad TPKT length",
      Action::FastPath => "bad fast-path length",
    }));
  }

  Ok(Some(info.length))
}

/// One update of a fast-path PDU as the relay reads it.
pub struct FastPathUpdate<'a> {
  pub update: FastPathUpdatePdu<'a>,
  /// Whether its data is bulk-compressed, and so not readable here.
  pub compressed: bool,
}

/// The updates of a fast-path PDU, as views into it; none when the PDU cannot be read as clear text.
pub fn fast_path_updates(pdu: &[u8]) -> Option<Vec<FastPathUpdate<'_>>> {
  let mut cursor = ReadCursor::new(pdu);
  let header = FastPathHeader::decode(&mut cursor).ok()?;

  if header.flags.contains(EncryptionFlags::ENCRYPTED) {
    return None;
  }

  let mut updates = Vec::new();

  while !cursor.is_empty() {
    let update = FastPathUpdatePdu::decode(&mut cursor).ok()?;
    let compressed = update
      .compression_flags
      .is_some_and(|flags| flags.contains(CompressionFlags::COMPRESSED));

    updates.push(FastPathUpdate { update, compressed });
  }

  Some(updates)
}

/// What the server sends, cut into its PDUs.
#[derive(Default)]
pub struct ServerFraming {
  pending: Vec<u8>,
  passthrough: bool,
}

impl ServerFraming {
  /// Takes what the server sent; gives back the PDUs it completed, in order. A stream that cannot be framed
  /// is given back as it came.
  pub fn push(&mut self, chunk: &[u8]) -> Vec<Vec<u8>> {
    if self.passthrough {
      return vec![chunk.to_vec()];
    }

    self.pending.extend_from_slice(chunk);

    let mut out = Vec::new();
    let mut at = 0;

    loop {
      let rest = &self.pending[at..];

      match pdu_length(rest) {
        Err(_) => {
          self.passthrough = true;
          out.push(rest.to_vec());
          self.pending.clear();

          return out;
        }
        Ok(Some(length)) if rest.len() >= length => {
          out.push(rest[..length].to_vec());
          at += length;
        }
        Ok(_) => break,
      }
    }

    self.pending.drain(..at);

    out
  }

  /// What is still held, when the stream ends.
  pub fn flush(&mut self) -> Vec<Vec<u8>> {
    if self.pending.is_empty() {
      return Vec::new();
    }

    vec![std::mem::take(&mut self.pending)]
  }
}

/// Counts where the client's own PDUs end, so what the relay types never lands inside one of them
/// (`docs/remote.md`, 「The on-screen keyboard」).
#[derive(Default)]
pub struct ClientFraming {
  left: usize,
  head: Vec<u8>,
  lost: bool,
}

impl ClientFraming {
  /// Reads a chunk the client sent; answers whether the stream now stands between two PDUs.
  pub fn push(&mut self, chunk: &[u8]) -> bool {
    if self.lost {
      return false;
    }

    let mut at = 0;

    while at < chunk.len() {
      if self.left > 0 {
        let taken = self.left.min(chunk.len() - at);

        self.left -= taken;
        at += taken;
        continue;
      }

      self.head.push(chunk[at]);
      at += 1;

      // A head that is no PDU's frames nothing, and loses the count.
      let length = match find_pdu(&self.head) {
        Ok(None) => continue,
        Ok(Some(info)) => info.length,
        Err(_) => 0,
      };

      if length < self.head.len() {
        self.lost = true;

        return false;
      }

      self.left = length - self.head.len();
      self.head.clear();
    }

    self.between()
  }

  /// Whether the stream stands between two PDUs, where something typed may go in.
  pub fn between(&self) -> bool {
    !self.lost && self.left == 0 && self.head.is_empty()
  }

  /// Whether the count was lost, so nothing may be typed into the stream any more.
  pub fn lost(&self) -> bool {
    self.lost
  }
}
