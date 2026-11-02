//! The tmux server that holds the terminal sessions (`docs/remote.md`, 「Terminal sessions」). Every session
//! is a tmux session on the service's own socket; the server runs as a transient user unit, so it outlives
//! the service and never sees the service's environment.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use tokio::process::Command;
use tokio::sync::Mutex;
use tokio::time::sleep;

/// A title's most characters, counted as the screen counts them, in UTF-16 units.
pub const TITLE_MAX: usize = 80;

// How often a freshly launched server is asked whether its socket is open, while its unit runs.
const START_POLL: Duration = Duration::from_millis(50);

// A tab: tmux prints it as it is (other control characters come out escaped), and a title never holds
// one.
const FIELD: char = '\t';
const LIST_FORMAT: &str = "#{session_name}\t#{@title}\t#{session_created}";

// The variables of the service's own environment a tmux client is handed, beside `PATH` and `LANG`.
const HANDED_ON: [&str; 5] = ["HOME", "USER", "LOGNAME", "XDG_RUNTIME_DIR", "TMUX_TMPDIR"];
const FALLBACK_PATH: &str = "/usr/bin:/bin";
const FALLBACK_LOCALE: &str = "C.UTF-8";

/// One terminal session, as tmux holds it (`docs/api.md`, 「Terminal sessions」).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RemoteTerminal {
  pub id: String,
  pub title: String,
  /// Milliseconds since the epoch.
  pub created_at: i64,
}

/// Why tmux could not do what it was asked.
#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct TmuxError(pub String);

/// Whether `id` is a session id the service makes: `t-` and lower-case letters and digits.
pub fn is_terminal_id(id: &str) -> bool {
  id.strip_prefix("t-").is_some_and(|rest| {
    !rest.is_empty() && rest.bytes().all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
  })
}

