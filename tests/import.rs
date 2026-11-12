//! The old archive's kept desktop port moved into the store (TODO #1923): the key's mapping, the empty
//! export as a documented no-op, the refusal of a store already holding rows, and the dry run.

use std::path::Path;

use bmo_remote::import::{self, KEPT_KEY};
use bmo_remote::store::Store;

use crate::scratch::Scratch;

fn export(folder: &Path, lines: &[&str]) {
  let said = format!(
    r#"{{"snapshot":"1:2:","readAt":"2026-10-21T17:00:00+09:00","tables":[{{"source":"settings","file":"settings.ndjson","count":{},"key":["key"]}}]}}"#,
    lines.len()
  );
  std::fs::write(folder.join("manifest.json"), said).expect("the manifest is written");
  std::fs::write(folder.join("settings.ndjson"), lines.join("\n") + "\n").expect("the rows are written");
}

#[tokio::test]
async fn the_desktop_port_is_kept_under_its_new_key() {
  let scratch = Scratch::new("import", "kept");
  let folder = scratch.path();
  export(folder, &[r#"{"key":"remote_desktop_port","value":"3390","rowid":1}"#]);

  let store = folder.join("remote.db");
  let report = import::run(&store, folder, false).await.expect("the import runs");
  assert_eq!(report.tables[0].written, 1);
  assert_eq!(report.sample.checked, 1);
  assert_eq!(report.sample.failures, Vec::<String>::new());

  let opened = Store::open(&store).await.expect("the store opens");
  let held: String = sqlx::query_scalar("SELECT value FROM kept_values WHERE key = ?1")
    .bind(KEPT_KEY)
    .fetch_one(opened.pool())
    .await
    .expect("the value is read");
  assert_eq!(held, "3390");
}

#[tokio::test]
async fn the_live_export_is_a_documented_no_op() {
  let scratch = Scratch::new("import", "empty");
  let folder = scratch.path();
  export(folder, &[]);

  let store = folder.join("remote.db");
  let report = import::run(&store, folder, false).await.expect("the import runs");
  assert_eq!(report.tables[0].exported, 0);
  assert_eq!(report.tables[0].written, 0);
  assert_eq!(report.sample.checked, 0);
  assert!(report.lines().iter().any(|line| line.contains("documented no-op")));
}

#[tokio::test]
async fn a_row_of_another_key_stops_the_import() {
  let scratch = Scratch::new("import", "other");
  let folder = scratch.path();
  export(folder, &[r#"{"key":"mode","value":"live","rowid":1}"#]);

  let store = folder.join("remote.db");
  let refused = import::run(&store, folder, false).await.expect_err("the row stops it");
  assert!(refused.contains("remote_desktop_port"), "{refused}");
}

#[tokio::test]
async fn a_dry_run_writes_nothing() {
  let scratch = Scratch::new("import", "dry");
  let folder = scratch.path();
  export(folder, &[r#"{"key":"remote_desktop_port","value":"3390","rowid":1}"#]);

  let store = folder.join("remote.db");
  import::run(&store, folder, true).await.expect("the dry run runs");

  let opened = Store::open(&store).await.expect("the store opens");
  let held: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM kept_values")
    .fetch_one(opened.pool())
    .await
    .expect("the count is read");
  assert_eq!(held, 0);
}

#[tokio::test]
async fn a_store_holding_a_value_is_refused() {
  let scratch = Scratch::new("import", "refuse");
  let folder = scratch.path();
  export(folder, &[r#"{"key":"remote_desktop_port","value":"3390","rowid":1}"#]);

  let store = folder.join("remote.db");
  import::run(&store, folder, false).await.expect("the first import runs");
  let refused = import::run(&store, folder, false).await.expect_err("the second is refused");
  assert!(refused.contains("already holds rows"), "{refused}");
}
