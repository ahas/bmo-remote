//! The desktop sidecar (`docs/api.md`, 「The desktop sidecar」): the bun process of this repository's own that
//! answers the desktop's three sockets, kept running beside the service, and the sockets that take the
//! browser's upgrades behind the token and hand them on to it frame for frame.

use std::net::SocketAddr;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use axum::extract::FromRequestParts;
use axum::extract::ws::{self, WebSocket, WebSocketUpgrade};
use axum::http::{HeaderValue, Method, header};
use axum::response::{IntoResponse, Response};
use futures_util::{SinkExt, StreamExt};
use tokio::net::TcpStream;
use tokio::process::Command;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_tungstenite::tungstenite::{self, Message};
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

use crate::account::Account;
use crate::http::{Call, Refused, Route};
use crate::settings::Settings;

/// What every environment variable the service's own settings are read from begins with; none of them is
/// handed to the sidecar, which is given only what it reads.
const SERVICE_ENVIRONMENT: &str = "BMO_REMOTE_";

/// How long the sidecar stands ended before it is started again.
const RESTART: Duration = Duration::from_secs(2);
/// How long handing a socket on may take before the sidecar counts as unreachable.
const CONNECT: Duration = Duration::from_secs(5);
/// What the browser's socket is closed with where the sidecar cannot be reached or ends without a close.
const CLOSE_UNREACHABLE: u16 = 1011;

/// A socket toward the sidecar.
type Upstream = WebSocketStream<MaybeTlsStream<TcpStream>>;

/// The sidecar as the service reaches it.
#[derive(Debug)]
pub struct Sidecar {
  address: SocketAddr,
  /// The bearer the sidecar takes, made afresh for each start of the service.
  token: String,
}

impl Sidecar {
  /// Starts the sidecar the settings name, told the account's name, and starts it again whenever it ends, for
  /// as long as the service runs; it is killed with the task that holds it.
  pub fn start(settings: &Settings, account: &Account) -> Self {
    let token = rand::random::<[u8; 32]>().iter().map(|byte| format!("{byte:02x}")).collect::<String>();
    let sidecar = Self {
      address: settings.sidecar.listen,
      token: token.clone(),
    };

    tokio::spawn(keep_running(settings.clone(), account.name.clone(), token));

    sidecar
  }

  /// Opens `path`, its query with it, on the sidecar.
  async fn open(&self, path: &str) -> Result<Upstream, String> {
    let mut request = format!("ws://{}{path}", self.address)
      .into_client_request()
      .map_err(|why| why.to_string())?;
    let bearer = HeaderValue::from_str(&format!("Bearer {}", self.token)).map_err(|why| why.to_string())?;

    request.headers_mut().insert(header::AUTHORIZATION, bearer);

    match tokio::time::timeout(CONNECT, tokio_tungstenite::connect_async(request)).await {
      Ok(Ok((socket, _))) => Ok(socket),
      Ok(Err(why)) => Err(why.to_string()),
      Err(_) => Err(format!("no answer within {} seconds", CONNECT.as_secs())),
    }
  }
}

/// The sidecar's process, as the settings name it, with what it reads in its environment.
fn command(settings: &Settings, account: &str, token: &str) -> Command {
  let mut command = Command::new(&settings.sidecar.bun);

  for (name, _) in std::env::vars_os() {
    if name.to_string_lossy().starts_with(SERVICE_ENVIRONMENT) {
      command.env_remove(name);
    }
  }

  command
    .arg("src/main.ts")
    .current_dir(&settings.sidecar.folder)
    .env("BMO_REMOTE_SIDECAR_HOST", settings.sidecar.listen.ip().to_string())
    .env("BMO_REMOTE_SIDECAR_PORT", settings.sidecar.listen.port().to_string())
    .env("BMO_REMOTE_SIDECAR_TOKEN", token)
    .env("BMO_REMOTE_DESKTOP_HOST", &settings.desktop.host)
    .env("BMO_REMOTE_DESKTOP_PORT", settings.desktop.port.to_string())
    .env("BMO_REMOTE_STORE_PATH", &settings.store.path)
    .env("USER", account)
    .stdin(Stdio::null())
    .kill_on_drop(true);

  if let Some(password) = settings.desktop.kept_password() {
    command.env("BMO_REMOTE_DESKTOP_PASSWORD", password);
  }

  command
}

/// Runs the sidecar, and runs it again a moment after each end, each start and end written to the log.
async fn keep_running(settings: Settings, account: String, token: String) {
  loop {
    match command(&settings, &account, &token).spawn() {
      Ok(mut child) => match child.wait().await {
        Ok(status) => eprintln!("bmo-remote: the desktop sidecar ended, {status}; it is started again"),
        Err(why) => eprintln!("bmo-remote: the desktop sidecar could not be waited on: {why}"),
      },
      Err(why) => eprintln!(
        "bmo-remote: the desktop sidecar could not be started with {}: {why}",
        settings.sidecar.bun.display()
      ),
    }

    tokio::time::sleep(RESTART).await;
  }
}

