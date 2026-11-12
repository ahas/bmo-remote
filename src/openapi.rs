//! The service's OpenAPI document (`docs/api.md`): every route with its parameters, its body, its answers
//! and the codes it can refuse with, and its body schemas generated from the types of `wire`. `bmo-remote
//! openapi` prints it, and the repository keeps it as `docs/openapi.json`.

use schemars::JsonSchema;
use schemars::generate::{SchemaGenerator, SchemaSettings};
use serde_json::{Map, Value, json};

use crate::http::Reader;
use crate::wire::{
  Account, Health, Terminal, TerminalPage, TerminalPaste, TerminalPasted, TerminalRename, TerminalRequest,
  TerminalsQuery, WireError,
};
use bmo_console_face::OWNER_ROLE_HEADER;

/// Where the schemas the routes refer to stand in the document.
const SCHEMAS: &str = "/components/schemas";

const DESCRIPTION: &str = "The console's remote access: terminal sessions on this machine (tmux) and the \
  desktop through RDP, relayed to a browser screen. A downstream that calls nothing. The paths carry no \
  prefix; the console relays them under its own base behind its sign-in.";

/// What a route takes as its body.
enum Body {
  Json(Value),
}

/// One route of the document.
struct Operation {
  method: &'static str,
  path: &'static str,
  id: &'static str,
  tag: &'static str,
  summary: &'static str,
  parameters: Vec<Value>,
  body: Option<Body>,
  /// The success answers, each by its status: the content by media type, or none for no body.
  answers: Vec<(u16, Option<Value>)>,
  /// Every code the route can answer beside the reader's refusal.
  codes: &'static [&'static str],
  /// Whom it answers: a reader of the screen also sends `Owner-Role`, and may be refused `forbidden`.
  reader: Reader,
}

impl Operation {
  fn value(self) -> Value {
    let mut responses = Map::new();

    for (status, content) in self.answers {
      let mut answer = json!({ "description": self.summary });

      if let Some(content) = content {
        answer["content"] = content;
      }

      responses.insert(status.to_string(), answer);
    }

    responses.insert("default".into(), json!({ "$ref": "#/components/responses/Error" }));

    let mut codes = self.codes.to_vec();
    let mut parameters = self.parameters;

    if self.reader == Reader::Screen {
      codes.insert(1, FORBIDDEN);
      parameters.insert(0, owner_role());
    }

    let mut operation = json!({
      "operationId": self.id,
      "tags": [self.tag],
      "summary": self.summary,
      "responses": responses,
      "x-codes": codes,
    });

    if !parameters.is_empty() {
      operation["parameters"] = parameters.into();
    }

    if let Some(Body::Json(schema)) = self.body {
      operation["requestBody"] =
        json!({ "required": true, "content": { "application/json": { "schema": schema } } });
    }

    operation
  }
}

/// A JSON answer of this type.
fn json_answer<Answer: JsonSchema>(generator: &mut SchemaGenerator) -> Option<Value> {
  Some(json!({ "application/json": { "schema": generator.subschema_for::<Answer>() } }))
}

/// A JSON body of this type.
fn json_body<Sent: JsonSchema>(generator: &mut SchemaGenerator) -> Option<Body> {
  Some(Body::Json(generator.subschema_for::<Sent>().to_value()))
}

/// One path parameter.
fn path_parameter(name: &str, description: &str) -> Value {
  json!({
    "name": name,
    "in": "path",
    "required": true,
    "description": description,
    "schema": { "type": "string" },
  })
}

/// The code of a call whose reader's role does not allow the screen.
const FORBIDDEN: &str = "forbidden";

/// The reader's role the console sets on every route the screen uses.
fn owner_role() -> Value {
  json!({
    "name": OWNER_ROLE_HEADER,
    "in": "header",
    "required": false,
    "description": "The reader's role, as bmo-ui's console plugin contract names it, which a call with the \
      console's credential carries and which must allow the manifest's role; the command's own token needs none.",
    "schema": { "type": "string" },
  })
}

fn terminal_id() -> Value {
  path_parameter("terminalId", "The session's id: `t-` and lower-case letters and digits.")
}

