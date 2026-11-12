//! The console face as the service wires it (`docs/api.md`, 「Conventions」, 「The console face」): the manifest
//! it serves read through bmo-ui's own reading on the release the client vendors, the console's credential and
//! the service's own token each taken where the service takes it, and the screen's routes under the face's
//! guard. The face's own rules are bmo-console-face's tests'.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use bmo_console_face::{OWNER_ROLE_HEADER, read_manifest};
use bmo_remote::account::Account;
use bmo_remote::console;
use bmo_remote::desktop::sidecar::Sidecar;
use bmo_remote::http::{self, Standing};
use bmo_remote::settings::Settings;
use bmo_remote::store::Store;
use serde_json::Value;

/// The service's own token, which the command presents.
const TOKEN: &str = "console-test-service";
/// The console's credential.
const CONSOLE: &str = "console-test-console";

fn scratch(name: &str) -> PathBuf {
  let folder = std::env::temp_dir().join(format!("bmo-remote-console-{}-{name}", std::process::id()));
  let _ = std::fs::remove_dir_all(&folder);
  std::fs::create_dir_all(&folder).expect("the scratch folder is made");

  folder
}

/// The bmo-ui release file the client vendors, as its package manifest names it.
fn vendored_release() -> PathBuf {
  let client = Path::new(env!("CARGO_MANIFEST_DIR")).join("client");
  let manifest: Value =
    serde_json::from_slice(&std::fs::read(client.join("package.json")).expect("the manifest reads"))
      .expect("the client's package manifest is JSON");
  let named = manifest["devDependencies"]["bmo-ui"].as_str().expect("the client names bmo-ui");

  client.join(named.strip_prefix("file:").expect("bmo-ui is a vendored file"))
}

/// The release's version, which its packed file is named by and which a bundle built on it names as its layer.
fn vendored_layer() -> String {
  let release = vendored_release();
  let name = release.file_name().and_then(|name| name.to_str()).expect("the release file is named");

  name
    .strip_prefix("bmo-ui-")
    .and_then(|name| name.strip_suffix(".tgz"))
    .expect("the release file is named by its version")
    .to_owned()
}

