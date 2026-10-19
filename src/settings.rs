//! The settings (`docs/api.md`, 「Settings」): the defaults built in from `settings.toml`, then the
//! settings folder's `settings.toml` and `settings.local.toml` where they stand, then the environment. A
//! relative path among them is read from the settings folder.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};

use config::{Config, Environment, File, FileFormat};
use serde::Deserialize;

/// The defaults, as the repository's own settings file states them.
const DEFAULTS: &str = include_str!("../settings.toml");
/// The settings file a deployment may give.
pub const SETTINGS_FILE: &str = "settings.toml";
/// The file a deployment overrides it with.
pub const LOCAL_SETTINGS_FILE: &str = "settings.local.toml";
/// The environment variable naming the settings folder.
pub const SETTINGS_FOLDER: &str = "BMO_REMOTE_SETTINGS";
/// What every environment variable that sets a key begins with.
pub const ENVIRONMENT_PREFIX: &str = "BMO_REMOTE";

/// Everything the service and its command are started with.
#[derive(Clone, Debug, Deserialize)]
pub struct Settings {
  pub server: Server,
  pub desktop: Desktop,
  pub terminal: Terminal,
  pub store: Store,
}

/// The HTTP and websocket server.
#[derive(Clone, Debug, Deserialize)]
pub struct Server {
  /// Where the service answers, a loopback address by default.
  pub listen: SocketAddr,
  /// The bearer token every caller presents; an empty one lets no caller in.
  pub token: String,
}

/// The RDP server the relay dials (`docs/remote.md`, 「Where the desktop is」).
#[derive(Clone, Debug, Deserialize)]
pub struct Desktop {
  /// Its address.
  pub host: String,
  /// Its port where the store holds none.
  pub port: u16,
  /// The password the relay answers the desktop's authentication with; none, or an empty one, is no
  /// password kept (`docs/remote.md`, 「Credentials」).
  #[serde(default)]
  pub password: Option<String>,
}

impl Desktop {
  /// The kept password, where one is set and not empty.
  pub fn kept_password(&self) -> Option<&str> {
    self.password.as_deref().filter(|password| !password.is_empty())
  }
}

/// The tmux server the terminal sessions stand on (`docs/remote.md`, 「tmux holds them」).
#[derive(Clone, Debug, Deserialize)]
pub struct Terminal {
  /// The socket's name.
  pub socket: String,
  /// The tmux configuration file.
  pub config: PathBuf,
}

/// The store of the desktop port.
#[derive(Clone, Debug, Deserialize)]
pub struct Store {
  /// The SQLite file.
  pub path: PathBuf,
}

impl Settings {
  /// The settings of this process: its settings folder, then its environment.
  pub fn load() -> Result<Self, SettingsError> {
    Self::read(&folder(), None)
  }

  /// The settings read from `dir`, then from `environment` where it is given and from the process's own
  /// environment where it is not, with every relative path read from `dir`.
  pub fn read(dir: &Path, environment: Option<HashMap<String, String>>) -> Result<Self, SettingsError> {
    let environment = Environment::with_prefix(ENVIRONMENT_PREFIX)
      .prefix_separator("_")
      .separator("__")
      .try_parsing(true)
      .source(environment);
    let mut settings: Self = Config::builder()
      .add_source(File::from_str(DEFAULTS, FileFormat::Toml))
      .add_source(File::from(dir.join(SETTINGS_FILE)).format(FileFormat::Toml).required(false))
      .add_source(File::from(dir.join(LOCAL_SETTINGS_FILE)).format(FileFormat::Toml).required(false))
      .add_source(environment)
      .build()?
      .try_deserialize()?;

    settings.terminal.config = dir.join(&settings.terminal.config);
    settings.store.path = dir.join(&settings.store.path);

    Ok(settings)
  }
}

/// The settings folder: the one the environment names, else the folder above the one holding the binary,
/// a deployment's root.
fn folder() -> PathBuf {
  std::env::var_os(SETTINGS_FOLDER)
    .filter(|named| !named.is_empty())
    .map(PathBuf::from)
    .or_else(|| {
      let binary = std::env::current_exe().ok()?;

      Some(binary.parent()?.parent()?.to_path_buf())
    })
    .unwrap_or_else(|| PathBuf::from("."))
}

/// Why the settings could not be read.
#[derive(Debug, thiserror::Error)]
#[error("the settings could not be read: {0}")]
pub struct SettingsError(#[from] config::ConfigError);
