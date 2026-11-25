//! Whether the service is up (`docs/api.md`, 「Health」): the route, and the command that asks it.

use axum::http::{Method, StatusCode};
use axum::response::Response;

use crate::client::RemoteClient;
use crate::http::{Call, Reader, Refused, Route, answer};
use crate::settings::Settings;
use crate::wire::Health as HealthAnswer;

/// Whether the store is open and the service answers, to any caller with the token. A service that answers
/// has its store: it opens it before it answers anything.
pub struct Health;

impl Route for Health {
  const METHOD: Method = Method::GET;
  const PATH: &'static str = "/health";
  const READER: Reader = Reader::Caller;

  async fn answer(&self, _call: Call) -> Result<Response, Refused> {
    Ok(answer(
      StatusCode::OK,
      HealthAnswer {
        ready: true,
        reason: None,
        version: crate::VERSION.to_owned(),
      },
    ))
  }
}

crate::route!(Health);

/// Whether the service the settings name answers ready, asked once and waited on until it answers or the
/// connection ends.
pub async fn ask(settings: &Settings) -> Result<(), String> {
  let asked = RemoteClient::of_settings(settings)
    .health()
    .await
    .map_err(|why| format!("the service at {} did not answer: {why}", settings.server.listen))?;

  if asked.ready {
    Ok(())
  } else {
    Err(asked.reason.unwrap_or_else(|| "the service is not ready".to_owned()))
  }
}
