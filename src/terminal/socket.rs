//! The terminal socket (`docs/remote.md`, 「The terminal socket」; `docs/api.md`, 「The terminal socket」): one
//! tmux attach client per viewer. The service sends the terminal's bytes as binary frames and control
//! messages as text; every frame from the browser is read as bytes, its first byte saying whether the rest is
//! typed input or a JSON control message.

use std::sync::Arc;

use axum::extract::FromRequestParts;
use axum::extract::ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade};
use axum::http::Method;
use axum::response::{IntoResponse, Response};
use serde_json::{Map, Number, Value, json};

use crate::http::{Call, Refused, Route, Standing};
use crate::terminal::pty::{self, Attach, Event};
use crate::terminal::tmux::is_terminal_id;

/// The first byte of a frame from the browser.
const FRAME_INPUT: u8 = 0;
const FRAME_CONTROL: u8 = 1;

/// Close codes in the range an application owns, and the normal one.
const CLOSE_NOT_FOUND: u16 = 4404;
const CLOSE_FAILED: u16 = 4500;
const CLOSE_NORMAL: u16 = 1000;

/// The code of an id no session has.
const NO_TERMINAL_SESSION: &str = "no-terminal-session";
/// The code of an attach client that could not start.
const ATTACH_FAILED_BECAUSE: &str = "attach-failed-because";
/// The code of an attach client that ended while its session stands.
const TERMINAL_DISCONNECTED: &str = "terminal-disconnected";

/// The size the browser asks for first, where its query names none.
const DEFAULT_COLS: f64 = 80.0;
const DEFAULT_ROWS: f64 = 24.0;

/// A value read as a number the way the screen's script reads one: a number as it is, a string by what it
/// spells (an empty one being zero), a boolean as one or zero, null as zero, and anything else as no number.
fn number_of(value: Option<&Value>) -> f64 {
  match value {
    Some(Value::Number(number)) => number.as_f64().unwrap_or(f64::NAN),
    Some(Value::String(text)) => {
      let text = text.trim();
      if text.is_empty() { 0.0 } else { text.parse().unwrap_or(f64::NAN) }
    }
    Some(Value::Bool(yes)) => f64::from(u8::from(*yes)),
    Some(Value::Null) => 0.0,
    _ => f64::NAN,
  }
}

/// A size from the query: what it spells, or `fallback` where that is no number or zero.
fn query_size(text: Option<String>, fallback: f64) -> f64 {
  let read = number_of(text.map(Value::String).as_ref());

  if read.is_nan() || read == 0.0 { fallback } else { read }
}

/// A number as JSON writes it: whole where it is whole.
fn json_number(value: f64) -> Value {
  if value.fract() == 0.0 && value.abs() < 9.0e15 {
    json!(value as i64)
  } else {
    Number::from_f64(value).map_or(Value::Null, Value::Number)
  }
}

/// The terminal socket of one session.
pub struct TerminalSocket;

impl Route for TerminalSocket {
  const METHOD: Method = Method::GET;
  const PATH: &'static str = "/terminals/{terminalId}/socket";

  async fn answer(&self, mut call: Call) -> Result<Response, Refused> {
    let id = call.path_param("terminalId").await?;
    let cols = query_size(call.query_value("cols"), DEFAULT_COLS);
    let rows = query_size(call.query_value("rows"), DEFAULT_ROWS);
    let standing = Arc::new(call.standing().clone());
    let (mut parts, _body) = call.request.into_parts();
    let upgrade = match WebSocketUpgrade::from_request_parts(&mut parts, &()).await {
      Ok(upgrade) => upgrade,
      Err(rejection) => return Ok(rejection.into_response()),
    };

    Ok(upgrade.on_upgrade(move |socket| view(socket, standing, id, cols, rows)))
  }
}

crate::route!(TerminalSocket);

/// Sends one control message.
async fn control(socket: &mut WebSocket, message: Value) {
  let _ = socket.send(Message::Text(message.to_string().into())).await;
}

/// Sends an `error` message with its code and English sentence, and `reason` where it names one.
async fn error(socket: &mut WebSocket, code: &str, message: &str, reason: Option<String>) {
  let mut body = Map::new();

  body.insert("type".into(), json!("error"));
  body.insert("code".into(), json!(code));
  body.insert("message".into(), json!(message));

  if let Some(reason) = reason {
    body.insert("reason".into(), json!(reason));
  }

  control(socket, Value::Object(body)).await;
}

async fn close(mut socket: WebSocket, code: u16, reason: &'static str) {
  let _ = socket
    .send(Message::Close(Some(CloseFrame {
      code,
      reason: reason.into(),
    })))
    .await;
}

