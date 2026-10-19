//! One viewer of one terminal session: a tmux attach client in a pseudo-terminal of this machine
//! (`docs/remote.md`, 「The terminal socket」). Ending it ends that client only; the session goes on in the
//! tmux server.

use std::io::{Read, Write};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use portable_pty::{ChildKiller, CommandBuilder, MasterPty, PtySize, native_pty_system};
use tokio::sync::{mpsc, oneshot};
use tokio::time::{Instant, sleep_until};

use crate::terminal::tmux::client_environment;

// Output is gathered for at most this long, or this much, before it is handed on.
const FLUSH_AFTER: Duration = Duration::from_millis(30);
const FLUSH_BYTES: usize = 16 * 1024;

const MIN_SIZE: u16 = 2;
const MAX_COLS: u16 = 1000;
const MAX_ROWS: u16 = 500;
const DEFAULT_COLS: u16 = 80;
const DEFAULT_ROWS: u16 = 24;

// How much one read of the terminal takes at most.
const READ_CHUNK: usize = 8 * 1024;

/// What the attach client hands on: what the terminal printed, gathered, and then once that it ended.
#[derive(Debug)]
pub enum Event {
  Output(Vec<u8>),
  Exited,
}

/// A size as a number read the way the screen's script reads one: whole, at least 2 and at most `max`, and
/// `fallback` where it is no number at all.
pub fn clamp_size(value: f64, max: u16, fallback: u16) -> u16 {
  let whole = value.floor();

  if !whole.is_finite() {
    return fallback;
  }

  whole.clamp(f64::from(MIN_SIZE), f64::from(max)) as u16
}

/// One attach client, its pseudo-terminal and what it hands on.
pub struct Attach {
  master: Box<dyn MasterPty + Send>,
  input: mpsc::UnboundedSender<Vec<u8>>,
  killer: Box<dyn ChildKiller + Send + Sync>,
  // Set once the viewer let go: the output is dropped from then on, and nothing more is written.
  hung_up: Arc<AtomicBool>,
  cols: u16,
  rows: u16,
  /// What the client hands on, in order, its end last.
  pub events: mpsc::Receiver<Event>,
}

/// Why an attach client could not start.
#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct AttachError(String);

/// Attaches a client to the session `id` on the tmux `socket`, at `cols` by `rows` as the browser asked.
pub fn attach(socket: &str, id: &str, cols: f64, rows: f64) -> Result<Attach, AttachError> {
  let cols = clamp_size(cols, MAX_COLS, DEFAULT_COLS);
  let rows = clamp_size(rows, MAX_ROWS, DEFAULT_ROWS);
  let pair = native_pty_system()
    .openpty(PtySize {
      rows,
      cols,
      pixel_width: 0,
      pixel_height: 0,
    })
    .map_err(|why| AttachError(format!("a pseudo-terminal could not be opened: {why}")))?;
  let mut command = CommandBuilder::new("tmux");

  command.args(["-u", "-L", socket, "attach-session", "-t", &format!("={id}")]);
  command.env_clear();

  for (key, value) in client_environment() {
    command.env(key, value);
  }

  command.env("TERM", "xterm-256color");
  command.env("COLORTERM", "truecolor");

  let mut child = pair
    .slave
    .spawn_command(command)
    .map_err(|why| AttachError(format!("tmux attach could not be started: {why}")))?;

  // The client holds the terminal's other end now; this process keeps none, so the terminal reads as
  // ended once the client is gone.
  drop(pair.slave);

  let reader = pair
    .master
    .try_clone_reader()
    .map_err(|why| AttachError(format!("the terminal could not be read: {why}")))?;
  let writer = pair
    .master
    .take_writer()
    .map_err(|why| AttachError(format!("the terminal could not be written: {why}")))?;
  let killer = child.clone_killer();
  let hung_up = Arc::new(AtomicBool::new(false));
  let (chunks, chunks_in) = mpsc::unbounded_channel();
  let (input, input_in) = mpsc::unbounded_channel();
  let (exited, exit_in) = oneshot::channel();
  let (events_out, events) = mpsc::channel(64);

  std::thread::spawn(move || read_terminal(reader, chunks));
  std::thread::spawn(move || write_terminal(writer, input_in));
  std::thread::spawn(move || {
    let _ = child.wait();
    let _ = exited.send(());
  });
  tokio::spawn(gather(chunks_in, exit_in, events_out, hung_up.clone()));

  Ok(Attach {
    master: pair.master,
    input,
    killer,
    hung_up,
    cols,
    rows,
    events,
  })
}

