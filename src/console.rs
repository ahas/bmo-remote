//! The console plugin bundle as the service answers it (`docs/api.md`, 「The console bundle's routes」):
//! the manifest a console attaches the remote screen by, the bundle's files read from the folder its build
//! writes, and the guard every route the screen uses stands behind, the reader's role the console sets.

use std::collections::BTreeMap;
use std::path::Path;

use axum::http::header::{CACHE_CONTROL, CONTENT_TYPE};
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::http::{Call, Reader, Refused, Route, answer};
use crate::wire::ConsoleManifest;

/// The header the console sets the reader's role in, in place of any the browser sent.
pub const OWNER_ROLE_HEADER: &str = "Owner-Role";
/// The code of a call whose reader's role does not allow the screen.
pub const FORBIDDEN: &str = "forbidden";

/// Where the bundle's files are answered, from the service's root.
const FILES: &str = "/console/";
/// The module's file as the build writes it.
const MODULE: &str = "remote.js";
/// The stylesheet's file as the build writes it.
const STYLESHEET: &str = "remote.css";
/// The words' file as the build writes it, answered at its own name.
const WORDS: &str = "words.json";
/// How many hexadecimal digits of a file's digest its path carries.
const DIGEST_DIGITS: usize = 16;

/// A role a reader holds, the one holding more first: an administrator holds every role a member holds.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum ConsoleRole {
  Administrator,
  Member,
}

impl ConsoleRole {
  /// The role a header names, where it names one.
  pub fn named(name: &str) -> Option<Self> {
    match name {
      "administrator" => Some(Self::Administrator),
      "member" => Some(Self::Member),
      _ => None,
    }
  }

  /// The role's name as the header and the manifest write it.
  pub fn name(self) -> &'static str {
    match self {
      Self::Administrator => "administrator",
      Self::Member => "member",
    }
  }

  /// Whether a reader holding this role may open a screen needing `needed`.
  pub fn allows(self, needed: Self) -> bool {
    self <= needed
  }
}

/// The least role a reader holds to open the remote screen: the terminals and the desktop are the machine's
/// own.
pub const SCREEN_ROLE: ConsoleRole = ConsoleRole::Administrator;

/// Whether the reader a call is handed on for may use the screen's routes: its `Owner-Role` allows the
/// screen's role; a missing role, or one the service does not know, does not.
pub fn admit(headers: &HeaderMap) -> Result<(), Refused> {
  let held = headers.get(OWNER_ROLE_HEADER).and_then(|value| value.to_str().ok());

  match held.map(|name| (name, ConsoleRole::named(name))) {
    None => Err(Refused::new(
      StatusCode::FORBIDDEN,
      FORBIDDEN,
      format!("the call carries no {OWNER_ROLE_HEADER}"),
    )),
    Some((name, None)) => Err(Refused::new(
      StatusCode::FORBIDDEN,
      FORBIDDEN,
      format!("{OWNER_ROLE_HEADER} names no role the service knows: {name}"),
    )),
    Some((_, Some(role))) if !role.allows(SCREEN_ROLE) => Err(Refused::new(
      StatusCode::FORBIDDEN,
      FORBIDDEN,
      format!(
        "the role {} does not allow the remote screen, which needs {}",
        role.name(),
        SCREEN_ROLE.name()
      ),
    )),
    Some(_) => Ok(()),
  }
}

/// One file of the bundle as it is answered.
#[derive(Clone, Debug)]
struct BundleFile {
  bytes: Vec<u8>,
  content_type: &'static str,
}

impl BundleFile {
  fn read(path: &Path) -> Result<Self, String> {
    let bytes =
      std::fs::read(path).map_err(|why| format!("{} could not be read: {why}", path.display()))?;
    let content_type = match path.extension().and_then(|extension| extension.to_str()) {
      Some("js") => "text/javascript; charset=utf-8",
      Some("css") => "text/css; charset=utf-8",
      Some("json") => "application/json",
      _ => "application/octet-stream",
    };

    Ok(Self {
      bytes,
      content_type,
    })
  }
}

/// The bundle as the build wrote it, each file under the path it is answered at.
#[derive(Clone, Debug)]
pub struct ConsoleBundle {
  /// Every file but the words, by its path under `/console/`.
  files: BTreeMap<String, BundleFile>,
  words: BundleFile,
  /// The module's path, from the service's root.
  module: String,
  /// The stylesheet's path, from the service's root, where the build wrote one.
  stylesheet: Option<String>,
}

impl ConsoleBundle {
  /// The bundle in `folder`, read whole: the module and the stylesheet under paths their bytes name, the
  /// words at their own name and every other file at its path in the folder.
  pub fn load(folder: &Path) -> Result<Self, String> {
    let mut found = BTreeMap::new();

    gather(folder, "", &mut found)?;

    let words = found
      .remove(WORDS)
      .ok_or_else(|| format!("the console bundle in {} holds no {WORDS}", folder.display()))?;
    let module = found
      .remove(MODULE)
      .ok_or_else(|| format!("the console bundle in {} holds no {MODULE}", folder.display()))?;
    let stylesheet = found.remove(STYLESHEET);
    let mut files = found;
    let module_path = named_by_bytes(MODULE, &module.bytes);

    files.insert(module_path.clone(), module);

    let stylesheet_path = stylesheet.map(|stylesheet| {
      let path = named_by_bytes(STYLESHEET, &stylesheet.bytes);

      files.insert(path.clone(), stylesheet);
      path
    });

    Ok(Self {
      files,
      words,
      module: format!("{FILES}{module_path}"),
      stylesheet: stylesheet_path.map(|path| format!("{FILES}{path}")),
    })
  }

