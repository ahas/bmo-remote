//! The old archive's kept values moved into this service's store (docs/api.md, 「The store」, and the
//! migration plan's table map for TODO #1923): one export directory read, this store written, nothing else
//! touched.
//!
//! The export is the one the item's export hand wrote under
//! `workbench/worker/items/1923/exports/remote/`: `manifest.json` with the source table's exact count and
//! key, and one NDJSON file for it. The only key this unit takes is `remote_desktop_port`, kept here as
//! `desktop_port`. The live census holds no such row, so a run over the live export is a documented
//! no-op that still refuses a target already holding rows and still proves its count-and-sample compare.

use std::collections::HashMap;
use std::path::Path;

use serde_json::Value;
use sqlx::sqlite::SqlitePool;

use crate::store::Store;

/// The old key this unit takes, and the key it is kept under here.
pub const SOURCE_KEY: &str = "remote_desktop_port";
pub const KEPT_KEY: &str = "desktop_port";

/// The target table.
pub const TARGET: &str = "kept_values";

/// One export table's entry in the manifest.
#[derive(Clone, Debug)]
pub struct TableEntry {
  pub file: String,
  pub count: u64,
  pub key: Vec<String>,
}

/// The export directory's manifest.
#[derive(Clone, Debug)]
pub struct Manifest {
  pub snapshot: String,
  pub read_at: String,
  pub tables: HashMap<String, TableEntry>,
}

/// One value written to the store.
#[derive(Clone, Debug, PartialEq)]
pub struct Kept {
  pub key: String,
  pub value: String,
}

/// One table of the report.
#[derive(Clone, Debug, PartialEq)]
pub struct Moved {
  pub source: String,
  pub exported: u64,
  pub written: u64,
}

/// What an import run did.
#[derive(Clone, Debug, PartialEq)]
pub struct Report {
  pub dry_run: bool,
  pub snapshot: String,
  pub read_at: String,
  pub tables: Vec<Moved>,
  pub sample: Sample,
}

impl Report {
  /// The report as the command prints it.
  pub fn lines(&self) -> Vec<String> {
    let mut lines = vec![format!(
      "{} at snapshot {}:",
      if self.dry_run { "dry run" } else { "import" },
      self.snapshot
    )];
    for table in &self.tables {
      lines.push(format!("  {}: {} exported, {} written", table.source, table.exported, table.written));
    }
    lines.push(format!("{} rows sampled, {} failures", self.sample.checked, self.sample.failures.len()));
    lines.extend(self.sample.failures.iter().map(|failure| format!("  {failure}")));
    if self.sample.checked == 0 && self.sample.failures.is_empty() {
      lines.push("  the export is empty: a documented no-op".to_owned());
    }

    lines
  }
}

/// The count-and-sample compare's result.
#[derive(Clone, Debug, PartialEq)]
pub struct Sample {
  pub checked: usize,
  pub failures: Vec<String>,
}

/// One source row written in this store's shape, or none where the key is not this unit's.
pub fn kept(row: &Value) -> Option<Kept> {
  let key = row.get("key").and_then(Value::as_str)?;
  if key != SOURCE_KEY {
    return None;
  }
  let value = match row.get("value") {
    None | Some(Value::Null) => return None,
    Some(Value::String(said)) => said.clone(),
    Some(Value::Number(number)) => number.to_string(),
    Some(Value::Bool(flag)) => flag.to_string(),
    Some(other) => other.to_string(),
  };

  Some(Kept {
    key: KEPT_KEY.to_owned(),
    value,
  })
}

/// The export directory's manifest.
pub fn read_manifest(dir: &Path) -> Result<Manifest, String> {
  let path = dir.join("manifest.json");
  let said = std::fs::read_to_string(&path)
    .map_err(|error| format!("{} could not be read: {error}", path.display()))?;
  let document: Value =
    serde_json::from_str(&said).map_err(|error| format!("{} is not JSON: {error}", path.display()))?;
  let mut tables = HashMap::new();
  let list = document.get("tables").and_then(Value::as_array).ok_or("the manifest names no tables")?;
  for table in list {
    let source = table
      .get("source")
      .and_then(Value::as_str)
      .ok_or("a manifest table names no source")?
      .to_owned();
    let file = table
      .get("file")
      .and_then(Value::as_str)
      .ok_or("a manifest table names no file")?
      .to_owned();
    let count = table.get("count").and_then(Value::as_u64).ok_or("a manifest table names no count")?;
    let key: Vec<String> = table
      .get("key")
      .and_then(Value::as_array)
      .map(|keys| keys.iter().filter_map(Value::as_str).map(str::to_owned).collect())
      .unwrap_or_default();
    tables.insert(source, TableEntry { file, count, key });
  }

  Ok(Manifest {
    snapshot: document.get("snapshot").and_then(Value::as_str).unwrap_or_default().to_owned(),
    read_at: document.get("readAt").and_then(Value::as_str).unwrap_or_default().to_owned(),
    tables,
  })
}

