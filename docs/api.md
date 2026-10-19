# The remote service's boundary

Every route and socket this service answers, its command, its store, its settings, the console plugin bundle
it ships and what the console in front of it does. This document is the contract other units match: bmo-web,
whose console hands the remote screen's requests on to these routes and extends the bundle; bmo-cli, which
runs the command; and the switch-over, which points the console at this service. What the terminal and the
desktop do is `docs/remote.md`, and the screen is `docs/screen.md`; this document says how they are asked. A
change to anything here changes this document in the same commit and follows the version rule (「Versions」).

## Conventions

- **Every route but `GET /health` needs `Authorization: Bearer <token>`,** the token of the settings, a
  websocket upgrade included; a missing or wrong token is answered 401 `unauthorized`, and an upgrade is
  refused so before it is taken. The console presents the token on every request it hands on.
- **Bodies are JSON, both ways, with field names in camelCase.**
- **Times are Unix milliseconds.**
- **A refusal** is a non-2xx answer whose body carries an English sentence under `error` and a snake_case
  code under `code` (「Refusals」). The sentence is for a log; a screen shows the code in its own language's
  words. A refusal that names its cause carries it as an English sentence under `reason`.
- **An upgrade to a path under `/api/remote/` that no socket claims** is refused 404 `not_found`.

## Who checks what

| Check | Where it stands |
|---|---|
| the console's sign-in, on every route and every upgrade | the console (「What the console does」) |
| the `Origin` of a websocket upgrade against the host it was sent to, or the forwarded host behind the proxy, refused 403 | the console |
| the bearer token | this service |
| reachable from this machine alone | this service's settings: `server.listen` is a loopback address |

## Health

`GET /health` answers `pid`, `version` and `ready`: the store is open and migrated.

## The account

| Method and path | Sends | Answers |
|---|---|---|
| `GET /api/remote/account` | | `account`: the name of the account the service runs as, which the terminal and the desktop are reached as; `keptPassword`: whether `desktop.password` is set and not empty |

The password itself is never answered.

## Terminal sessions

| Method and path | Sends | Answers |
|---|---|---|
| `GET /api/remote/terminals` | | `terminals`: every session on the service's tmux socket, in the order they began |
| `POST /api/remote/terminals` | `label?`, a string | `terminal`: the new session, the account's login shell |
| `PATCH /api/remote/terminals/{id}` | `label`, a string; an empty one takes the label away | `terminal`: the session renamed |
| `DELETE /api/remote/terminals/{id}` | | `ended`: true, the session and every program in it ended |

- **A session** is `id` (`t-` and lower-case letters and digits), `label` (at most 80 characters, empty where
  none), `createdAt` and `attached` (how many viewers are attached).
- **A body that is not JSON** is read as no body.

## The terminal socket

`/api/remote/terminals/{id}/socket`, a websocket: one tmux attach client for the session, for as long as the
socket is open (`docs/remote.md`, 「The terminal socket」).

- **The query:** `cols` and `rows`, the first size; 80 and 24 where either is missing or not a number.
- **From the service:** binary frames are the terminal's output, gathered for at most 30 ms or 16 KiB; text
  frames are JSON control messages.
- **From the browser:** every frame binary, its first byte `0` for typed bytes after it or `1` for a JSON
  control message in UTF-8 after it; any other first byte is ignored.

| Message | Direction | Fields |
|---|---|---|
| `resize` | browser to service | `cols`, `rows` |
| `ready` | service to browser | `id`, `cols`, `rows` |
| `exit` | service to browser | none: the session ended |
| `error` | service to browser | `code` and an English `message`, and `reason` where the code names one |

| Close code | When | The `error` sent before it |
|---|---|---|
| 1000 | the session ended, after `exit` | none |
| 4404 | the id is not a session's | `no_terminal_session` |
| 4500 | the attach client could not start | `attach_failed_because`, with `reason` |
| 4500 | the attach client ended while the session stands | `terminal_disconnected` |

## The desktop sockets

Three websockets per desktop connection, tied by a pointer channel: a name the page makes up for one
connection, `[a-z0-9]{8,40}`, sent in each socket's `pointer` query (`docs/remote.md`, 「The relay」,
「The pointer」, 「The on-screen keyboard」).

### `/api/remote/desktop/socket`

