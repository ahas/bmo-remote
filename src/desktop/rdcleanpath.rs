//! RDCleanPath, the handshake IronRDP's web client expects from a websocket gateway (`docs/remote.md`,
//! 「The relay」): the browser's request read, and the response or the error it is answered with.

use ironrdp_rdcleanpath::{RDCleanPathErr, RDCleanPathPdu, VERSION_1};

pub use ironrdp_rdcleanpath::{GENERAL_ERROR_CODE, NEGOTIATION_ERROR_CODE};

// A request is a few hundred bytes; anything far larger is not one.
const MAX_PDU_BYTES: usize = 64 * 1024;

// The shortest X.224 connection request worth dialling with: its TPKT header.
const MIN_X224_BYTES: usize = 4;

/// A request that could not be read, or an answer that could not be written.
#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct CleanPathError(String);

/// What the browser's request carries.
#[derive(Debug)]
pub struct Request {
  /// The destination the browser names, which the relay reads and never dials.
  pub destination: Option<String>,
  /// The X.224 connection request the browser's client wrote.
  pub x224: Vec<u8>,
}

/// Reads the browser's first frame as its RDCleanPath request.
pub fn decode_request(bytes: &[u8]) -> Result<Request, CleanPathError> {
  if bytes.len() > MAX_PDU_BYTES {
    return Err(CleanPathError("request too large".to_owned()));
  }

  let pdu = RDCleanPathPdu::from_der(bytes).map_err(|why| CleanPathError(why.to_string()))?;

  if pdu.version != VERSION_1 {
    return Err(CleanPathError("unsupported version".to_owned()));
  }

  let x224 = pdu.x224_connection_pdu.map(|octets| octets.into_bytes()).unwrap_or_default();

  if x224.len() < MIN_X224_BYTES {
    return Err(CleanPathError("no X.224 connection request".to_owned()));
  }

  Ok(Request {
    destination: pdu.destination,
    x224,
  })
}

/// The answer once the desktop is reached: its X.224 confirm, its certificate chain and its address.
pub fn encode_response(
  x224: Vec<u8>,
  cert_chain: Vec<Vec<u8>>,
  server_addr: String,
) -> Result<Vec<u8>, CleanPathError> {
  RDCleanPathPdu::new_response(server_addr, x224, cert_chain)
    .and_then(|pdu| pdu.to_der())
    .map_err(|why| CleanPathError(why.to_string()))
}

/// An error before the answer, as the browser's client reads it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Failure {
  /// `GENERAL_ERROR_CODE` or `NEGOTIATION_ERROR_CODE`.
  pub code: u16,
  pub http_status: Option<u16>,
  pub wsa_error: Option<u16>,
  pub tls_alert: Option<u8>,
}

/// The error answer for a failure before the response.
pub fn encode_error(failure: Failure) -> Result<Vec<u8>, CleanPathError> {
  let pdu = RDCleanPathPdu {
    version: VERSION_1,
    error: Some(RDCleanPathErr {
      error_code: failure.code,
      http_status_code: failure.http_status,
      wsa_last_error: failure.wsa_error,
      tls_alert_code: failure.tls_alert,
    }),
    ..RDCleanPathPdu::default()
  };

  pdu.to_der().map_err(|why| CleanPathError(why.to_string()))
}
