//! The service's own client (`docs/api.md`, 「The client」): one method for each route that answers JSON,
//! sending and reading the types of `wire`, with the reader's role where it is given one. The command reaches
//! the service through it, and so may any other Rust caller.

use std::time::Duration;

use reqwest::{Method, RequestBuilder, Response};
use serde::Serialize;
use serde::de::DeserializeOwned;

use crate::console::{ConsoleRole, OWNER_ROLE_HEADER};
use crate::settings::Settings;
use crate::wire::{
  Account, ConsoleManifest, Health, Terminal, TerminalPage, TerminalRename, TerminalRequest,
  TerminalsQuery, WireError,
};

/// Why a call reached no answer of the route's shape.
#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum ClientFailure {
  /// Nothing answered: the service is not where it was looked for, or did not answer in time.
  #[error("the service did not answer: {0}")]
  Unreached(String),
  /// The service refused, in its error shape where it answered in one.
  #[error("the service answered {status}: {}", answer.as_ref().map_or(body.as_str(), |answer| answer.error.as_str()))]
  Answered {
    status: u16,
    answer: Option<WireError>,
    body: String,
  },
  /// The service answered, but not in the route's shape.
  #[error("the service's answer could not be read: {0}")]
  Unread(String),
}

impl ClientFailure {
  /// The code the service refused with, where it refused in its error shape.
  pub fn code(&self) -> Option<&str> {
    match self {
      Self::Answered {
        answer: Some(answer),
        ..
      } => Some(&answer.code),
      _ => None,
    }
  }
}

/// The service at one address, asked with one token.
#[derive(Clone, Debug)]
pub struct RemoteClient {
  address: String,
  token: String,
  http: reqwest::Client,
  timeout: Option<Duration>,
  /// The role sent as `Owner-Role`, which every route the screen uses asks for.
  role: Option<ConsoleRole>,
}

impl RemoteClient {
  /// The service at `address`, its base, asked with `token`.
  pub fn new(address: impl Into<String>, token: impl Into<String>) -> Self {
    Self {
      address: address.into().trim_end_matches('/').to_owned(),
      token: token.into(),
      http: reqwest::Client::new(),
      timeout: None,
      role: None,
    }
  }

  /// The service the settings name, on this machine, with the settings' token.
  pub fn of_settings(settings: &Settings) -> Self {
    Self::new(format!("http://{}", settings.server.listen), settings.server.token.clone())
  }

  /// The client giving up on any call that has not answered within `timeout`.
  pub fn with_timeout(mut self, timeout: Duration) -> Self {
    self.timeout = Some(timeout);
    self
  }

  /// The client asking for a reader holding `role`, as the console hands a reader's calls on.
  pub fn with_role(mut self, role: ConsoleRole) -> Self {
    self.role = Some(role);
    self
  }

  fn request(&self, method: Method, path: &str) -> RequestBuilder {
    let request = self.http.request(method, format!("{}{path}", self.address)).bearer_auth(&self.token);
    let request = match self.role {
      Some(role) => request.header(OWNER_ROLE_HEADER, role.name()),
      None => request,
    };

    match self.timeout {
      Some(timeout) => request.timeout(timeout),
      None => request,
    }
  }

  /// A request sent, its answer refused where its status is no success.
  async fn sent(request: RequestBuilder) -> Result<Response, ClientFailure> {
    let response = request.send().await.map_err(|why| ClientFailure::Unreached(why.to_string()))?;
    let status = response.status();

    if status.is_success() {
      return Ok(response);
    }

    let body = response.text().await.unwrap_or_default();

    Err(ClientFailure::Answered {
      status: status.as_u16(),
      answer: serde_json::from_str(&body).ok(),
      body,
    })
  }

  /// A request sent and its answer read as `T`.
  async fn read<T: DeserializeOwned>(request: RequestBuilder) -> Result<T, ClientFailure> {
    Self::sent(request)
      .await?
      .json()
      .await
      .map_err(|why| ClientFailure::Unread(why.to_string()))
  }

  fn with_query(request: RequestBuilder, query: &impl Serialize) -> RequestBuilder {
    request.query(query)
  }

  /// `GET /health`.
  pub async fn health(&self) -> Result<Health, ClientFailure> {
    Self::read(self.request(Method::GET, "/health")).await
  }

  /// `GET /console-manifest`.
  pub async fn console_manifest(&self) -> Result<ConsoleManifest, ClientFailure> {
    Self::read(self.request(Method::GET, "/console-manifest")).await
  }

  /// `GET /console/words.json`: each locale's tree under its code.
  pub async fn console_words(&self) -> Result<serde_json::Map<String, serde_json::Value>, ClientFailure> {
    Self::read(self.request(Method::GET, "/console/words.json")).await
  }

  /// `GET /account`.
  pub async fn account(&self) -> Result<Account, ClientFailure> {
    Self::read(self.request(Method::GET, "/account")).await
  }

  /// `GET /terminals`.
  pub async fn terminals(&self, query: &TerminalsQuery) -> Result<TerminalPage, ClientFailure> {
    Self::read(Self::with_query(self.request(Method::GET, "/terminals"), query)).await
  }

  /// `GET /terminals/{terminalId}`.
  pub async fn terminal(&self, terminal_id: &str) -> Result<Terminal, ClientFailure> {
    Self::read(self.request(Method::GET, &format!("/terminals/{terminal_id}"))).await
  }

  /// `POST /terminals`: the session opened.
  pub async fn open_terminal(&self, asked: &TerminalRequest) -> Result<Terminal, ClientFailure> {
    Self::read(self.request(Method::POST, "/terminals").json(asked)).await
  }

  /// `PATCH /terminals/{terminalId}`: the session renamed.
  pub async fn rename_terminal(
    &self,
    terminal_id: &str,
    rename: &TerminalRename,
  ) -> Result<Terminal, ClientFailure> {
    Self::read(self.request(Method::PATCH, &format!("/terminals/{terminal_id}")).json(rename)).await
  }

  /// `DELETE /terminals/{terminalId}`: the session and every program in it ended.
  pub async fn end_terminal(&self, terminal_id: &str) -> Result<(), ClientFailure> {
    Self::sent(self.request(Method::DELETE, &format!("/terminals/{terminal_id}")))
      .await
      .map(drop)
  }
}