/// A socket name tmux takes as it is: letters, digits, `_` and `-`.
fn usable_socket(socket: &str) -> bool {
  !socket.is_empty()
    && socket.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

/// A title as one line of plain text, at most [`TITLE_MAX`] long: control characters would reach tmux's own
/// formats, so each becomes a space, and the ends are trimmed.
pub fn tidy_title(title: &str) -> String {
  let plain: String = title.chars().map(|one| if one.is_ascii_control() { ' ' } else { one }).collect();
  let mut units = 0;

  plain
    .trim()
    .chars()
    .take_while(|one| {
      units += one.len_utf16();
      units <= TITLE_MAX
    })
    .collect()
}

/// What a tmux client of the service's is started with. The service's own environment carries its secrets
/// and is never handed on; a client needs only where things are and that the text is UTF-8.
pub fn client_environment() -> Vec<(String, String)> {
  let lang = std::env::var("LANG")
    .ok()
    .filter(|lang| {
      let lower = lang.to_ascii_lowercase();
      lower.contains("utf-8") || lower.contains("utf8")
    })
    .unwrap_or_else(|| FALLBACK_LOCALE.to_owned());
  let mut environment = vec![
    ("PATH".to_owned(), std::env::var("PATH").unwrap_or_else(|_| FALLBACK_PATH.to_owned())),
    ("LANG".to_owned(), lang),
  ];

  environment.extend(HANDED_ON.iter().filter_map(|key| {
    std::env::var(key)
      .ok()
      .filter(|value| !value.is_empty())
      .map(|value| ((*key).to_owned(), value))
  }));
  environment
}

/// What one tmux call ended with.
struct Ran {
  success: bool,
  stdout: String,
  stderr: String,
}

/// The service's tmux server: its socket, its configuration file and the account's login shell.
#[derive(Debug)]
pub struct Tmux {
  socket: String,
  config: PathBuf,
  shell: String,
  // Whether the server has been brought up and configured by this process.
  prepared: Mutex<bool>,
}

impl Tmux {
  /// The holder of the server on `socket`, configured by `config`, starting sessions in `shell`.
  pub fn new(socket: &str, config: &Path, shell: &str) -> Self {
    Self {
      socket: socket.to_owned(),
      config: config.to_owned(),
      shell: shell.to_owned(),
      prepared: Mutex::new(false),
    }
  }

  /// The socket the sessions stand on.
  pub fn socket(&self) -> &str {
    &self.socket
  }

  async fn run(&self, args: &[&str]) -> Result<Ran, TmuxError> {
    if !usable_socket(&self.socket) {
      return Err(TmuxError(format!("tmux socket name is not usable: {}", self.socket)));
    }

    let child = Command::new("tmux")
      .arg("-L")
      .arg(&self.socket)
      .args(args)
      .env_clear()
      .envs(client_environment())
      .stdin(Stdio::null())
      .stdout(Stdio::piped())
      .stderr(Stdio::piped())
      .kill_on_drop(true)
      .spawn()
      .map_err(|why| TmuxError(format!("tmux could not be run: {why}")))?;
    let output = child
      .wait_with_output()
      .await
      .map_err(|why| TmuxError(format!("tmux could not be run: {why}")))?;

    Ok(Ran {
      success: output.status.success(),
      stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
      stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
    })
  }

  async fn must(&self, args: &[&str]) -> Result<String, TmuxError> {
    let ran = self.run(args).await?;

    if !ran.success {
      return Err(TmuxError(format!("tmux {} failed: {}", args[0], ran.stderr.trim())));
    }

    Ok(ran.stdout)
  }

  async fn answers(&self) -> bool {
    self.run(&["list-sessions"]).await.is_ok_and(|ran| ran.success)
  }

  /// Starts the server as a transient user unit; a unit of that name left standing without a server
  /// behind it is stopped and started again.
  async fn launch(&self) -> Result<(), TmuxError> {
    let unit = self.unit();
    let config = self.config.to_string_lossy();
    let start = || {
      Command::new("systemd-run")
        .args([
          "--user",
          "--collect",
          "--quiet",
          &format!("--unit={unit}"),
          "tmux",
          "-L",
          &self.socket,
          "-f",
        ])
        .arg(config.as_ref())
        .arg("-D")
        .stdin(Stdio::null())
        .output()
    };
    let failed = |why: std::io::Error| TmuxError(format!("tmux server could not be started: {why}"));
    let mut ran = start().await.map_err(failed)?;

    if !ran.status.success() {
      let said = String::from_utf8_lossy(&ran.stderr).to_ascii_lowercase();

      if said.contains("already exists") || said.contains("already loaded") {
        let _ = Command::new("systemctl")
          .args(["--user", "stop", &unit])
          .stdin(Stdio::null())
          .output()
          .await;
        ran = start().await.map_err(failed)?;
      }
    }

    if !ran.status.success() {
      return Err(TmuxError(format!(
        "tmux server could not be started: {}",
        String::from_utf8_lossy(&ran.stderr).trim()
      )));
    }

    Ok(())
  }

  // The transient unit the server runs as.
  fn unit(&self) -> String {
    format!("bmo-remote-{}", self.socket)
  }

  // Whether the server's unit still runs: a server that ended before it opened its socket never will.
  async fn unit_runs(&self) -> bool {
    Command::new("systemctl")
      .args(["--user", "is-active", "--quiet", &self.unit()])
      .stdin(Stdio::null())
      .status()
      .await
      .is_ok_and(|status| status.success())
  }

  async fn bring_up(&self) -> Result<(), TmuxError> {
    if !self.answers().await {
      self.launch().await?;

      // A just-started server is asked until it answers on its socket, for as long as its unit runs.
      while !self.answers().await {
        if !self.unit_runs().await {
          return Err(TmuxError(format!("tmux server on socket {} ended before it answered", self.socket)));
        }

        sleep(START_POLL).await;
      }
    }

    // A server that was already running reads the configuration this service carries, and every server
    // starts its sessions in the account's own login shell.
    let config = self.config.to_string_lossy();

    self.must(&["source-file", config.as_ref()]).await?;
    self.must(&["set-option", "-g", "default-shell", &self.shell]).await?;

    Ok(())
  }

  /// The server, brought up and configured once per process and again whenever it has gone away: a tmux
  /// command aimed at a socket nobody answers starts a server of its own, outside the unit and without its
  /// configuration. A failure is tried again on the next call.
  pub async fn ready(&self) -> Result<(), TmuxError> {
    let mut prepared = self.prepared.lock().await;

    if *prepared && !self.answers().await {
      *prepared = false;
    }

    if !*prepared {
      self.bring_up().await?;
      *prepared = true;
    }

    Ok(())
  }

  /// Every session on the socket, in the order they began.
  pub async fn list(&self) -> Result<Vec<RemoteTerminal>, TmuxError> {
    self.ready().await?;

    let ran = self.run(&["list-sessions", "-F", LIST_FORMAT]).await?;

    if !ran.success {
      return Err(TmuxError(format!("tmux list-sessions failed: {}", ran.stderr.trim())));
    }

    Ok(parse_sessions(&ran.stdout))
  }

  /// The session `id` names, where it stands.
  pub async fn find(&self, id: &str) -> Result<Option<RemoteTerminal>, TmuxError> {
    if !is_terminal_id(id) {
      return Ok(None);
    }

    Ok(self.list().await?.into_iter().find(|one| one.id == id))
  }

  /// A new session running the account's login shell in its home, named by `title` where one is given.
  pub async fn create(&self, title: Option<&str>) -> Result<RemoteTerminal, TmuxError> {
    self.ready().await?;

    let id = format!(
      "t-{}",
      rand::random::<[u8; 6]>().iter().map(|byte| format!("{byte:02x}")).collect::<String>()
    );
    let home = std::env::var("HOME").unwrap_or_else(|_| "/".to_owned());

    self
      .must(&["new-session", "-d", "-s", &id, "-c", &home, "-x", "80", "-y", "24"])
      .await?;

    let tidy = tidy_title(title.unwrap_or_default());

    if !tidy.is_empty() {
      self.must(&["set-option", "-t", &format!("={id}:"), "@title", &tidy]).await?;
    }

    self
      .find(&id)
      .await?
      .ok_or_else(|| TmuxError(format!("tmux session {id} did not stand")))
  }

  /// The session renamed, where it stands; an empty title takes the title away.
  pub async fn rename(&self, id: &str, title: &str) -> Result<Option<RemoteTerminal>, TmuxError> {
    if self.find(id).await?.is_none() {
      return Ok(None);
    }

    let tidy = tidy_title(title);
    let target = format!("={id}:");

    if tidy.is_empty() {
      self.must(&["set-option", "-u", "-t", &target, "@title"]).await?;
    } else {
      self.must(&["set-option", "-t", &target, "@title", &tidy]).await?;
    }

    self.find(id).await
  }

  /// Ends the session and every program in it; false where it does not stand.
  pub async fn end(&self, id: &str) -> Result<bool, TmuxError> {
    if self.find(id).await?.is_none() {
      return Ok(false);
    }

    self.must(&["kill-session", "-t", &format!("={id}")]).await?;

    Ok(true)
  }
}

/// The sessions tmux listed in [`LIST_FORMAT`], those with a session id of the service's alone, in the
/// order they began.
pub fn parse_sessions(stdout: &str) -> Vec<RemoteTerminal> {
  let mut sessions: Vec<RemoteTerminal> = stdout
    .lines()
    .filter(|line| !line.is_empty())
    .filter_map(|line| {
      let mut fields = line.split(FIELD);
      let id = fields.next().filter(|id| is_terminal_id(id))?;

      Some(RemoteTerminal {
        id: id.to_owned(),
        title: fields.next().unwrap_or_default().to_owned(),
        created_at: fields.next().and_then(|created| created.parse::<i64>().ok()).unwrap_or(0) * 1000,
      })
    })
    .collect();

  sessions.sort_by(|one, other| one.created_at.cmp(&other.created_at).then_with(|| one.id.cmp(&other.id)));
  sessions
}
