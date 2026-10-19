//! Network-level authentication as a client (`docs/remote.md`, 「Network-level authentication」): CredSSP
//! carrying NTLMv2, which gnome-remote-desktop requires before anything else of RDP. The relay runs it toward
//! the desktop with the kept password, over the TLS connection, so the browser, which never holds that
//! password, is told the connection is plain TLS.
//!
//! The exchange is three TSRequests from the relay: the NTLM negotiate; the authenticate with the server's
//! public key bound to a nonce of the relay's own; and, once the server has bound the same key back, the
//! credentials. The caller carries the bytes; this module only says what to send for what came.

use der::{Decode as _, Encode as _, Header, SliceReader};
use sspi::credssp::{ClientMode, ClientState, CredSspClient, CredSspMode, TsRequest};
use sspi::ntlm::NtlmConfig;
use sspi::{AuthIdentity, Credentials as SspiCredentials, Username};
use x509_cert::Certificate;

/// The account the relay authenticates as.
#[derive(Clone, Debug)]
pub struct Credentials {
  pub username: String,
  pub password: String,
  pub domain: Option<String>,
}

/// Why the exchange ended before it was done.
#[derive(Debug, thiserror::Error)]
pub enum NlaError {
  /// The server answered with an error code: it refused the credentials.
  #[error("server refused: 0x{0:08x}")]
  Refused(u32),
  /// The exchange itself went wrong.
  #[error("{0}")]
  Failed(String),
}

impl NlaError {
  /// Whether the server refused the credentials, rather than the exchange going wrong.
  pub fn refused(&self) -> bool {
    matches!(self, Self::Refused(_))
  }
}

fn failed(why: impl ToString) -> NlaError {
  NlaError::Failed(why.to_string())
}

/// The public key CredSSP binds: the subjectPublicKey of the server's certificate, the BIT STRING's content
/// without its unused-bits byte.
pub fn server_public_key(certificate: &[u8]) -> Result<Vec<u8>, NlaError> {
  let certificate = Certificate::from_der(certificate).map_err(failed)?;

  Ok(
    certificate
      .tbs_certificate
      .subject_public_key_info
      .subject_public_key
      .raw_bytes()
      .to_vec(),
  )
}

/// The length of one whole TSRequest at the front of a stream, or none while its header is incomplete.
pub fn message_length(bytes: &[u8]) -> Result<Option<usize>, NlaError> {
  let mut reader = SliceReader::new(bytes).map_err(failed)?;
  let header = match Header::decode(&mut reader) {
    Ok(header) => header,
    Err(why) if matches!(why.kind(), der::ErrorKind::Incomplete { .. }) => return Ok(None),
    Err(why) => return Err(failed(why)),
  };
  let head = header.encoded_len().and_then(usize::try_from).map_err(failed)?;
  let body = usize::try_from(header.length).map_err(failed)?;

  Ok(Some(head + body))
}

/// What to send for what the server sent, and whether it was the last.
pub struct Step {
  pub send: Vec<u8>,
  pub done: bool,
}

/// The client's side of CredSSP toward one server.
pub struct NlaClient {
  client: CredSspClient,
}

impl NlaClient {
  /// A client for the server at `host`, whose certificate carried `server_public_key`.
  pub fn new(credentials: &Credentials, server_public_key: Vec<u8>, host: &str) -> Result<Self, NlaError> {
    let username = Username::new(&credentials.username, credentials.domain.as_deref()).map_err(failed)?;
    let identity = AuthIdentity {
      username,
      password: credentials.password.clone().into(),
    };
    let client = CredSspClient::new(
      server_public_key,
      SspiCredentials::AuthIdentity(identity),
      CredSspMode::WithCredentials,
      ClientMode::Ntlm(NtlmConfig::default()),
      format!("TERMSRV/{host}"),
    )
    .map_err(failed)?;

    Ok(Self { client })
  }

  /// What to send first: the NTLM negotiate.
  pub fn start(&mut self) -> Result<Vec<u8>, NlaError> {
    self.answer(TsRequest::default()).map(|step| step.send)
  }

  /// What to send for the server's next TSRequest, and whether that was the last.
  pub fn next(&mut self, received: &[u8]) -> Result<Step, NlaError> {
    let request = TsRequest::from_buffer(received).map_err(failed)?;

    if let Some(code) = request.error_code {
      return Err(NlaError::Refused(code.0));
    }

    self.answer(request)
  }

  fn answer(&mut self, request: TsRequest) -> Result<Step, NlaError> {
    let (reply, done) = match self.client.process(request).resolve_to_result().map_err(failed)? {
      ClientState::ReplyNeeded(reply) => (reply, false),
      ClientState::FinalMessage(reply) => (reply, true),
    };
    let mut send = Vec::new();

    reply.encode_ts_request(&mut send).map_err(failed)?;

    Ok(Step { send, done })
  }
}
