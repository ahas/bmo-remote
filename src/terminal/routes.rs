//! The terminal sessions' routes: list, read, open, rename, end and a pasted picture kept (`docs/api.md`,
//! 「Terminal sessions」, 「Refusals」).

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use base64::Engine;
use base64::engine::general_purpose::STANDARD;

use axum::http::{Method, StatusCode};
use axum::response::{IntoResponse, Response};

use crate::http::{Call, Refused, Route, answer};
use crate::terminal::tmux::{self, RemoteTerminal};
use crate::wire::{
  Terminal, TerminalPage, TerminalPaste, TerminalPasted, TerminalRename, TerminalRequest, TerminalState,
  TerminalsQuery,
};

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

    // The pictures pasted into the session go with it; a folder that cannot be taken away ends nothing.
    let _ =
      tokio::fs::remove_dir_all(pastes_of(&call.standing().settings.terminal.pastes, &session.id)).await;

    Ok(StatusCode::NO_CONTENT.into_response())
  }
}

crate::route!(EndTerminal);

// The most a pasted picture may hold, and the most its body may: the picture in base64 and the words around it.
const PASTE_MAX: usize = 20 * 1024 * 1024;
const PASTE_BODY_MAX: usize = PASTE_MAX / 3 * 4 + 64 * 1024;

/// The ending a pasted picture's file takes, by its media type; none for a type that is no picture kept here.
pub fn paste_ending(media_type: &str) -> Option<&'static str> {
  match media_type.trim().to_ascii_lowercase().as_str() {
    "image/png" => Some("png"),
    "image/jpeg" => Some("jpg"),
    "image/gif" => Some("gif"),
    "image/webp" => Some("webp"),
    _ => None,
  }
}

/// The folder a session's pasted pictures are kept in.
pub fn pastes_of(pastes: &Path, id: &str) -> PathBuf {
  pastes.join(id)
}

/// A picture pasted into a session, kept as a file a program running there can open.
pub struct PasteTerminal;

impl Route for PasteTerminal {
  const METHOD: Method = Method::POST;
  const PATH: &'static str = "/terminals/{terminalId}/pastes";

  async fn answer(&self, mut call: Call) -> Result<Response, Refused> {
    let session = standing(&mut call).await?;
    let asked: TerminalPaste = call.body_within(PASTE_BODY_MAX).await?;
    let ending = paste_ending(&asked.media_type)
      .ok_or_else(|| Refused::bad_request(format!("{} is no picture a session keeps", asked.media_type)))?;
    let bytes = STANDARD
      .decode(asked.data.trim())
      .map_err(|why| Refused::bad_request(format!("the picture is not base64: {why}")))?;

    if bytes.is_empty() {
      return Err(Refused::bad_request("the picture holds nothing"));
    }

    if bytes.len() > PASTE_MAX {
      return Err(Refused::bad_request(format!("the picture holds more than {PASTE_MAX} bytes")));
    }

    let folder = pastes_of(&call.standing().settings.terminal.pastes, &session.id);
    let kept = |why: std::io::Error| Refused::failed(format!("the picture could not be kept: {why}"));

    tokio::fs::create_dir_all(&folder).await.map_err(kept)?;

    let moment = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |since| since.as_millis());
    let mut path = folder.join(format!("paste-{moment}.{ending}"));

    // Two pictures kept in the same millisecond are two files.
    for again in 1.. {
      if !tokio::fs::try_exists(&path).await.map_err(kept)? {
        break;
      }

      path = folder.join(format!("paste-{moment}-{again}.{ending}"));
    }

    tokio::fs::write(&path, &bytes).await.map_err(kept)?;

    Ok(answer(
      StatusCode::CREATED,
      TerminalPasted {
        path: path.to_string_lossy().into_owned(),
      },
    ))
  }
}

crate::route!(PasteTerminal);