impl Attach {
  /// Hands what was typed to the client, while it stands.
  pub fn write(&self, bytes: &[u8]) {
    if !self.hung_up.load(Ordering::SeqCst) {
      let _ = self.input.send(bytes.to_vec());
    }
  }

  /// The terminal's new size, each number read as [`clamp_size`] reads it, falling back on the first size.
  pub fn resize(&self, cols: f64, rows: f64) {
    if self.hung_up.load(Ordering::SeqCst) {
      return;
    }

    let size = PtySize {
      rows: clamp_size(rows, MAX_ROWS, self.rows),
      cols: clamp_size(cols, MAX_COLS, self.cols),
      pixel_width: 0,
      pixel_height: 0,
    };
    let _ = self.master.resize(size);
  }

  /// Lets the client go: its output is dropped, and it is hung up, which detaches it.
  pub fn close(&mut self) {
    if self.hung_up.swap(true, Ordering::SeqCst) {
      return;
    }

    let _ = self.killer.kill();
  }
}

impl Drop for Attach {
  fn drop(&mut self) {
    self.close();
  }
}

/// Reads the terminal until it ends, handing each piece on as it comes.
fn read_terminal(mut reader: Box<dyn Read + Send>, chunks: mpsc::UnboundedSender<Vec<u8>>) {
  let mut buffer = vec![0; READ_CHUNK];

  loop {
    match reader.read(&mut buffer) {
      Ok(0) | Err(_) => return,
      Ok(read) => {
        if chunks.send(buffer[..read].to_vec()).is_err() {
          return;
        }
      }
    }
  }
}

/// Writes what the viewer typed into the terminal, in order, until the client is let go.
fn write_terminal(mut writer: Box<dyn Write + Send>, mut input: mpsc::UnboundedReceiver<Vec<u8>>) {
  while let Some(bytes) = input.blocking_recv() {
    if writer.write_all(&bytes).and_then(|()| writer.flush()).is_err() {
      return;
    }
  }
}

/// Gathers the terminal's output into pieces of at most [`FLUSH_BYTES`] or [`FLUSH_AFTER`] from the first
/// byte waiting, and once the client has ended, hands on what is left and then its end.
async fn gather(
  mut chunks: mpsc::UnboundedReceiver<Vec<u8>>,
  mut exited: oneshot::Receiver<()>,
  events: mpsc::Sender<Event>,
  hung_up: Arc<AtomicBool>,
) {
  let mut pending: Vec<u8> = Vec::new();
  let mut deadline: Option<Instant> = None;
  let mut reading = true;
  let flush = |pending: &mut Vec<u8>| {
    let bytes = std::mem::take(pending);

    async {
      if !bytes.is_empty() && !hung_up.load(Ordering::SeqCst) {
        let _ = events.send(Event::Output(bytes)).await;
      }
    }
  };

  loop {
    tokio::select! {
      chunk = chunks.recv(), if reading => match chunk {
        Some(chunk) => {
          pending.extend_from_slice(&chunk);

          if pending.len() >= FLUSH_BYTES {
            deadline = None;
            flush(&mut pending).await;
          } else {
            deadline.get_or_insert_with(|| Instant::now() + FLUSH_AFTER);
          }
        }
        None => reading = false,
      },
      () = async { sleep_until(deadline.unwrap_or_else(Instant::now)).await }, if deadline.is_some() => {
        deadline = None;
        flush(&mut pending).await;
      }
      _ = &mut exited => {
        while let Ok(chunk) = chunks.try_recv() {
          pending.extend_from_slice(&chunk);
        }

        flush(&mut pending).await;

        let _ = events.send(Event::Exited).await;

        return;
      }
    }
  }
}
