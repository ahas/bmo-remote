//! The console bundle's routes (`docs/api.md`, 「The console bundle's routes」, 「Conventions」): the
//! manifest read through bmo-ui's own reading and held to the layer pack's declaration, the token and the
//! reader's role refused 401 and 403, and the module's path following its bytes.

use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use bmo_remote::account::Account;
use bmo_remote::client::RemoteClient;
use bmo_remote::console::{ConsoleBundle, ConsoleRole, OWNER_ROLE_HEADER};
use bmo_remote::desktop::sidecar::Sidecar;
use bmo_remote::http::{self, Standing};
use bmo_remote::settings::Settings;
use bmo_remote::store::Store;
use bmo_remote::wire::ConsoleManifest;
use serde_json::Value;

const TOKEN: &str = "console-test";

fn scratch(name: &str) -> PathBuf {
  let folder = std::env::temp_dir().join(format!("bmo-remote-console-{}-{name}", std::process::id()));
  let _ = std::fs::remove_dir_all(&folder);
  std::fs::create_dir_all(&folder).expect("the scratch folder is made");

  folder
}

/// A bundle folder as the build writes one, its module holding `module`.
fn bundle_folder(folder: &Path, module: &str) -> PathBuf {
  let bundle = folder.join("bundle");

  std::fs::create_dir_all(bundle.join("chunks")).expect("the bundle folder is made");
  std::fs::write(bundle.join("remote.js"), module).expect("the module is written");
  std::fs::write(bundle.join("remote.css"), ".remote{}").expect("the stylesheet is written");
  std::fs::write(bundle.join("chunks/backend-abc123.js"), "export default 1;")
    .expect("the chunk is written");
  std::fs::write(bundle.join("words.json"), r#"{"en":{"remote":{"title":{"remote":"Remote"}}}}"#)
    .expect("the words are written");

  bundle
}

/// The service on a loopback port of its own, answering from a scratch folder's bundle, and its address.
async fn service(name: &str) -> String {
  let folder = scratch(name);
  let bundle = bundle_folder(&folder, "export default { routes: [] };");
  let environment = HashMap::from([
    ("BMO_REMOTE_SERVER__TOKEN".to_owned(), TOKEN.to_owned()),
    ("BMO_REMOTE_SIDECAR__FOLDER".to_owned(), folder.join("no-sidecar").display().to_string()),
  ]);
  let settings = Settings::read(&folder, Some(environment)).expect("the settings are read");
  let store = Store::open(&settings.store.path).await.expect("the store opens");
  let account = Account::current().expect("the account is read");
  let sidecar = Sidecar::start(&settings, &account);
  let router = http::router(Standing::new(settings, store, account, sidecar, ConsoleBundle::load(&bundle)))
    .expect("the routes stand");
  let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("a port is taken");
  let address = format!("http://{}", listener.local_addr().expect("the port is known"));

  tokio::spawn(async move { axum::serve(listener, router).await });

  address
}

/// The manifest read through bmo-ui's `consoleManifest`, as the bundle's own script runs it.
fn read_by_bmo_ui(manifest: &Value) -> Result<Value, String> {
  let client = Path::new(env!("CARGO_MANIFEST_DIR")).join("client");
  let mut reading = Command::new("bun")
    .args(["scripts/read-manifest.ts"])
    .current_dir(client)
    .stdin(Stdio::piped())
    .stdout(Stdio::piped())
    .stderr(Stdio::piped())
    .spawn()
    .expect("bun runs the bundle's reading");

  reading
    .stdin
    .take()
    .expect("the reading takes its input")
    .write_all(manifest.to_string().as_bytes())
    .expect("the manifest is handed on");

  let read = reading.wait_with_output().expect("the reading ends");

  if read.status.success() {
    Ok(serde_json::from_slice(&read.stdout).expect("the reading prints JSON"))
  } else {
    Err(String::from_utf8_lossy(&read.stderr).into_owned())
  }
}

#[tokio::test]
async fn the_manifest_keeps_the_contract() {
  let address = service("manifest").await;
  let answered: Value = reqwest::Client::new()
    .get(format!("{address}/console-manifest"))
    .bearer_auth(TOKEN)
    .send()
    .await
    .expect("the manifest answers")
    .error_for_status()
    .expect("the manifest is answered to the token alone")
    .json()
    .await
    .expect("the manifest is JSON");
  let read = read_by_bmo_ui(&answered).expect("bmo-ui reads the manifest");

  assert_eq!(read["name"], "remote");
  assert_eq!(read["role"], "administrator");
  assert_eq!(read["ownerKey"], false);
  assert_eq!(read["events"], false);
  assert_eq!(read["websocket"], true);
  assert_eq!(read["apiPrefix"], "/");
  assert_eq!(read["pushKinds"], Value::Array(Vec::new()));

  let declared: Value = serde_json::from_str(include_str!("../client/console-bundle.json"))
    .expect("the layer pack's declaration is JSON");

  for field in ["name", "title", "icon", "screenPath", "serviceName", "events", "websocket", "pushKinds"] {
    assert_eq!(declared[field], read[field], "the declaration and the manifest differ on {field}");
  }
}

#[tokio::test]
async fn a_manifest_off_the_contract_is_refused() {
  let mut manifest = serde_json::to_value(
    ConsoleBundle::load(&bundle_folder(&scratch("refused"), "export default {};"))
      .expect("the bundle reads")
      .manifest(),
  )
  .expect("the manifest is JSON");

  manifest["role"] = Value::from("owner");

  let fault = read_by_bmo_ui(&manifest).expect_err("bmo-ui refuses the manifest");

  assert!(fault.contains("role"), "the fault names the role: {fault}");
}

#[tokio::test]
async fn the_screen_routes_refuse_a_missing_token_and_a_low_role() {
  let address = service("guard").await;
  let manifest: ConsoleManifest = RemoteClient::new(&address, TOKEN)
    .console_manifest()
    .await
    .expect("the manifest answers");
  let http = reqwest::Client::new();
  let status = |path: &str, token: Option<&str>, role: Option<&str>| {
    let mut request = http.get(format!("{address}{path}"));

    if let Some(token) = token {
      request = request.bearer_auth(token);
    }

    if let Some(role) = role {
      request = request.header(OWNER_ROLE_HEADER, role);
    }

    async move { request.send().await.expect("the service answers").status().as_u16() }
  };
  let stylesheet = manifest.stylesheet.clone().expect("the manifest names the stylesheet");

  for path in [
    "/account",
    "/terminals/t-none",
    manifest.bundle.as_str(),
    stylesheet.as_str(),
    "/console/chunks/backend-abc123.js",
  ] {
    assert_eq!(status(path, None, Some("administrator")).await, 401, "{path} without the token");
    assert_eq!(
      status(path, Some("wrong"), Some("administrator")).await,
      401,
      "{path} with a wrong token"
    );
    assert_eq!(status(path, Some(TOKEN), None).await, 403, "{path} without a role");
    assert_eq!(status(path, Some(TOKEN), Some("member")).await, 403, "{path} for a member");
    assert_eq!(
      status(path, Some(TOKEN), Some("owner")).await,
      403,
      "{path} for a role it does not know"
    );
  }

  for path in [
    manifest.bundle.as_str(),
    stylesheet.as_str(),
    "/console/chunks/backend-abc123.js",
    "/account",
  ] {
    assert_eq!(
      status(path, Some(TOKEN), Some("administrator")).await,
      200,
      "{path} for an administrator"
    );
  }

  for path in ["/console-manifest", manifest.words.as_str(), "/health"] {
    assert_eq!(status(path, None, None).await, 401, "{path} without the token");
    assert_eq!(status(path, Some(TOKEN), None).await, 200, "{path} to the token alone");
  }

  let refused = RemoteClient::new(&address, TOKEN)
    .account()
    .await
    .expect_err("the account is refused without a role");

  assert_eq!(refused.code(), Some("forbidden"));
  RemoteClient::new(&address, TOKEN)
    .with_role(ConsoleRole::Administrator)
    .account()
    .await
    .expect("the account answers an administrator");

  let words = RemoteClient::new(&address, TOKEN).console_words().await.expect("the words answer");

  assert!(words.contains_key("en"));
}

#[test]
fn the_module_path_follows_its_bytes() {
  let first = ConsoleBundle::load(&bundle_folder(&scratch("first"), "export default { routes: [1] };"))
    .expect("the first bundle reads")
    .manifest();
  let again = ConsoleBundle::load(&bundle_folder(&scratch("again"), "export default { routes: [1] };"))
    .expect("the same bundle reads")
    .manifest();
  let changed = ConsoleBundle::load(&bundle_folder(&scratch("changed"), "export default { routes: [2] };"))
    .expect("the changed bundle reads")
    .manifest();

  assert_eq!(first.bundle, again.bundle);
  assert_ne!(first.bundle, changed.bundle);
  assert!(first.bundle.starts_with("/console/remote-") && first.bundle.ends_with(".js"));
  assert_eq!(first.stylesheet, changed.stylesheet, "the stylesheet's bytes did not change");
}

#[test]
fn a_folder_without_its_module_is_no_bundle() {
  let folder = scratch("empty");

  std::fs::write(folder.join("words.json"), "{}").expect("the words are written");

  let fault = ConsoleBundle::load(&folder).expect_err("a folder without the module is no bundle");

  assert!(fault.contains("remote.js"), "the fault names the module: {fault}");
}
