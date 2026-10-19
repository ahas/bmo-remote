//! The remote service: the console's terminal sessions on this machine, held by a tmux server of their own,
//! and this machine's desktop, reached over RDP through a relay the browser's client speaks RDCleanPath to
//! (`docs/remote.md`, `docs/api.md`).

pub mod account;
pub mod command;
pub mod health;
pub mod http;
pub mod settings;
pub mod store;
pub mod terminal;

use std::io;

use tokio::net::TcpListener;

use crate::account::Account;
use crate::http::Standing;
use crate::settings::Settings;
use crate::store::Store;

/// Opens the store and reads the account, then answers the routes on the settings' address until the
/// process is told to stop.
pub async fn serve(settings: Settings) -> Result<(), String> {
  let store = Store::open(&settings.store.path).await.map_err(|why| why.to_string())?;
  let account = Account::current()?;
  let listen = settings.server.listen;
  let router = http::router(Standing::new(settings, store, account)).map_err(|faults| faults.join("; "))?;
  let listener = TcpListener::bind(listen)
    .await
    .map_err(|why| format!("{listen} could not be listened on: {why}"))?;

  axum::serve(listener, router)
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
