//! The terminal sessions' routes: list, create, rename and end (`docs/api.md`, 「Terminal sessions」,
//! 「Refusals」).

use axum::http::{Method, StatusCode};
use axum::response::Response;
use serde_json::{Value, json};

use crate::http::{Call, Refused, Route, answer};
use crate::terminal::tmux::is_terminal_id;

/// The code of a `label` sent to a new session that is not a string.
const TERMINAL_NAME_TEXT: &str = "terminal_name_text";
/// The code of a rename that sent no `label` string.
const RENAME_TEXT: &str = "rename_text";
/// The code of an id that is not a session id's shape.
const BAD_TERMINAL_ID: &str = "bad_terminal_id";
/// The code of an id no session has.
pub const NO_TERMINAL_SESSION: &str = "no_terminal_session";
/// The code of tmux not answering for its sessions.
const TERMINALS_FAILED_BECAUSE: &str = "terminals_failed_because";
/// The code of a session that could not be started.
const OPEN_FAILED_BECAUSE: &str = "open_failed_because";

fn no_session(id: &str) -> Refused {
  Refused::new(StatusCode::NOT_FOUND, NO_TERMINAL_SESSION, format!("no terminal session is named {id}"))
}

/// The `id` the route's path names, where it has a session id's shape.
async fn session_id(call: &mut Call) -> Result<String, Refused> {
  let id = call.path_params().await?.remove("id").unwrap_or_default();

  if !is_terminal_id(&id) {
    return Err(Refused::new(
      StatusCode::BAD_REQUEST,
      BAD_TERMINAL_ID,
      "the id is not a terminal session id",
    ));
  }

  Ok(id)
}

/// Every session on the service's socket.
pub struct ListTerminals;

impl Route for ListTerminals {
  const METHOD: Method = Method::GET;
  const PATH: &'static str = "/api/remote/terminals";

  async fn answer(&self, call: Call) -> Result<Response, Refused> {
    let terminals = call.standing().tmux.list().await.map_err(|why| {
      Refused::new(
        StatusCode::INTERNAL_SERVER_ERROR,
        TERMINALS_FAILED_BECAUSE,
        "the terminal sessions could not be read",
      )
      .with("reason", why.to_string())
    })?;

    Ok(answer(StatusCode::OK, json!({ "terminals": terminals })))
  }
}

crate::route!(ListTerminals);

/// A new session: the account's login shell in a tmux session of its own.
pub struct CreateTerminal;

impl Route for CreateTerminal {
  const METHOD: Method = Method::POST;
  const PATH: &'static str = "/api/remote/terminals";

  async fn answer(&self, mut call: Call) -> Result<Response, Refused> {
    let body = call.body().await;
    let label = match body.as_ref().and_then(|body| body.get("label")) {
      None => None,
      Some(Value::String(label)) => Some(label.as_str()),
      Some(_) => {
        return Err(Refused::new(StatusCode::BAD_REQUEST, TERMINAL_NAME_TEXT, "the label is not text"));
      }
    };
    let terminal = call.standing().tmux.create(label).await.map_err(|why| {
      Refused::new(
        StatusCode::INTERNAL_SERVER_ERROR,
        OPEN_FAILED_BECAUSE,
        "the terminal session could not be opened",
      )
      .with("reason", why.to_string())
    })?;

    Ok(answer(StatusCode::OK, json!({ "terminal": terminal })))
  }
}

crate::route!(CreateTerminal);

/// A session renamed; an empty name takes the name away.
pub struct RenameTerminal;

impl Route for RenameTerminal {
  const METHOD: Method = Method::PATCH;
  const PATH: &'static str = "/api/remote/terminals/{id}";

  async fn answer(&self, mut call: Call) -> Result<Response, Refused> {
    let id = session_id(&mut call).await?;
    let body = call.body().await;
    let Some(Value::String(label)) = body.as_ref().and_then(|body| body.get("label")) else {
      return Err(Refused::new(StatusCode::BAD_REQUEST, RENAME_TEXT, "the rename sent no label text"));
    };
    let terminal = call
      .standing()
      .tmux
      .rename(&id, label)
      .await
      .map_err(Refused::failed)?
      .ok_or_else(|| no_session(&id))?;

    Ok(answer(StatusCode::OK, json!({ "terminal": terminal })))
  }
}

crate::route!(RenameTerminal);

/// A session ended, with every program running in it.
pub struct EndTerminal;

impl Route for EndTerminal {
  const METHOD: Method = Method::DELETE;
  const PATH: &'static str = "/api/remote/terminals/{id}";

  async fn answer(&self, mut call: Call) -> Result<Response, Refused> {
    let id = session_id(&mut call).await?;

    if !call.standing().tmux.end(&id).await.map_err(Refused::failed)? {
      return Err(no_session(&id));
    }

    Ok(answer(StatusCode::OK, json!({ "ended": true })))
  }
}

crate::route!(EndTerminal);
