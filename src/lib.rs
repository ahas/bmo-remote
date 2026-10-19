//! The remote service: the console's terminal sessions on this machine, held by a tmux server of their own,
//! and this machine's desktop, reached over RDP through a relay the browser's client speaks RDCleanPath to
//! (`docs/remote.md`, `docs/api.md`).

pub mod settings;

use std::io;

use axum::Router;
use tokio::net::TcpListener;

use crate::settings::Settings;

/// Answers on the settings' address until the process is told to stop.
pub async fn serve(settings: Settings) -> Result<(), String> {
  let listen = settings.server.listen;
  let listener = TcpListener::bind(listen)
    .await
    .map_err(|why| format!("{listen} could not be listened on: {why}"))?;

  axum::serve(listener, Router::new())
    .with_graceful_shutdown(stopped())
    .await
    .map_err(|why: io::Error| why.to_string())
}

/// Resolves once the process is told to stop: an interrupt, or the service manager's terminate.
async fn stopped() {
  let interrupt = async {
    let _ = tokio::signal::ctrl_c().await;
  };
  let terminate = async {
    match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
      Ok(mut signal) => {
        signal.recv().await;
      }
      Err(_) => std::future::pending().await,
    }
  };

  tokio::select! {
    () = interrupt => {}
    () = terminate => {}
  }
}
