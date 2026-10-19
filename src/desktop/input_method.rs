//! The desktop session's input method, as the on-screen keyboard's typing needs it (`docs/remote.md`,
//! 「The on-screen keyboard」): fcitx5, which composes Hangul from 2-set (dubeolsik) keys. What state it is in
//! is asked of fcitx5 itself over the account's session bus; the key that turns it on and off, and the
//! layout its Hangul engine reads keys by, are read from its configuration.

use std::path::PathBuf;
use std::time::Duration;

use ini::{Ini, ParseOption};

/// The Hangul mode of the focused input context: none where no input context has focus, or fcitx5 cannot
/// be asked, or it reads another layout.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InputMethodState {
  None,
  Off,
  On,
}

/// A modifier held around a key the relay presses.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Modifier {
  Ctrl,
  Alt,
  Shift,
  Meta,
}

impl Modifier {
  /// The modifier fcitx5 names in a trigger, where it is one the relay can press.
  fn from_fcitx(name: &str) -> Option<Self> {
    match name {
      "Control" => Some(Self::Ctrl),
      "Alt" => Some(Self::Alt),
      "Shift" => Some(Self::Shift),
      "Super" => Some(Self::Meta),
      _ => None,
    }
  }
}

/// A key the relay presses, by the browser's name for it, with the modifiers held around it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct KeyChord {
  pub code: String,
  pub modifiers: Vec<Modifier>,
}

/// What the typing needs of the input method.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InputMethod {
  pub state: InputMethodState,
  /// The key that switches the mode, where the configuration names one the relay can press.
  pub trigger: Option<KeyChord>,
}

// The browser's name for a key fcitx5 names in a trigger, where the relay can press it. The Hangul key is
// not among them: gnome-remote-desktop hands the session no Hangul keysym for its scancode, so fcitx5 never
// sees it pressed.
fn key_from_fcitx(name: &str) -> Option<&'static str> {
  match name {
    "Alt_R" => Some("AltRight"),
    "space" => Some("Space"),
    _ => None,
  }
}

// fcitx5's own trigger keys where its configuration names none.
const DEFAULT_TRIGGERS: [&str; 1] = ["Control+space"];
// The configuration's section of trigger keys.
const TRIGGER_SECTION: &str = "Hotkey/TriggerKeys";
// The layout the relay types Hangul in, as fcitx5-hangul names it; the engine reads it where its
// configuration names none.
const DUBEOLSIK: &str = "Dubeolsik";
const LAYOUT_KEY: &str = "Keyboard";

// fcitx5's controller on the session bus, and what its state call answers: 0 where no input context has
// focus, 1 inactive, 2 active.
const FCITX_SERVICE: &str = "org.fcitx.Fcitx5";
const FCITX_PATH: &str = "/controller";
const FCITX_CONTROLLER: &str = "org.fcitx.Fcitx.Controller1";
const FCITX_INACTIVE: i32 = 1;
const FCITX_ACTIVE: i32 = 2;

// How long fcitx5 is given to say its state.
const ASK_TIMEOUT: Duration = Duration::from_millis(1000);

/// One trigger as fcitx5 writes it, modifiers and a key joined by `+`, or none where the relay cannot press
/// it.
pub fn read_trigger(spec: &str) -> Option<KeyChord> {
  let parts: Vec<&str> = spec.split('+').collect();
  let (key, modifiers) = parts.split_last()?;
  let code = key_from_fcitx(key)?.to_owned();
  let modifiers = modifiers.iter().map(|part| Modifier::from_fcitx(part)).collect::<Option<Vec<_>>>()?;

  Some(KeyChord { code, modifiers })
}

fn parse(text: &str) -> Option<Ini> {
  let raw = ParseOption {
    enabled_quote: false,
    enabled_escape: false,
    ..ParseOption::default()
  };

  Ini::load_from_str_opt(text, raw).ok()
}

/// The first trigger key the configuration names that the relay can press.
pub fn trigger_of(config: Option<&str>) -> Option<KeyChord> {
  let named: Vec<String> = config
    .and_then(parse)
    .and_then(|ini| {
      ini
        .section(Some(TRIGGER_SECTION))
        .map(|keys| keys.iter().map(|(_, value)| value.to_owned()).collect())
    })
    .unwrap_or_default();

  if named.is_empty() {
    return DEFAULT_TRIGGERS.iter().find_map(|spec| read_trigger(spec));
  }

  named.iter().find_map(|spec| read_trigger(spec))
}

/// Whether the Hangul engine reads keys by the 2-set layout: the first layout its configuration names, or
/// that layout where it names none.
pub fn reads_dubeolsik(config: Option<&str>) -> bool {
  let layout = config.and_then(parse).and_then(|ini| {
    ini
      .iter()
      .find_map(|(_, properties)| properties.get(LAYOUT_KEY).map(|value| value.trim().to_owned()))
  });

  layout.as_deref().unwrap_or(DUBEOLSIK) == DUBEOLSIK
}

/// The state fcitx5 answers for the focused input context, or none where it could not be asked.
pub fn state_of(answer: Option<i32>) -> InputMethodState {
  match answer {
    Some(FCITX_ACTIVE) => InputMethodState::On,
    Some(FCITX_INACTIVE) => InputMethodState::Off,
    _ => InputMethodState::None,
  }
}

/// The account's session bus, where its desktop session's services answer.
pub fn session_bus() -> String {
  if let Ok(address) = std::env::var("DBUS_SESSION_BUS_ADDRESS") {
    return address;
  }

  let runtime = std::env::var("XDG_RUNTIME_DIR")
    .unwrap_or_else(|_| format!("/run/user/{}", nix::unistd::getuid().as_raw()));

  format!("unix:path={runtime}/bus")
}

/// A connection to the account's session bus.
pub async fn session_connection() -> zbus::Result<zbus::Connection> {
  zbus::connection::Builder::address(session_bus().as_str())?.build().await
}

async fn ask_fcitx_state() -> zbus::Result<i32> {
  let connection = session_connection().await?;
  let controller = zbus::Proxy::new(&connection, FCITX_SERVICE, FCITX_PATH, FCITX_CONTROLLER).await?;

  controller.call("State", &()).await
}

// Asks fcitx5 over the session bus; none where it could not be asked in time.
async fn ask_fcitx() -> Option<i32> {
  tokio::time::timeout(ASK_TIMEOUT, ask_fcitx_state()).await.ok()?.ok()
}

fn read_text(path: PathBuf) -> Option<String> {
  std::fs::read_to_string(path).ok()
}

// fcitx5's configuration folder.
fn config_root() -> PathBuf {
  let config = std::env::var_os("XDG_CONFIG_HOME")
    .map(PathBuf::from)
    .unwrap_or_else(|| std::env::home_dir().unwrap_or_default().join(".config"));

  config.join("fcitx5")
}

/// The input method as it stands now: its trigger from its configuration, and its state from fcitx5 where
/// the trigger can be pressed and the engine reads the 2-set layout.
pub async fn read_input_method() -> InputMethod {
  let root = config_root();
  let trigger = trigger_of(read_text(root.join("config")).as_deref());
  let layout = read_text(root.join("conf").join("hangul.conf"));

  if trigger.is_none() || !reads_dubeolsik(layout.as_deref()) {
    return InputMethod {
      state: InputMethodState::None,
      trigger,
    };
  }

  InputMethod {
    state: state_of(ask_fcitx().await),
    trigger,
  }
}