/// A bundle folder as the build writes one, on the vendored release.
fn bundle_folder(folder: &Path) -> PathBuf {
  let bundle = folder.join("bundle");

  std::fs::create_dir_all(bundle.join("chunks")).expect("the bundle folder is made");
  std::fs::write(bundle.join("remote.js"), "export default { routes: [] };")
    .expect("the module is written");
  std::fs::write(bundle.join("remote.css"), ".remote{}").expect("the stylesheet is written");
  std::fs::write(bundle.join("chunks/backend-abc123.js"), "export default 1;")
    .expect("the chunk is written");
  std::fs::write(bundle.join("words.json"), r#"{"en":{"remote":{"title":{"remote":"Remote"}}}}"#)
    .expect("the words are written");
  std::fs::write(bundle.join("layer.json"), format!(r#"{{"layer":"{}"}}"#, vendored_layer()))
    .expect("the layer is written");

  bundle
}

/// The service on a loopback port of its own, its face over a scratch bundle where the console's credential is
/// set, and its address.
async fn service(name: &str, console_token: &str) -> String {
  let folder = scratch(name);
  let bundle = bundle_folder(&folder);
  let environment = HashMap::from([
    ("BMO_REMOTE_SERVER__TOKEN".to_owned(), TOKEN.to_owned()),
    ("BMO_REMOTE_CONSOLE__TOKEN".to_owned(), console_token.to_owned()),
    ("BMO_REMOTE_CONSOLE__FOLDER".to_owned(), bundle.display().to_string()),
    ("BMO_REMOTE_SIDECAR__FOLDER".to_owned(), folder.join("no-sidecar").display().to_string()),
  ]);
  let settings = Settings::read(&folder, Some(environment)).expect("the settings are read");
  let face = console::face(&settings.console.folder, &settings.console.token).ok();
  let store = Store::open(&settings.store.path).await.expect("the store opens");
  let account = Account::current().expect("the account is read");
  let sidecar = Sidecar::start(&settings, &account);
  let router =
    http::router(Standing::new(settings, store, account, sidecar), face).expect("the routes stand");
  let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("a port is taken");
  let address = format!("http://{}", listener.local_addr().expect("the port is known"));

  tokio::spawn(async move { axum::serve(listener, router).await });

  address
}

/// A `GET` of `path` with `token` as its bearer and `role` as the reader's, its status and its body.
async fn get(address: &str, path: &str, token: Option<&str>, role: Option<&str>) -> (u16, Value) {
  let mut request = reqwest::Client::new().get(format!("{address}{path}"));

  if let Some(token) = token {
    request = request.bearer_auth(token);
  }

  if let Some(role) = role {
    request = request.header(OWNER_ROLE_HEADER, role);
  }

  let answer = request.send().await.expect("the service answers");
  let status = answer.status().as_u16();
  let body = answer.bytes().await.expect("the body is read");

  (status, serde_json::from_slice(&body).unwrap_or(Value::Null))
}

#[tokio::test]
async fn the_served_manifest_is_read_by_the_contract_on_the_vendored_release() {
  let address = service("manifest", CONSOLE).await;
  let (status, served) = get(&address, "/console-manifest", Some(CONSOLE), None).await;

  assert_eq!(status, 200, "{served}");

  let read = read_manifest(&served, &vendored_release()).unwrap_or_else(|why| panic!("{why}"));

  assert_eq!(read["name"], "remote");
  assert_eq!(read["serviceName"], "remote");
  assert_eq!(read["screenPath"], "/remote");
  assert_eq!(read["layer"], vendored_layer().as_str());
  assert_eq!(read["role"], "administrator");
  assert_eq!(read["ownerKey"], false);
  assert_eq!(read["websocket"], true);
  assert_eq!(read["apiPrefix"], "/");
}

#[tokio::test]
async fn each_credential_is_taken_where_the_service_takes_it() {
  let address = service("credentials", CONSOLE).await;
  let (_, manifest) = get(&address, "/console-manifest", Some(CONSOLE), None).await;
  let module = manifest["bundle"].as_str().expect("the manifest names the module").to_owned();
  let words = manifest["words"].as_str().expect("the manifest names the words").to_owned();
  let status =
    async |path: &str, token: Option<&str>, role: Option<&str>| get(&address, path, token, role).await.0;

  // The screen's routes: the console's credential with the screen's role, or the command's own token. A
  // terminal's route is refused before tmux is asked, so the account alone is answered here.
  for path in ["/account", "/terminals/t-none"] {
    assert_eq!(status(path, None, Some("administrator")).await, 401, "{path} without a token");
    assert_eq!(
      status(path, Some("wrong"), Some("administrator")).await,
      401,
      "{path} with a wrong token"
    );
    assert_eq!(status(path, Some(CONSOLE), None).await, 403, "{path} for the console with no role");
    assert_eq!(status(path, Some(CONSOLE), Some("member")).await, 403, "{path} for a member");
  }
  assert_eq!(
    status("/account", Some(CONSOLE), Some("administrator")).await,
    200,
    "for an administrator"
  );
  assert_eq!(status("/account", Some(TOKEN), None).await, 200, "for the command");

  // The face: the console's credential alone, the module held to the screen's role.
  for path in ["/console-manifest", words.as_str(), module.as_str()] {
    assert_eq!(
      status(path, Some(TOKEN), Some("administrator")).await,
      401,
      "{path} to the service's own token"
    );
  }
  assert_eq!(status(&words, Some(CONSOLE), None).await, 200);
  assert_eq!(status(&module, Some(CONSOLE), None).await, 403);
  assert_eq!(status(&module, Some(CONSOLE), Some("administrator")).await, 200);

  // The health: the service's own token alone.
  assert_eq!(status("/health", Some(CONSOLE), None).await, 401);
  assert_eq!(status("/health", Some(TOKEN), None).await, 200);
}

#[tokio::test]
async fn with_no_console_credential_no_face_stands() {
  let address = service("no-face", "").await;
  let (status, refused) = get(&address, "/console-manifest", Some(TOKEN), None).await;

  assert_eq!((status, refused["code"].as_str()), (404, Some("no-route")));
  assert_eq!(get(&address, "/account", Some(TOKEN), None).await.0, 200);
}