/// The query parameters of a query type, each property one parameter.
fn query<Query: JsonSchema>(generator: &mut SchemaGenerator) -> Vec<Value> {
  let schema = Query::json_schema(generator).to_value();
  let Some(properties) = schema["properties"].as_object() else {
    return Vec::new();
  };

  properties
    .iter()
    .map(|(name, property)| {
      let mut parameter = json!({ "name": name, "in": "query", "required": false, "schema": property });

      if let Some(description) = property.get("description") {
        parameter["description"] = description.clone();
      }

      parameter
    })
    .collect()
}

/// Every route the service answers, in the order `docs/api.md` lists them.
fn operations(generator: &mut SchemaGenerator) -> Vec<Operation> {
  vec![
    Operation {
      method: "get",
      path: "/health",
      id: "readHealth",
      tag: "health",
      summary: "Readiness and version.",
      parameters: Vec::new(),
      body: None,
      answers: vec![(200, json_answer::<Health>(generator))],
      codes: &["unauthorized"],
      reader: Reader::Caller,
    },
    Operation {
      method: "get",
      path: "/console-manifest",
      id: "readConsoleManifest",
      tag: "console",
      summary: "The console face's manifest, by bmo-ui's console plugin contract, to the console's credential alone.",
      parameters: Vec::new(),
      body: None,
      answers: vec![(200, Some(json!({ "application/json": { "schema": { "type": "object" } } })))],
      codes: &["unauthorized"],
      reader: Reader::Caller,
    },
    Operation {
      method: "get",
      path: "/console/{file}",
      id: "readConsoleFile",
      tag: "console",
      summary: "A file of the console bundle at the path the manifest names: the words to the console's credential \
        alone, the module, the stylesheet and every other file to it with the manifest's role.",
      parameters: vec![path_parameter(
        "file",
        "The file's path under `/console/`, as the manifest or the module names it, slashes included.",
      )],
      body: None,
      answers: vec![(
        200,
        Some(json!({
          "text/javascript": { "schema": { "type": "string" } },
          "text/css": { "schema": { "type": "string" } },
          "application/json": { "schema": { "type": "object" } },
        })),
      )],
      codes: &["unauthorized", "forbidden", "not-found"],
      reader: Reader::Caller,
    },
    Operation {
      method: "get",
      path: "/account",
      id: "readAccount",
      tag: "account",
      summary: "The desktop account and whether its password is kept.",
      parameters: Vec::new(),
      body: None,
      answers: vec![(200, json_answer::<Account>(generator))],
      codes: &["unauthorized"],
      reader: Reader::Screen,
    },
    Operation {
      method: "get",
      path: "/terminals",
      id: "listTerminals",
      tag: "terminals",
      summary: "The terminal sessions, in the order they began.",
      parameters: query::<TerminalsQuery>(generator),
      body: None,
      answers: vec![(200, json_answer::<TerminalPage>(generator))],
      codes: &["unauthorized", "bad-request", "failed"],
      reader: Reader::Screen,
    },
    Operation {
      method: "post",
      path: "/terminals",
      id: "createTerminal",
      tag: "terminals",
      summary: "Open a terminal session: the account's login shell.",
      parameters: Vec::new(),
      body: json_body::<TerminalRequest>(generator),
      answers: vec![(201, json_answer::<Terminal>(generator))],
      codes: &["unauthorized", "bad-request", "failed"],
      reader: Reader::Screen,
    },
    Operation {
      method: "get",
      path: "/terminals/{terminalId}",
      id: "readTerminal",
      tag: "terminals",
      summary: "One terminal session.",
      parameters: vec![terminal_id()],
      body: None,
      answers: vec![(200, json_answer::<Terminal>(generator))],
      codes: &["unauthorized", "not-found", "failed"],
      reader: Reader::Screen,
    },
    Operation {
      method: "patch",
      path: "/terminals/{terminalId}",
      id: "renameTerminal",
      tag: "terminals",
      summary: "Rename a terminal session; an empty title takes the name away.",
      parameters: vec![terminal_id()],
      body: json_body::<TerminalRename>(generator),
      answers: vec![(200, json_answer::<Terminal>(generator))],
      codes: &["unauthorized", "bad-request", "not-found", "failed"],
      reader: Reader::Screen,
    },
    Operation {
      method: "delete",
      path: "/terminals/{terminalId}",
      id: "endTerminal",
      tag: "terminals",
      summary: "End a terminal session and every program in it.",
      parameters: vec![terminal_id()],
      body: None,
      answers: vec![(204, None)],
      codes: &["unauthorized", "not-found", "failed"],
      reader: Reader::Screen,
    },
    Operation {
      method: "post",
      path: "/terminals/{terminalId}/pastes",
      id: "pasteTerminal",
      tag: "terminals",
      summary: "Keep a picture pasted into a terminal session as a file on this machine.",
      parameters: vec![terminal_id()],
      body: json_body::<TerminalPaste>(generator),
      answers: vec![(201, json_answer::<TerminalPasted>(generator))],
      codes: &["unauthorized", "bad-request", "not-found", "failed"],
      reader: Reader::Screen,
    },
    Operation {
      method: "get",
      path: "/terminals/{terminalId}/socket",
      id: "attachTerminal",
      tag: "terminals",
      summary: "Attach to a terminal: a WebSocket, both sides speaking.",
      parameters: vec![terminal_id()],
      body: None,
      answers: vec![(101, None)],
      codes: &["unauthorized", "not-found", "failed"],
      reader: Reader::Screen,
    },
    Operation {
      method: "get",
      path: "/desktop/socket",
      id: "relayDesktop",
      tag: "desktop",
      summary: "The desktop's RDP relay: a WebSocket.",
      parameters: Vec::new(),
      body: None,
      answers: vec![(101, None)],
      codes: &["unauthorized"],
      reader: Reader::Screen,
    },
    Operation {
      method: "get",
      path: "/desktop/pointer",
      id: "readDesktopPointer",
      tag: "desktop",
      summary: "The desktop's pointer messages: a WebSocket.",
      parameters: Vec::new(),
      body: None,
      answers: vec![(101, None)],
      codes: &["unauthorized"],
      reader: Reader::Screen,
    },
    Operation {
      method: "get",
      path: "/desktop/keys",
      id: "readDesktopKeys",
      tag: "desktop",
      summary: "The desktop's keyboard messages: a WebSocket.",
      parameters: Vec::new(),
      body: None,
      answers: vec![(101, None)],
      codes: &["unauthorized"],
      reader: Reader::Screen,
    },
  ]
}