The RDCleanPath relay, binary frames both ways.

- **The query:** `quality`, one of `fast`, `balanced` and `sharp`, the performance flags the logon packet is
  given (any other leaves the client's own); `pointer`, the connection's channel, which may be missing.
- **The first frame** is the RDCleanPath request; frames before the answer are dropped. The answer is the
  RDCleanPath response — the server's X.224 confirm, its leaf certificate and the server address — or an
  RDCleanPath error:

| RDCleanPath error | When |
|---|---|
| general error, HTTP status 400 | the request cannot be read |
| general error, HTTP status 401 | the desktop refused the credentials |
| general error, WSA 10061 | the desktop did not accept the connection |
| general error, WSA 10060 | a step stood longer than eight seconds |
| negotiation error | no confirm, a malformed one, or a TLS handshake that failed or showed no certificate |

- **After the response** every byte is relayed both ways as it came, but for the logon packet's rewrite
  (`docs/remote.md`, 「Credentials」, 「Connection settings」).
- **It closes 1000** after an RDCleanPath error, when the desktop's side ends, and when the desktop redirects
  the connection, after telling the pointer channel.

### `/api/remote/desktop/pointer`

Text frames from the service alone, each one JSON message for the channel its `pointer` query names. A missing
or invalid channel closes the socket at once, 1008.

| Message | Fields |
|---|---|
| `hidden` | none: no cursor |
| `default` | none: the browser's own arrow |
| `cached` | `index`: the shape kept under that index |
| `image` | `index`, `width`, `height`, `x` and `y` (the hot spot), `rgba` (the pixels as RGBA, in base64) |
| `redirect` | none: connect again at once with the settings last used |

Each carries its kind under `type`.

### `/api/remote/desktop/keys`

JSON text frames both ways, for the channel its `pointer` query names. A missing or invalid channel closes the
socket at once, 1008.

| Message | Direction | Fields |
|---|---|---|
| `ready` | service to browser | none: the socket has joined its channel |
| `focus` | service to browser | `editable`: whether a text field on the desktop holds focus; sent on a change alone |
| `text` | browser to service | `text`: the characters to type, 1 to 4,096 |
| `key` | browser to service | `key`: a physical key code, with `ctrl+`, `alt+`, `shift+` or `meta+` before it; `count?`: 1 to 500, 1 where none |

A message of any other shape is ignored.

## Refusals

| Status | Code | When | `reason` |
|---|---|---|---|
| 401 | `unauthorized` | the bearer token is missing or wrong | |
| 400 | `terminal_name_text` | `POST /api/remote/terminals` sent a `label` that is not a string | |
| 400 | `rename_text` | `PATCH /api/remote/terminals/{id}` sent no `label` string | |
| 400 | `bad_terminal_id` | the id is not a session id's shape | |
| 404 | `no_terminal_session` | no session has the id | |
| 404 | `not_found` | an upgrade to a path no socket claims | |
| 500 | `terminals_failed_because` | tmux could not be asked for its sessions | what tmux said |
| 500 | `open_failed_because` | a session could not be started | what tmux said |

## The store

A SQLite file, the one `store.path` names, opened and migrated when the service starts. It holds one value:

| Key | What it is |
|---|---|
| `desktop_port` | the port the relay dials, read on every connection; with none, or one that is not a whole number from 1 to 65535, `desktop.port` is dialled |

## The command

`bmo-remote` is one binary, the service and its command alike, read by bmo-cli as a unit command (bmo-cli's
`docs/boundary.md`, 「Unit commands」).

- **`bmo-remote serve`** opens and migrates the store and answers the routes and sockets.
- **`bmo-remote health`** asks the service the settings name, waiting at most five seconds, and ends 0 where
  it answers ready.
- **`bmo-remote nouns`** prints the nouns it carries, one a line, each marked `home` after a tab, since the
  desktop is the machine the service stands on: `node remote-desktop` and `remote-desktop`.
- **`bmo-remote node remote-desktop`**, also run as `bmo-remote remote-desktop`, and so `bmo node
  remote-desktop` and `bmo remote-desktop`:
  - with no flag: tells which port the relay dials;
  - `--port <value>`: stores that port, then tells it;
  - `--default`: takes the stored port away, so `desktop.port` is dialled, then tells it.
  - `--port` and `--default` are not taken together.
  - It reads and writes the store in its own process, so the next connection dials the new port with no
    restart.
  - **What it prints:** one line, `remote-desktop: the desktop is dialled on port <port>.`; with no stored
    port, `remote-desktop: the desktop is dialled on port <port>, the default, since none is stored.`; with a
    stored value that is not a port, `remote-desktop: the stored value '<value>' is not a port, so port
    <port> is dialled.`
  - **How it ends:** 0 on success. A `--port` value that is not a whole number from 1 to 65535 is refused on
    standard error, `remote-desktop: not a port: <value>`, nothing is written, and it ends 1; so does usage
    it does not take.

## What the service reaches beside the units

It calls no other unit.

- **tmux and `systemd-run`** on this machine, for the terminal sessions and their server's transient unit.
- **The passwd database** of this machine, for the account's login shell.
- **The RDP server** at `desktop.host` and the stored port or `desktop.port`, over TLS.
- **fcitx5 and AT-SPI** on the account's session bus, for the input method's state and a text field's focus.

## Settings

The settings are read at start in layers, each overriding the one before: the defaults, which are the
repository's own `settings.toml` built into the binary; then `settings.toml` and `settings.local.toml` where
they stand in the settings folder, the one `BMO_REMOTE_SETTINGS` names, else the folder above the one holding
the binary (a deployment's root); then `BMO_REMOTE_<TABLE>__<KEY>` in the environment. A relative path is read
from the settings folder. An empty token lets no caller in.

| Table | Key | What it is | Default |
|---|---|---|---|
| `server` | `listen` | where the service answers, as `host:port` | `127.0.0.1:3320` |
| `server` | `token` | the bearer token every caller presents | none |
| `desktop` | `host` | the RDP server's address | `127.0.0.1` |
| `desktop` | `port` | the RDP server's port where the store holds none | `3389` |
| `desktop` | `password` | the password the relay answers the desktop's authentication with (`docs/remote.md`, 「Credentials」), kept in the local settings or the environment | none |
| `terminal` | `socket` | the tmux socket's name, letters, digits, `_` and `-` | `bmo-remote` |
| `terminal` | `config` | the tmux configuration file, the one a release carries | `deploy/tmux.conf` |
| `store` | `path` | the SQLite file of 「The store」 | `remote.db` |

## The console plugin bundle

`bmo-remote-client`, in `client/`: the remote screen as a Nuxt layer the console extends, mounted at
`/remote`, with `/remote/desktop` and `/remote/terminal/<id>` below it (`docs/screen.md`).

- **What its host serves it:** the bmo-ui layer, and the routes and sockets above under `/api/remote/`,
  handed on to this service with its token behind the console's sign-in.
- **How a host takes it:** the bundle is packed from `client/` with `bun pm pack` into
  `bmo-remote-client-<version>.tgz`, carrying its manifest, its Nuxt configuration, `app/`, `shared/` and the
  vendored RDP backend. A host keeps the packed bundle in its own tree and depends on it by that file,
  depends on bmo-ui at the version the bundle's peer names, and names `bmo-remote-client` in its Nuxt
  configuration's `extends`, which brings bmo-ui's layer with it.
- **What its host owes it,** declared in `client/host/` for the bundle's own typecheck alone:
  - the components `DeployMark`, `TodoOpenButton` and `UsageMeters` of the console's top bar, registered by
    name and handed no props;
  - `useKeptTabs(screen, { read, restore })`, made importable by name as Nuxt makes a project's own
    composables, which keeps the screen's open tabs for the account under the screen's key `remote`;
  - its i18n module and a language pack answering the keys below, as bmo-ui asks of every host.
- **Wording:** the bundle holds no words of its own. It reads these 80 keys from the host's language pack, and
  shows a refusal of the routes, or an `error` of the terminal socket, by the key its code names, under
  `remote.error.` but for `terminal_disconnected`, which is `remote.status.terminal_disconnected`:
  - `common.action.cancel`, `common.action.more`, `common.action.save`, `common.label.name`
  - `screens.label.remote`
  - `remote.title.desktop`, `remote.title.remote_desktop`, `remote.title.rename`, `remote.title.terminal_page`
  - `remote.label.extra_keys`, `remote.label.font_size`, `remote.label.input_mode`, `remote.label.menu`,
    `remote.label.open_sessions`, `remote.label.padding`, `remote.label.password`, `remote.label.quality`,
    `remote.label.quality_balanced`, `remote.label.quality_fast`, `remote.label.quality_sharp`,
    `remote.label.resolution`, `remote.label.size_1280x720`, `remote.label.size_1600x900`,
    `remote.label.size_1920x1080`, `remote.label.size_2560x1440`, `remote.label.size_auto`,
    `remote.label.touch_mode_pointer`, `remote.label.touch_mode_touch`, `remote.label.user`
  - `remote.action.connect`, `remote.action.disconnect`, `remote.action.disconnect_desktop`,
    `remote.action.end`, `remote.action.end_session`, `remote.action.exit_fullscreen`,
    `remote.action.fullscreen`, `remote.action.keyboard_show`, `remote.action.new_terminal`,
    `remote.action.open_desktop`, `remote.action.open_here`, `remote.action.open_window`,
    `remote.action.reconnect`
  - `remote.aria.desktop_input`, `remote.aria.key_backspace`, `remote.aria.key_down`, `remote.aria.key_enter`,
    `remote.aria.key_left`, `remote.aria.key_right`, `remote.aria.key_up`
  - `remote.status.connecting`, `remote.status.connection_ended`, `remote.status.no_sessions`,
    `remote.status.not_connected`, `remote.status.open_elsewhere`, `remote.status.reconnecting`,
    `remote.status.session_ended`, `remote.status.session_over`, `remote.status.terminal_disconnected`
  - `remote.message.disconnect_desktop`, `remote.message.end_many`, `remote.message.end_one`
  - `remote.error.access_denied`, `remote.error.attach_failed_because`, `remote.error.bad_terminal_id`,
    `remote.error.connect_failed`, `remote.error.end_failed`, `remote.error.load_failed`,
    `remote.error.logon_failed`, `remote.error.negotiation_failed`, `remote.error.no_terminal_session`,
    `remote.error.open_failed`, `remote.error.open_failed_because`, `remote.error.relay_refused`,
    `remote.error.relay_unreachable`, `remote.error.rename_failed`, `remote.error.rename_text`,
    `remote.error.terminal_name_text`, `remote.error.terminals_failed`, `remote.error.terminals_failed_because`,
    `remote.error.wrong_password`
  - A key ending in `_because` takes the refusal's `reason` as `{reason}`.

## What the console does

These are bmo-web's to carry; this repository holds none of them.

- **Hand on** every request under `/api/remote/` whole — the method, the query, the body and the headers that
  say what is asked — to the address `REMOTE_ADDRESS` names with the token `REMOTE_TOKEN` names, and hand the
  answer back as it came, behind the console's sign-in.
- **Hand on the websocket upgrades** under `/api/remote/` the same way: open the matching upgrade to this
  service with the token, then carry frames both ways as they come, unbuffered, keeping each frame's kind,
  binary or text, and hand back the close code either side ends with.
- **Refuse an upgrade** with no sign-in, 401, and one whose `Origin` is not the host it was sent to, or the
  forwarded host behind the proxy, 403, before handing anything on (「Who checks what」).
- **Extend the console plugin bundle** under `client/` in place of the `/remote` placeholder, and serve its
  pages at `/remote`, `/remote/desktop` and `/remote/terminal/<id>`.
- **Hold the words:** the 75 `remote` keys above in its pack, beside the five shared ones it holds.
- **Owe the host's parts** the bundle declares (「The console plugin bundle」).

## Missing in siblings

What another repository's own boundary must gain for this one to stand on it, each for that repository's
worker:

- **bmo-web:** `REMOTE_ADDRESS` and `REMOTE_TOKEN` among its settings; the handing on of `/api/remote/`,
  websocket upgrades included, which its boundary states for no unit yet; the sign-in and `Origin` checks
  on those upgrades; the bundle in place of the `/remote` placeholder; and the 75 `remote` keys in its pack.
- **bmo-cli:** name `node remote-desktop` and `remote-desktop` as served by `bmo-remote`, which declares them
  as nouns.

## Versions

The repository's version is the crate's, in semver. The major moves on a change to this document's routes,
sockets, messages, fields, codes, command or settings that a caller must follow; the minor on an addition to
any of them; the patch on a change that leaves every statement here true.
