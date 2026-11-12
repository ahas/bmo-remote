//! The unit command's own words (`docs/api.md`, 「The command」): the nouns it declares to `bmo`,
//! `node remote-desktop`, which tells and sets the port the desktop relay dials, and `console-reach`, which
//! says how a console reaches the service.

use clap::Args;
use serde_json::json;

use crate::settings::Settings;
use crate::store::Store;

/// The nouns `bmo` dispatches to this command, each marked `home`: the desktop is the machine the service
/// stands on, so the command runs there.
pub const NOUNS: [&str; 2] = ["node remote-desktop\thome", "remote-desktop\thome"];

/// The words `node remote-desktop` takes: none to tell the port, `--port` to store one, `--default` to take
/// the stored one away.
#[derive(Args, Debug)]
pub struct DesktopArgs {
  /// The port to store; refused where it is not a whole number from 1 to 65535.
  #[arg(long, conflicts_with = "default", allow_hyphen_values = true)]
  pub port: Option<String>,
  /// Takes the stored port away, so the settings' port is dialled.
  #[arg(long)]
  pub default: bool,
}

/// What the command was asked, its port already read as one.
enum Asked {
  Tell,
  Port(u16),
  Default,
}

/// A port as a number reads one: a whole number from 1 to 65535.
fn port_of(text: &str) -> Option<u16> {
  let number: f64 = text.trim().parse().ok()?;

  (number.fract() == 0.0 && number > 0.0 && number < 65536.0).then_some(number as u16)
}

/// The one line that tells the port the relay dials.
async fn tell(store: &Store, usual: u16) -> Result<String, String> {
  let kept = store
    .desktop_port()
    .await
    .map_err(|why| format!("remote-desktop: the store could not be read: {why}"))?;

  Ok(match kept {
    None => {
      format!("remote-desktop: the desktop is dialled on port {usual}, the default, since none is stored.")
    }
    Some(kept) => match port_of(&kept) {
      Some(port) => format!("remote-desktop: the desktop is dialled on port {port}."),
      None => {
        format!("remote-desktop: the stored value '{kept}' is not a port, so port {usual} is dialled.")
      }
    },
  })
}

/// Runs `node remote-desktop`: the line to print, or the refusal to put on standard error.
pub async fn remote_desktop(settings: Settings, args: DesktopArgs) -> Result<String, String> {
  let asked = match (args.port, args.default) {
    (Some(value), _) => {
      Asked::Port(port_of(&value).ok_or_else(|| format!("remote-desktop: not a port: {value}"))?)
    }
    (None, true) => Asked::Default,
    (None, false) => Asked::Tell,
  };

  let store = Store::open(&settings.store.path)
    .await
    .map_err(|why| format!("remote-desktop: {why}"))?;
  let written = |why: sqlx::Error| format!("remote-desktop: the store could not be written: {why}");

  match asked {
    Asked::Tell => {}
    Asked::Default => store.forget_desktop_port().await.map_err(written)?,
    Asked::Port(port) => store.keep_desktop_port(port).await.map_err(written)?,
  }

  tell(&store, settings.desktop.port).await
}

/// Runs `console-reach`: how a console reaches the service, as one JSON object of its base address, the
/// console's credential and the service's own token, for a deployment's console probe.
pub fn console_reach(settings: &Settings) -> String {
  json!({
    "address": format!("http://{}", settings.server.listen),
    "consoleToken": settings.console.token,
    "token": settings.server.token,
  })
  .to_string()
}
