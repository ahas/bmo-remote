//! The account the service runs as, which the terminal and the desktop are reached as, read from this
//! machine's passwd database; and the route that tells it (`docs/api.md`, 「The account」).

use axum::http::{Method, StatusCode};
use axum::response::Response;
use nix::unistd::{Uid, User};

use crate::http::{Call, Refused, Route, answer};
use crate::wire::Account as AccountAnswer;

/// The shell a session runs where the passwd database names none that is an absolute path.
const FALLBACK_SHELL: &str = "/bin/sh";

/// The account, as the passwd database holds it for the process's own user.
#[derive(Clone, Debug)]
pub struct Account {
  /// Its name.
  pub name: String,
  /// Its login shell (`docs/remote.md`, 「tmux holds them」).
  pub shell: String,
}

impl Account {
  /// The process's own account, read once as the service starts.
  pub fn current() -> Result<Self, String> {
    let uid = Uid::current();
    let user = User::from_uid(uid)
      .map_err(|why| format!("the passwd database could not be read for uid {uid}: {why}"))?
      .ok_or_else(|| format!("the passwd database names no account for uid {uid}"))?;
    let shell = user.shell.to_string_lossy().into_owned();

    Ok(Self {
      name: user.name,
      shell: if shell.starts_with('/') { shell } else { FALLBACK_SHELL.to_owned() },
    })
  }
}

/// The account's name, whether the desktop password is kept and the window a desktop that does not answer is
/// tried in; the password itself is never answered.
pub struct AccountRoute;

impl Route for AccountRoute {
  const METHOD: Method = Method::GET;
  const PATH: &'static str = "/account";

  async fn answer(&self, call: Call) -> Result<Response, Refused> {
    let standing = call.standing();

    Ok(answer(
      StatusCode::OK,
      AccountAnswer {
        name: standing.account.name.clone(),
        kept_password: standing.settings.desktop.kept_password().is_some(),
        wake_seconds: standing.settings.desktop.wake_seconds,
      },
    ))
  }
}

crate::route!(AccountRoute);