/// The desktop socket, the RDCleanPath relay, handed on.
pub struct DesktopSocket;

impl Route for DesktopSocket {
  const METHOD: Method = Method::GET;
  const PATH: &'static str = "/api/remote/desktop/socket";

  async fn answer(&self, call: Call) -> Result<Response, Refused> {
    hand_on(call).await
  }
}

crate::route!(DesktopSocket);

/// The pointer socket of a desktop connection, handed on.
pub struct PointerSocket;

impl Route for PointerSocket {
  const METHOD: Method = Method::GET;
  const PATH: &'static str = "/api/remote/desktop/pointer";

  async fn answer(&self, call: Call) -> Result<Response, Refused> {
    hand_on(call).await
  }
}

crate::route!(PointerSocket);

/// The keys socket of a desktop connection, handed on.
pub struct KeysSocket;

impl Route for KeysSocket {
  const METHOD: Method = Method::GET;
  const PATH: &'static str = "/api/remote/desktop/keys";

  async fn answer(&self, call: Call) -> Result<Response, Refused> {
    hand_on(call).await
  }
}

crate::route!(KeysSocket);

/// Takes the browser's upgrade and carries it to the same path and query on the sidecar.
async fn hand_on(call: Call) -> Result<Response, Refused> {
  let sidecar = Arc::clone(&call.standing().sidecar);
  let uri = call.request.uri();
  let path = uri
    .path_and_query()
    .map_or_else(|| uri.path().to_owned(), |path| path.as_str().to_owned());
  let (mut parts, _body) = call.request.into_parts();
  let upgrade = match WebSocketUpgrade::from_request_parts(&mut parts, &()).await {
    Ok(upgrade) => upgrade,
    Err(rejection) => return Ok(rejection.into_response()),
  };

  Ok(upgrade.on_upgrade(move |socket| carry(socket, sidecar, path)))
}

async fn close(mut socket: WebSocket, code: u16, reason: &'static str) {
  let _ = socket
    .send(ws::Message::Close(Some(ws::CloseFrame {
      code,
      reason: reason.into(),
    })))
    .await;
}

/// Carries every frame both ways as it came, its kind kept, until either side closes; the close goes on to
/// the other side with its code and reason.
async fn carry(mut browser: WebSocket, sidecar: Arc<Sidecar>, path: String) {
  let mut upstream = match sidecar.open(&path).await {
    Ok(upstream) => upstream,
    Err(why) => {
      eprintln!("bmo-remote: {path} could not be handed on to the desktop sidecar: {why}");
      return close(browser, CLOSE_UNREACHABLE, "desktop sidecar unreachable").await;
    }
  };

  loop {
    tokio::select! {
      incoming = browser.recv() => {
        let frame = match incoming {
          Some(Ok(ws::Message::Text(text))) => Message::text(text.as_str()),
          Some(Ok(ws::Message::Binary(bytes))) => Message::Binary(bytes),
          Some(Ok(ws::Message::Ping(_) | ws::Message::Pong(_))) => continue,
          Some(Ok(ws::Message::Close(frame))) => {
            let frame = frame.map(|frame| CloseFrame { code: frame.code.into(), reason: frame.reason.as_str().into() });
            let _ = upstream.close(frame).await;
            return;
          }
          Some(Err(_)) | None => {
            let _ = upstream.close(None).await;
            return;
          }
        };

        if upstream.send(frame).await.is_err() {
          return close(browser, CLOSE_UNREACHABLE, "desktop sidecar ended").await;
        }
      }
      outgoing = upstream.next() => {
        let frame = match outgoing {
          Some(Ok(Message::Text(text))) => ws::Message::Text(text.as_str().into()),
          Some(Ok(Message::Binary(bytes))) => ws::Message::Binary(bytes),
          Some(Ok(Message::Ping(_) | Message::Pong(_) | Message::Frame(_))) => continue,
          Some(Ok(Message::Close(frame))) => {
            let frame = frame.map(|frame| ws::CloseFrame { code: frame.code.into(), reason: frame.reason.as_str().into() });
            let _ = browser.send(ws::Message::Close(frame)).await;
            return;
          }
          Some(Err(tungstenite::Error::ConnectionClosed)) | None => return,
          Some(Err(_)) => return close(browser, CLOSE_UNREACHABLE, "desktop sidecar ended").await,
        };

        if browser.send(frame).await.is_err() {
          let _ = upstream.close(None).await;
          return;
        }
      }
    }
  }
}