/// The service's OpenAPI document.
pub fn openapi() -> Value {
  let mut generator = SchemaSettings::draft2020_12()
    .for_serialize()
    .with(|settings| {
      settings.definitions_path = SCHEMAS.into();
      settings.meta_schema = None;
    })
    .into_generator();
  let error = generator.subschema_for::<WireError>();
  let mut tags: Vec<&str> = Vec::new();
  let mut paths = Map::new();

  for operation in operations(&mut generator) {
    if !tags.contains(&operation.tag) {
      tags.push(operation.tag);
    }

    let (path, method) = (operation.path, operation.method);

    paths.entry(path).or_insert_with(|| json!({}))[method] = operation.value();
  }

  json!({
    "openapi": "3.1.0",
    "info": { "title": "bmo-remote", "version": env!("CARGO_PKG_VERSION"), "description": DESCRIPTION },
    "servers": [{ "url": "/", "description": "the remote service" }],
    "security": [{ "bearer": [] }],
    "x-layer": "downstream",
    "x-stage": 5,
    "x-calls": [],
    "tags": tags.iter().map(|tag| json!({ "name": tag })).collect::<Vec<_>>(),
    "paths": paths,
    "components": {
      "schemas": generator.take_definitions(true),
      "responses": {
        "Error": {
          "description": "A refusal, in the common error shape.",
          "content": { "application/json": { "schema": error } },
        },
      },
      "securitySchemes": {
        "bearer": {
          "type": "http",
          "scheme": "bearer",
          "description": "The console's credential, or the service's own token (docs/api.md, Conventions).",
        },
      },
    },
    "x-tools": [],
  })
}

/// The document as the repository keeps it: two-space indented JSON with a closing newline.
pub fn openapi_json() -> String {
  let mut text = serde_json::to_string_pretty(&openapi()).unwrap_or_default();

  text.push('\n');
  text
}
