//! The X.224 connection request and confirm as the relay rewrites them (`docs/remote.md`, 「The relay」):
//! the security protocols asked for, the routing token a redirected connection must carry, and the protocol
//! the browser is told was chosen.
//!
//! A request is TPKT (4) and the X.224 header (7), then an optional cookie or routing token ending in CR LF,
//! then an optional RDP_NEG_REQ (type 1, flags, length 8, requestedProtocols) and, where its flags say so, 36
//! bytes of correlation info. A confirm is the same header with an RDP_NEG_RSP (type 2) or an
//! RDP_NEG_FAILURE (type 3) after it.
//!
//! The request is cut and written again by hand rather than decoded with `ironrdp-pdu`: its decoder keeps the
//! routing token as text and has no place for the correlation info, so encoding what it read would not keep
//! the browser's own bytes.

pub use ironrdp_pdu::nego::SecurityProtocol;

const HEADER: usize = 11;
const NEG_REQ: u8 = 1;
const NEG_RSP: u8 = 2;
const NEG_LENGTH: usize = 8;
const CR_LF: [u8; 2] = [0x0d, 0x0a];
const TPKT_VERSION: u8 = 3;
const X224_CONNECTION_REQUEST: u8 = 0xe0;

/// A connection request cut into the parts the relay rewrites.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConnectionRequest {
  /// The cookie or routing token, CR LF included, as it stood.
  pub token: Vec<u8>,
  /// The protocols asked for, or none where the request carries no negotiation.
  pub protocols: Option<SecurityProtocol>,
  pub flags: u8,
  /// What followed the negotiation, the correlation info.
  pub rest: Vec<u8>,
}

/// The request cut into its parts, or none where the bytes are not one.
pub fn read_connection_request(bytes: &[u8]) -> Option<ConnectionRequest> {
  if bytes.len() < HEADER || bytes[0] != TPKT_VERSION || bytes[5] != X224_CONNECTION_REQUEST {
    return None;
  }

  let mut at = HEADER;
  let mut token = Vec::new();

  // A cookie and a routing token are both text ending in CR LF.
  if bytes.len() - at >= 2 && bytes[at] != NEG_REQ {
    let end = bytes[at..].windows(2).position(|pair| pair == CR_LF)? + at + 2;

    token = bytes[at..end].to_vec();
    at = end;
  }

  if bytes.len() - at < NEG_LENGTH || bytes[at] != NEG_REQ {
    return Some(ConnectionRequest {
      token,
      protocols: None,
      flags: 0,
      rest: bytes[at..].to_vec(),
    });
  }

  let protocols = u32::from_le_bytes([bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]]);

  Some(ConnectionRequest {
    token,
    protocols: Some(SecurityProtocol::from_bits_retain(protocols)),
    flags: bytes[at + 1],
    rest: bytes[at + NEG_LENGTH..].to_vec(),
  })
}

/// The request written out again over the original's header, with its lengths.
pub fn write_connection_request(original: &[u8], request: &ConnectionRequest) -> Vec<u8> {
  let mut negotiation = Vec::new();

  if let Some(protocols) = request.protocols {
    negotiation.push(NEG_REQ);
    negotiation.push(request.flags);
    negotiation.extend_from_slice(&(NEG_LENGTH as u16).to_le_bytes());
    negotiation.extend_from_slice(&protocols.bits().to_le_bytes());
  }

  let length = HEADER + request.token.len() + negotiation.len() + request.rest.len();
  let mut out = Vec::with_capacity(length);

  out.extend_from_slice(&original[..HEADER]);
  out[2..4].copy_from_slice(&(length as u16).to_be_bytes());
  // The X.224 length indicator counts the header after itself.
  out[4] = (length - 5) as u8;
  out.extend_from_slice(&request.token);
  out.extend_from_slice(&negotiation);
  out.extend_from_slice(&request.rest);

  out
}

/// A routing token as the request carries it: the redirection's load-balance info, ending in CR LF.
pub fn routing_token(load_balance_info: &[u8]) -> Vec<u8> {
  let mut out = load_balance_info.to_vec();

  if !load_balance_info.ends_with(&CR_LF) {
    out.extend_from_slice(&CR_LF);
  }

  out
}

/// The protocol a confirm says the server chose, or none where it chose none (a failure, or an old server
/// that negotiates nothing).
pub fn selected_protocol(confirm: &[u8]) -> Option<SecurityProtocol> {
  if confirm.len() < HEADER + NEG_LENGTH || confirm[HEADER] != NEG_RSP {
    return None;
  }

  let at = HEADER + 4;
  let chosen = u32::from_le_bytes([confirm[at], confirm[at + 1], confirm[at + 2], confirm[at + 3]]);

  Some(SecurityProtocol::from_bits_retain(chosen))
}

/// The confirm with another protocol said to be chosen, in a copy.
pub fn with_selected_protocol(confirm: &[u8], protocol: SecurityProtocol) -> Vec<u8> {
  let mut out = confirm.to_vec();

  if selected_protocol(&out).is_some() {
    out[HEADER + 4..HEADER + 8].copy_from_slice(&protocol.bits().to_le_bytes());
  }

  out
}