  /// The manifest the remote screen is attached by (`docs/api.md`, 「The console bundle's routes」).
  pub fn manifest(&self) -> ConsoleManifest {
    ConsoleManifest {
      name: "remote".to_owned(),
      title: "remote.title.remote".to_owned(),
      icon: "i-material-symbols-devices-outline".to_owned(),
      screen_path: "/remote".to_owned(),
      service_name: "remote".to_owned(),
      bundle: self.module.clone(),
      stylesheet: self.stylesheet.clone(),
      words: format!("{FILES}{WORDS}"),
      api_prefix: "/".to_owned(),
      role: SCREEN_ROLE,
      owner_key: false,
      events: false,
      websocket: true,
      push_kinds: Vec::new(),
    }
  }

  /// The file answered at `path` under `/console/`, where the bundle holds one.
  fn file(&self, path: &str) -> Option<&BundleFile> {
    self.files.get(path)
  }
}

/// Every file under `folder`, by its path below `prefix` with `/` between the folders.
fn gather(folder: &Path, prefix: &str, found: &mut BTreeMap<String, BundleFile>) -> Result<(), String> {
  let entries =
    std::fs::read_dir(folder).map_err(|why| format!("{} could not be read: {why}", folder.display()))?;

  for entry in entries {
    let entry = entry.map_err(|why| format!("{} could not be read: {why}", folder.display()))?;
    let Ok(name) = entry.file_name().into_string() else {
      continue;
    };
    let path = entry.path();
    let named = format!("{prefix}{name}");

    if path.is_dir() {
      gather(&path, &format!("{named}/"), found)?;
    } else {
      found.insert(named, BundleFile::read(&path)?);
    }
  }

  Ok(())
}

/// A file's name with the start of its bytes' SHA-256 before its extension: `remote.js` to
/// `remote-<digest>.js`.
pub fn named_by_bytes(name: &str, bytes: &[u8]) -> String {
  let digest: String = Sha256::digest(bytes)
    .iter()
    .map(|byte| format!("{byte:02x}"))
    .collect::<String>()
    .chars()
    .take(DIGEST_DIGITS)
    .collect();

  match name.rsplit_once('.') {
    Some((stem, extension)) => format!("{stem}-{digest}.{extension}"),
    None => format!("{name}-{digest}"),
  }
}

/// The bundle the service read as it started, or why it could not.
fn bundle(call: &Call) -> Result<&ConsoleBundle, String> {
  call.standing().console.as_ref().as_ref().map_err(Clone::clone)
}

/// A file's bytes under its type, kept for as long as `cache` says.
fn file_answer(file: &BundleFile, cache: &'static str) -> Response {
  (
    StatusCode::OK,
    [
      (CONTENT_TYPE, HeaderValue::from_static(file.content_type)),
      (CACHE_CONTROL, HeaderValue::from_static(cache)),
    ],
    file.bytes.clone(),
  )
    .into_response()
}

/// The manifest, to the console's own credential with no role.
pub struct ConsoleManifestRoute;

impl Route for ConsoleManifestRoute {
  const METHOD: Method = Method::GET;
  const PATH: &'static str = "/console-manifest";
  const READER: Reader = Reader::Caller;

  async fn answer(&self, call: Call) -> Result<Response, Refused> {
    let manifest = bundle(&call).map_err(Refused::failed)?.manifest();
    let mut answered = answer(StatusCode::OK, manifest);

    answered.headers_mut().insert(CACHE_CONTROL, HeaderValue::from_static("no-cache"));

    Ok(answered)
  }
}

crate::route!(ConsoleManifestRoute);

/// The bundle's words, to the console's own credential with no role.
pub struct ConsoleWords;

impl Route for ConsoleWords {
  const METHOD: Method = Method::GET;
  const PATH: &'static str = "/console/words.json";
  const READER: Reader = Reader::Caller;

  async fn answer(&self, call: Call) -> Result<Response, Refused> {
    let bundle = bundle(&call).map_err(Refused::not_found)?;

    Ok(file_answer(&bundle.words, "no-cache"))
  }
}

crate::route!(ConsoleWords);

/// A file of the module: the module, its stylesheet or a chunk it imports, behind the screen's guard.
pub struct ConsoleFile;

impl Route for ConsoleFile {
  const METHOD: Method = Method::GET;
  const PATH: &'static str = "/console/{*file}";

  async fn answer(&self, mut call: Call) -> Result<Response, Refused> {
    let path = call.path_param("file").await?;
    let bundle = bundle(&call).map_err(Refused::not_found)?;
    let file = bundle
      .file(&path)
      .ok_or_else(|| Refused::not_found(format!("the console bundle holds no {path}")))?;

    Ok(file_answer(file, "private, max-age=31536000, immutable"))
  }
}

crate::route!(ConsoleFile);
