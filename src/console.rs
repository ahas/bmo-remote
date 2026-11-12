//! The console face the service serves (`docs/api.md`, 「The console face」), through bmo-chat's
//! `bmo-console-face`: the remote screen's declaration of the manifest fields it decides, over the bundle
//! build's folder, guarded by the console's credential.

use std::path::Path;

use bmo_console_face::{BundleFolder, ConsoleFace, ConsoleFaceError};

/// The manifest fields the remote screen decides, as bmo-ui's console plugin contract names them.
pub const DECLARATION: &str = include_str!("console.json");

// What the bundle's build writes into its folder.
const MODULE_FILE: &str = "remote.js";
const STYLESHEET_FILE: &str = "remote.css";
const WORDS_FILE: &str = "words.json";

/// The face over the bundle built into `folder`, guarded by `credential`, or why it cannot be served. An
/// empty credential would let no console in, so it stands no face.
pub fn face(folder: &Path, credential: &str) -> Result<ConsoleFace, String> {
  if credential.is_empty() {
    return Err("no console credential is set".to_owned());
  }

  let bundle = BundleFolder::new(folder, MODULE_FILE, WORDS_FILE).with_stylesheet(STYLESHEET_FILE);

  ConsoleFace::new(DECLARATION, &bundle, credential).map_err(|why: ConsoleFaceError| why.to_string())
}