/// The settings rows the export holds, checked against the manifest's count.
pub fn rows(dir: &Path, manifest: &Manifest) -> Result<Vec<Value>, String> {
  let entry = manifest.tables.get("settings").ok_or("the manifest has no table settings")?;
  let path = dir.join(&entry.file);
  let said = std::fs::read_to_string(&path)
    .map_err(|error| format!("{} could not be read: {error}", path.display()))?;
  let mut out = Vec::new();
  for (number, line) in said.lines().enumerate() {
    if line.trim().is_empty() {
      continue;
    }
    let row: Value = serde_json::from_str(line)
      .map_err(|error| format!("{} line {} is not JSON: {error}", path.display(), number + 1))?;
    out.push(row);
  }
  if out.len() as u64 != entry.count {
    return Err(format!(
      "{}: the manifest says {} rows and the file holds {}",
      path.display(),
      entry.count,
      out.len()
    ));
  }

  Ok(out)
}

/// Refuses a store that already holds a kept value.
pub async fn refused_if_holding(pool: &SqlitePool) -> Result<(), String> {
  let count: i64 = sqlx::query_scalar(&format!("SELECT COUNT(*) FROM \"{TARGET}\""))
    .fetch_one(pool)
    .await
    .map_err(|error| format!("{TARGET} could not be counted: {error}"))?;
  if count > 0 {
    Err(format!(
      "the store already holds rows of its table, so nothing was written: {TARGET} holds {count}"
    ))
  } else {
    Ok(())
  }
}

/// Runs the import: reads the export, refuses a store holding rows, writes every row, and compares what it
/// wrote. A dry run rolls the transaction back and reports what would have been written.
pub async fn run(database: &Path, export: &Path, dry_run: bool) -> Result<Report, String> {
  let manifest = read_manifest(export)?;
  let old = rows(export, &manifest)?;
  let kept: Vec<Kept> = old.iter().filter_map(kept).collect();

  // A row of the settings table that is not this unit's key is a shape this import does not know: the
  // export's filter should have kept it out, so it is a stop rather than a silent drop.
  if kept.len() != old.len() {
    return Err(format!(
      "the export holds {} settings rows and {} are the key {SOURCE_KEY}",
      old.len(),
      kept.len()
    ));
  }

  // The repository's own migrations, run over the store before anything is read into it.
  let store = Store::open(database).await.map_err(|error| error.to_string())?;
  refused_if_holding(store.pool()).await?;

  let mut tx = store
    .pool()
    .begin()
    .await
    .map_err(|error| format!("the transaction could not be opened: {error}"))?;
  for row in &kept {
    sqlx::query("INSERT INTO kept_values (key, value) VALUES (?1, ?2)")
      .bind(&row.key)
      .bind(&row.value)
      .execute(&mut *tx)
      .await
      .map_err(|error| format!("{TARGET} could not be written: {error}"))?;
  }
  if dry_run {
    tx.rollback()
      .await
      .map_err(|error| format!("the dry run could not be rolled back: {error}"))?;
  } else {
    tx.commit()
      .await
      .map_err(|error| format!("the import could not be committed: {error}"))?;
  }

  let sample = if dry_run {
    Sample {
      checked: 0,
      failures: Vec::new(),
    }
  } else {
    compare(store.pool(), &manifest, &kept).await
  };

  let tables = vec![Moved {
    source: "settings".to_owned(),
    exported: manifest.tables.get("settings").map(|entry| entry.count).unwrap_or(0),
    written: kept.len() as u64,
  }];

  Ok(Report {
    dry_run,
    snapshot: manifest.snapshot.clone(),
    read_at: manifest.read_at.clone(),
    tables,
    sample,
  })
}

async fn compare(pool: &SqlitePool, manifest: &Manifest, kept: &[Kept]) -> Sample {
  let mut failures = Vec::new();
  let mut checked = 0;

  match sqlx::query_scalar::<_, i64>(&format!("SELECT COUNT(*) FROM \"{TARGET}\""))
    .fetch_one(pool)
    .await
  {
    Ok(held) => match manifest.tables.get("settings") {
      Some(entry) if held as u64 == entry.count => {}
      Some(entry) => {
        failures.push(format!("settings: the export holds {} rows and {TARGET} holds {held}", entry.count))
      }
      None => failures.push("settings: the export records no table".to_owned()),
    },
    Err(error) => failures.push(format!("{TARGET} could not be counted: {error}")),
  }

  for row in kept {
    checked += 1;
    let held: Option<String> = sqlx::query_scalar("SELECT value FROM kept_values WHERE key = ?1")
      .bind(&row.key)
      .fetch_optional(pool)
      .await
      .ok()
      .flatten();
    if held.as_deref() != Some(row.value.as_str()) {
      failures.push(format!("settings: {} was written {held:?} but is {}", row.key, row.value));
    }
  }

  Sample { checked, failures }
}
