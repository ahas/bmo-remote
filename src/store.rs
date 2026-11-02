//! The store: one SQLite file, opened once as the service or the command starts, holding the port the desktop
//! relay dials (`docs/api.md`, 「The store」).

use std::ffi::{c_int, c_void};
use std::path::Path;
use std::str::FromStr;
use std::time::Duration;

use sqlx::SqlitePool;
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions};

// How often a statement that finds another writer holding the file looks again: the service and the command
// may write the one file at once, and a statement waits for the lock however long the other holds it.
const LOOK_AGAIN: Duration = Duration::from_millis(5);

/// The key the desktop's port is kept under.
const DESKTOP_PORT: &str = "desktop_port";

/// The store, open.
#[derive(Clone, Debug)]
pub struct Store {
  pool: SqlitePool,
}

impl Store {
  /// The store at `path`, made where it does not stand yet, its folder with it, and migrated.
  pub async fn open(path: &Path) -> Result<Self, StoreError> {
    if let Some(folder) = path.parent().filter(|folder| !folder.as_os_str().is_empty()) {
      std::fs::create_dir_all(folder)
        .map_err(|why| StoreError::Folder(folder.display().to_string(), why))?;
    }

    let options = SqliteConnectOptions::from_str("sqlite:")?
      .filename(path)
      .create_if_missing(true)
      .journal_mode(SqliteJournalMode::Wal);
    let pool = SqlitePoolOptions::new()
      .after_connect(|connection, _| {
        Box::pin(async move {
          let mut handle = connection.lock_handle().await?;

          // SAFETY: the handle is this connection's open database, held locked for the call, and the handler
          // reads no data through its pointer.
          unsafe {
            libsqlite3_sys::sqlite3_busy_handler(
              handle.as_raw_handle().as_ptr(),
              Some(wait_for_lock),
              std::ptr::null_mut(),
            );
          }

          Ok(())
        })
      })
      .connect_with(options)
      .await?;

    sqlx::migrate!("./migrations").run(&pool).await?;

    Ok(Self { pool })
  }

  /// The connection pool the store is read and written through.
  pub fn pool(&self) -> &SqlitePool {
    &self.pool
  }

  /// The desktop port as it is kept, read as it stands: it may not be a port at all.
  pub async fn desktop_port(&self) -> Result<Option<String>, sqlx::Error> {
    sqlx::query_scalar("SELECT value FROM kept_values WHERE key = ?")
      .bind(DESKTOP_PORT)
      .fetch_optional(&self.pool)
      .await
  }

  /// Keeps `port` as the desktop's port.
  pub async fn keep_desktop_port(&self, port: u16) -> Result<(), sqlx::Error> {
    sqlx::query("INSERT INTO kept_values (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
      .bind(DESKTOP_PORT)
      .bind(port.to_string())
      .execute(&self.pool)
      .await
      .map(drop)
  }

  /// Takes the kept desktop port away, so the settings' port is dialled.
  pub async fn forget_desktop_port(&self) -> Result<(), sqlx::Error> {
    sqlx::query("DELETE FROM kept_values WHERE key = ?")
      .bind(DESKTOP_PORT)
      .execute(&self.pool)
      .await
      .map(drop)
  }
}

// SQLite's busy handler: the lock is still held, so wait a moment and ask SQLite to try again. It runs on the
// connection's own worker thread, which does nothing else meanwhile.
extern "C" fn wait_for_lock(_: *mut c_void, _: c_int) -> c_int {
  std::thread::sleep(LOOK_AGAIN);
  1
}

/// Why the store could not be opened.
#[derive(Debug, thiserror::Error)]
pub enum StoreError {
  #[error("the store's folder {0} could not be made: {1}")]
  Folder(String, std::io::Error),
  #[error("the store could not be opened: {0}")]
  Open(#[from] sqlx::Error),
  #[error("the store could not be migrated: {0}")]
  Migrate(#[from] sqlx::migrate::MigrateError),
}
