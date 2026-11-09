//! A picture pasted into a terminal session (`docs/api.md`, 「Terminal sessions」; `docs/remote.md`, 「The terminal
//! interface」): kept as a file of the session's own under the pastes folder, refused where it is no picture the
//! service keeps, and gone with the session.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use bmo_remote::account::Account;
use bmo_remote::client::RemoteClient;
use bmo_remote::console::{ConsoleBundle, ConsoleRole};
use bmo_remote::desktop::sidecar::Sidecar;
use bmo_remote::http::{self, Standing};
use bmo_remote::settings::Settings;
use bmo_remote::store::Store;
use bmo_remote::terminal::routes::{paste_ending, pastes_of};
use bmo_remote::wire::{TerminalPaste, TerminalRequest};

const TOKEN: &str = "pastes-test";

// The fewest bytes that are a picture's: a PNG's signature and nothing after it.
const PICTURE: &[u8] = &[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];

/// The service on a loopback port and a tmux socket of its own, its settings folder a scratch one: its address,
/// the folder and the socket's name.
async fn service(name: &str) -> (String, PathBuf, String) {
  let folder = std::env::temp_dir().join(format!("bmo-remote-pastes-{}-{name}", std::process::id()));
  let _ = std::fs::remove_dir_all(&folder);
  std::fs::create_dir_all(&folder).expect("the scratch folder is made");

  let socket = format!("bmo-remote-pastes-{}-{name}", std::process::id());
  let config = Path::new(env!("CARGO_MANIFEST_DIR")).join("deploy/tmux.conf");
  let environment = HashMap::from([
    ("BMO_REMOTE_SERVER__TOKEN".to_owned(), TOKEN.to_owned()),
    ("BMO_REMOTE_SIDECAR__FOLDER".to_owned(), folder.join("no-sidecar").display().to_string()),
    ("BMO_REMOTE_TERMINAL__SOCKET".to_owned(), socket.clone()),
    ("BMO_REMOTE_TERMINAL__CONFIG".to_owned(), config.display().to_string()),
  ]);
  let settings = Settings::read(&folder, Some(environment)).expect("the settings are read");
  let store = Store::open(&settings.store.path).await.expect("the store opens");
  let account = Account::current().expect("the account is read");
  let sidecar = Sidecar::start(&settings, &account);
  let bundle = ConsoleBundle::load(&folder.join("no-bundle"));
  let router =
    http::router(Standing::new(settings, store, account, sidecar, bundle)).expect("the routes stand");
  let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("a port is taken");
  let address = format!("http://{}", listener.local_addr().expect("the port is known"));

  tokio::spawn(async move { axum::serve(listener, router).await });

  (address, folder, socket)
}

fn paste(media_type: &str, bytes: &[u8]) -> TerminalPaste {
  TerminalPaste {
    media_type: media_type.to_owned(),
    data: STANDARD.encode(bytes),
  }
}

#[test]
fn a_picture_takes_the_ending_of_its_type_and_any_other_type_none() {
  assert_eq!(paste_ending("image/png"), Some("png"));
  assert_eq!(paste_ending(" IMAGE/JPEG "), Some("jpg"));
  assert_eq!(paste_ending("image/gif"), Some("gif"));
  assert_eq!(paste_ending("image/webp"), Some("webp"));
  assert_eq!(paste_ending("image/svg+xml"), None);
  assert_eq!(paste_ending("text/plain"), None);
  assert_eq!(pastes_of(Path::new("/data/pastes"), "t-abc"), Path::new("/data/pastes/t-abc"));
}

#[tokio::test]
async fn a_pasted_picture_is_kept_for_its_session_and_goes_with_it() {
  let (address, folder, socket) = service("kept").await;
  let client = RemoteClient::new(&address, TOKEN).with_role(ConsoleRole::Administrator);
  let session = client.open_terminal(&TerminalRequest::default()).await.expect("the session opens");
  let kept = client
    .paste_terminal(&session.id, &paste("image/png", PICTURE))
    .await
    .expect("the picture is kept");
  let path = PathBuf::from(&kept.path);

  assert!(path.is_absolute(), "{}", kept.path);
  assert!(path.starts_with(folder.join("pastes").join(&session.id)), "{}", kept.path);
  assert_eq!(path.extension().and_then(|ending| ending.to_str()), Some("png"));
  assert_eq!(std::fs::read(&path).expect("the file stands"), PICTURE);

  // A second picture is a second file.
  let again = client
    .paste_terminal(&session.id, &paste("image/jpeg", PICTURE))
    .await
    .expect("the second is kept");

  assert_ne!(again.path, kept.path);
  assert!(again.path.ends_with(".jpg"), "{}", again.path);

  // What is no picture the service keeps is refused, and so is a session that does not stand.
  for refused in [
    paste("text/plain", PICTURE),
    paste("image/png", b""),
    TerminalPaste {
      media_type: "image/png".to_owned(),
      data: "not base64 at all!".to_owned(),
    },
  ] {
    let why = client.paste_terminal(&session.id, &refused).await.expect_err("it is refused");

    assert_eq!(why.code(), Some("bad-request"), "{why}");
  }

  let none = client
    .paste_terminal("t-nosuchsession", &paste("image/png", PICTURE))
    .await
    .expect_err("no session");

  assert_eq!(none.code(), Some("not-found"), "{none}");

  // The session's pictures go when it is ended.
  client.end_terminal(&session.id).await.expect("the session ends");
  assert!(!folder.join("pastes").join(&session.id).exists(), "the session's folder is gone");

  let _ = std::process::Command::new("tmux").args(["-L", &socket, "kill-server"]).output();
  let _ = std::fs::remove_dir_all(&folder);
}
