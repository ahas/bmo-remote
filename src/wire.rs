//! The service's wire: every body and query a route takes or answers, in the common wire format
//! (`docs/api.md`, 「Conventions」). The routes answer with these types, the client sends and reads them, and
//! the OpenAPI document is generated from their schemas, so the three cannot drift apart.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// Whether the service is ready, why not where it is not, and its version.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Health {
  /// The store is open and the service answers.
  pub ready: bool,
  /// Why it is not ready; null while it is.
  pub reason: Option<String>,
  pub version: String,
}

/// A failure, in the common error shape: the kebab-case code a caller matches on, and the English sentence
/// for a log.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct WireError {
  pub code: String,
  pub error: String,
}

/// The account the service runs as, and whether the desktop's password is kept.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Account {
  /// The account's name, which the terminal and the desktop are reached as.
  pub name: String,
  /// Whether `desktop.password` is set and not empty.
  pub kept_password: bool,
}

/// Where a terminal session stands in its life. The list holds the sessions that stand, so every member it
/// answers is `running`; an ended session is gone from the list.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum TerminalState {
  Running,
}

/// One terminal session of the service's tmux server.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Terminal {
  /// The session's id: `t-` and lower-case letters and digits.
  pub id: String,
  /// What a person names it, empty where it has no name.
  pub title: String,
  pub state: TerminalState,
  /// When it began, in epoch milliseconds.
  pub created_at: i64,
}

/// A page of terminal sessions, in the order they began.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TerminalPage {
  pub items: Vec<Terminal>,
  /// Whether anything stands past the last item.
  pub more: bool,
}

/// The query of `GET /terminals`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TerminalsQuery {
  /// How many sessions were already read.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub after: Option<u64>,
  /// How many to read, 100 where none is given and at most 1000.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub limit: Option<u64>,
}

/// The body of `POST /terminals`: the name the new session takes, where one is given.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TerminalRequest {
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub title: Option<String>,
}

/// The body of `PATCH /terminals/{terminalId}`: the name the session takes, an empty one taking it away.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TerminalRename {
  pub title: String,
}
