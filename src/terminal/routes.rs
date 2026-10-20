//! The terminal sessions' routes: list, read, open, rename and end (`docs/api.md`, 「Terminal sessions」,
//! 「Refusals」).

use axum::http::{Method, StatusCode};
use axum::response::{IntoResponse, Response};

use crate::http::{Call, Refused, Route, answer};
use crate::terminal::tmux::{self, RemoteTerminal};
use crate::wire::{Terminal, TerminalPage, TerminalRename, TerminalRequest, TerminalState, TerminalsQuery};

// How many sessions a page holds where the query names no limit, and the most it may ask for.
const PAGE: u64 = 100;
const PAGE_MAX: u64 = 1000;

/// The wire's shape of a session tmux holds.
fn answered(session: RemoteTerminal) -> Terminal {
  Terminal {
    id: session.id,
    title: session.title,
    state: TerminalState::Running,
    created_at: session.created_at,
  }
}

fn no_session(id: &str) -> Refused {
  Refused::not_found(format!("no terminal session is named {id}"))
}

/// The session `terminalId` names, where it stands.
async fn standing(call: &mut Call) -> Result<RemoteTerminal, Refused> {
  let id = call.path_param("terminalId").await?;

  if !tmux::is_terminal_id(&id) {
    return Err(no_session(&id));
  }

  call
    .standing()
    .tmux
    .find(&id)
    .await
    .map_err(|why| Refused::failed(format!("the terminal session could not be read: {why}")))?
    .ok_or_else(|| no_session(&id))
}

/// A page of the sessions on the service's socket, in the order they began.
pub struct ListTerminals;

impl Route for ListTerminals {
  const METHOD: Method = Method::GET;
  const PATH: &'static str = "/terminals";

  async fn answer(&self, call: Call) -> Result<Response, Refused> {
    let query: TerminalsQuery = call.query()?;
    let after = query.after.unwrap_or(0) as usize;
    let limit = query.limit.unwrap_or(PAGE).clamp(1, PAGE_MAX) as usize;
    let sessions = call
      .standing()
      .tmux
      .list()
      .await
      .map_err(|why| Refused::failed(format!("the terminal sessions could not be read: {why}")))?;
    let mut items: Vec<Terminal> = sessions.into_iter().skip(after).take(limit + 1).map(answered).collect();
    let more = items.len() > limit;

    items.truncate(limit);

    Ok(answer(StatusCode::OK, TerminalPage { items, more }))
  }
}

crate::route!(ListTerminals);

/// A new session: the account's login shell in a tmux session of its own.
pub struct CreateTerminal;

impl Route for CreateTerminal {
  const METHOD: Method = Method::POST;
  const PATH: &'static str = "/terminals";

  async fn answer(&self, mut call: Call) -> Result<Response, Refused> {
    let asked: TerminalRequest = call.body().await?;
    let session = call
      .standing()
      .tmux
      .create(asked.title.as_deref())
      .await
      .map_err(|why| Refused::failed(format!("the terminal session could not be opened: {why}")))?;

    Ok(answer(StatusCode::CREATED, answered(session)))
  }
}

crate::route!(CreateTerminal);

/// One session.
pub struct ReadTerminal;

impl Route for ReadTerminal {
  const METHOD: Method = Method::GET;
  const PATH: &'static str = "/terminals/{terminalId}";

  async fn answer(&self, mut call: Call) -> Result<Response, Refused> {
    let session = standing(&mut call).await?;

    Ok(answer(StatusCode::OK, answered(session)))
  }
}

crate::route!(ReadTerminal);

/// A session renamed; an empty title takes the name away.
pub struct RenameTerminal;

impl Route for RenameTerminal {
  const METHOD: Method = Method::PATCH;
  const PATH: &'static str = "/terminals/{terminalId}";

  async fn answer(&self, mut call: Call) -> Result<Response, Refused> {
    let session = standing(&mut call).await?;
    let asked: TerminalRename = call.body().await?;
    let renamed = call
      .standing()
      .tmux
      .rename(&session.id, &asked.title)
      .await
      .map_err(|why| Refused::failed(format!("the terminal session could not be renamed: {why}")))?
      .ok_or_else(|| no_session(&session.id))?;

    Ok(answer(StatusCode::OK, answered(renamed)))
  }
}

crate::route!(RenameTerminal);

/// A session ended, with every program running in it.
pub struct EndTerminal;

impl Route for EndTerminal {
  const METHOD: Method = Method::DELETE;
  const PATH: &'static str = "/terminals/{terminalId}";

  async fn answer(&self, mut call: Call) -> Result<Response, Refused> {
    let session = standing(&mut call).await?;

    if !call
      .standing()
      .tmux
      .end(&session.id)
      .await
      .map_err(|why| Refused::failed(format!("the terminal session could not be ended: {why}")))?
    {
      return Err(no_session(&session.id));
    }

    Ok(StatusCode::NO_CONTENT.into_response())
  }
}

crate::route!(EndTerminal);