/// One viewer, from the session looked up to the socket closed.
async fn view(mut socket: WebSocket, standing: Arc<Standing>, id: String, cols: f64, rows: f64) {
  let serial = PROBE_SERIAL.fetch_add(1, std::sync::atomic::Ordering::SeqCst);

  eprintln!("PROBE open {} {id} #{serial} {cols}x{rows}", probe_now());
  let found = if is_terminal_id(&id) { standing.tmux.find(&id).await } else { Ok(None) };
  let session = match found {
    Ok(Some(session)) => session,
    Ok(None) => {
      error(&mut socket, NO_TERMINAL_SESSION, "no terminal session has that id", None).await;
      return close(socket, CLOSE_NOT_FOUND, "no such session").await;
    }
    Err(why) => {
      let reason = Some(why.to_string());
      error(&mut socket, ATTACH_FAILED_BECAUSE, "the terminal could not be attached", reason).await;
      return close(socket, CLOSE_FAILED, "attach failed").await;
    }
  };
  let mut client = match pty::attach(standing.tmux.socket(), &session.id, cols, rows) {
    Ok(client) => client,
    Err(why) => {
      let reason = Some(why.to_string());
      error(&mut socket, ATTACH_FAILED_BECAUSE, "the terminal could not be attached", reason).await;
      return close(socket, CLOSE_FAILED, "attach failed").await;
    }
  };

  control(
    &mut socket,
    json!({ "type": "ready", "id": session.id, "cols": json_number(cols), "rows": json_number(rows) }),
  )
  .await;

  loop {
    tokio::select! {
      incoming = socket.recv() => match incoming {
        Some(Ok(Message::Binary(frame))) => { probe_frame(serial, &frame); read_frame(&client, &frame) }
        Some(Ok(Message::Text(frame))) => read_frame(&client, frame.as_bytes()),
        Some(Ok(Message::Ping(_) | Message::Pong(_))) => {}
        Some(Ok(Message::Close(_)) | Err(_)) | None => {
          eprintln!("PROBE close {} #{serial}", probe_now());
          client.close();
          return;
        }
      },
      event = client.events.recv() => match event {
        Some(Event::Output(bytes)) => {
          if socket.send(Message::Binary(bytes.into())).await.is_err() {
            client.close();
            return;
          }
        }
        Some(Event::Exited) | None => return ended(socket, &standing, &session.id).await,
      },
    }
  }
}

/// The client ended without the viewer letting go: the session was ended, or tmux let the client go for its
/// own reasons, and the viewer is told which.
async fn ended(mut socket: WebSocket, standing: &Standing, id: &str) {
  if matches!(standing.tmux.find(id).await, Ok(Some(_))) {
    error(&mut socket, TERMINAL_DISCONNECTED, "the terminal was disconnected", None).await;
    close(socket, CLOSE_FAILED, "client ended").await;
  } else {
    control(&mut socket, json!({ "type": "exit" })).await;
    close(socket, CLOSE_NORMAL, "session ended").await;
  }
}

/// One frame from the browser: typed bytes after a `0`, a control message after a `1`, and nothing else.
fn read_frame(client: &Attach, frame: &[u8]) {
  let Some((&kind, body)) = frame.split_first() else {
    return;
  };

  match kind {
    FRAME_INPUT if !body.is_empty() => client.write(body),
    FRAME_CONTROL => {
      let Ok(message) = serde_json::from_slice::<Value>(body) else {
        return;
      };

      if message.get("type").and_then(Value::as_str) == Some("resize") {
        client.resize(number_of(message.get("cols")), number_of(message.get("rows")));
      }
    }
    _ => {}
  }
}

// TEMPORARY PROBE: the shape of each input frame, control bytes in hex, escape sequences as they are and other
// printable runs counted, so the bytes a page sends on a reload can be read in the journal without what was typed.
static PROBE_SERIAL: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

fn probe_now() -> u128 {
  std::time::SystemTime::now()
    .duration_since(std::time::UNIX_EPOCH)
    .map(|d| d.as_millis())
    .unwrap_or(0)
}

fn probe_frame(serial: u64, frame: &[u8]) {
  match frame.split_first() {
    Some((&0, body)) => probe_input(serial, body),
    Some((&1, body)) => {
      eprintln!("PROBE control {} #{serial} {}", probe_now(), String::from_utf8_lossy(body))
    }
    _ => {}
  }
}

fn probe_input(serial: u64, body: &[u8]) {
  let mut shape = String::new();
  let mut run = 0usize;
  let mut at = 0;

  while at < body.len() {
    let byte = body[at];

    if byte == 0x1b {
      if run > 0 {
        shape.push_str(&format!("[{run}]"));
        run = 0;
      }

      shape.push_str("<1b>");
      at += 1;

      let start = at;

      while at < body.len() && at - start < 24 && (0x20..0x7f).contains(&body[at]) {
        let final_byte = at > start && (0x40..0x7f).contains(&body[at]);

        at += 1;

        if final_byte {
          break;
        }
      }

      shape.push_str(&String::from_utf8_lossy(&body[start..at]));
      continue;
    }

    if (0x20..0x7f).contains(&byte) || byte >= 0x80 {
      run += 1;
    } else {
      if run > 0 {
        shape.push_str(&format!("[{run}]"));
        run = 0;
      }

      shape.push_str(&format!("<{byte:02x}>"));
    }

    at += 1;
  }

  if run > 0 {
    shape.push_str(&format!("[{run}]"));
  }

  eprintln!("PROBE input {} #{serial} {shape}", probe_now());
}
