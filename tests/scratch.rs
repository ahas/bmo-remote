//! A test's own folder under the system's temporary folder, shared by every file of tests that writes one.

use std::path::{Path, PathBuf};

/// A test's own folder, made empty when the test takes it and removed with everything in it when the test
/// ends, whether the test passes or panics.
pub struct Scratch(PathBuf);

impl Scratch {
  /// The folder `bmo-remote-<area>-<process>-<name>`: the area is the file of tests, the name the test.
  pub fn new(area: &str, name: &str) -> Self {
    let folder = std::env::temp_dir().join(format!("bmo-remote-{area}-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&folder);
    std::fs::create_dir_all(&folder).expect("the scratch folder is made");

    Self(folder)
  }

  pub fn path(&self) -> &Path {
    &self.0
  }
}

impl Drop for Scratch {
  fn drop(&mut self) {
    let _ = std::fs::remove_dir_all(&self.0);
  }
}
