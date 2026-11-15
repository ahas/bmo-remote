# The remote service's boundary

Every route and socket this service answers, its client, its command, its store, its settings, its console
face and the console plugin bundle it ships. This document is the contract other units match: bmo-web, whose
console reads the face's manifest, loads the bundle and hands the remote screen's requests on to these routes;
bmo-cli, which runs the command; and the testbed, whose deployment probes the console face. What the terminal and the desktop do is `docs/remote.md`, and the screen is `docs/screen.md`;
this document says how they are asked. A change to anything here changes this document in the same commit and
follows the version rule (「Versions」).

## Conventions

- **The service's paths carry no prefix.** A console or gateway that serves it to a browser mounts it under
  its own base, `/api/remote/` for the console, and passes each path on unchanged. The routes below are the
  service's own.
- **Two credentials, each a bearer token:** the console's credential, `console.token`, which the console
  presents on every request it hands on, and the service's own token, `server.token`, which the command
  presents. A missing or wrong one is answered 401 `unauthorized`, and an upgrade is refused so before it is
  taken.
  - The console face's routes take the console's credential alone (「The console face」).
  - The health takes the service's own token alone.
  - Every route the screen uses, the account, the terminal routes and the sockets, takes either. A call
    carrying the console's credential is held to the manifest's role as bmo-ui's console plugin contract
    states it (bmo-ui's `docs/console-bundles.md`, 「Roles and the owner key」), through the console face's
    guard; one carrying the service's own token is the command's and is held to nothing more.
- **Bodies are JSON, both ways, with field names in camelCase.** Times are epoch milliseconds, and an
  identifier is a signed 64-bit integer where the service names one; a terminal session's id is the string
  the service makes.
- **A refusal** is a non-2xx answer whose body carries a kebab-case code under `code` and an English sentence
  under `error` (「Refusals」). The sentence is for a log; the screen shows the code in its own language's
  words. The body carries those two keys and no other.
- **A member has one shape** wherever it is answered, alone or in a page. A page is `{"items": [...],
  "more": false}`, `more` saying whether anything stands past its last item.
- **A request to a path or socket no route claims** is answered 404 `no-route`.

## Who checks what

| Check | Where it stands |
|---|---|
| the console's sign-in, on every route and every upgrade | the console (「What the console does」) |
| the `Origin` of a websocket upgrade against the host it was sent to, or the forwarded host behind the proxy, refused 403 | the console |
| the bearer token, the console's credential or the service's own | this service |
| the reader's role against the manifest's on every route the screen uses and on the bundle's files | this service, through bmo-chat's console face |
| reachable from this machine alone | this service's settings: `server.listen` is a loopback address |

## Health

`GET /health` answers `ready`, `reason` (null while it is ready) and `version`: the store is open and the
service answers. It takes the service's own token alone.

## The account

| Method and path | Sends | Answers |
|---|---|---|
| `GET /account` | | `name`: the account the service runs as, which the terminal and the desktop are reached as; `keptPassword`: whether `desktop.password` is set and not empty |

The password itself is never answered.

## Terminal sessions

| Method and path | Sends | Answers |
|---|---|---|
| `GET /terminals` | `after?`, `limit?` | a page of `terminal`, in the order they began |
| `POST /terminals` | `title?`, a string | 201, the new `terminal`: the account's login shell |
| `GET /terminals/{terminalId}` | | the `terminal` |
| `PATCH /terminals/{terminalId}` | `title`, a string; an empty one takes the name away | the renamed `terminal` |
| `DELETE /terminals/{terminalId}` | | 204: the session and every program in it ended |
| `POST /terminals/{terminalId}/pastes` | `type`, the picture's media type; `data`, its bytes in base64 | 201, `path`: the file the picture was kept as on this machine |

- **A terminal** is `id` (`t-` and lower-case letters and digits), `title` (at most 80 characters, empty
  where it has none), `state` (`running`: the list holds the sessions that stand, and an ended session is
  gone from it) and `createdAt`.
- **A page of sessions** is taken by `after`, how many sessions were already read, and `limit`, how many to
  read: 100 where none is given, at most 1000.
- **An id that is not a session id's shape names no session,** so `GET`, `PATCH` and `DELETE` answer 404
  `not-found` for it as for an id no session has.
- **A pasted picture is kept as a file a program in the session can open** (`docs/remote.md`, 「The terminal
  interface」): under the folder `terminal.pastes` names, in a folder of the session's own, named by the moment
  it was kept, with the ending its type has. `type` is `image/png`, `image/jpeg`, `image/gif` or `image/webp`;
  any other, a `data` that is no base64 or holds nothing, and a picture past 20 MiB are answered 400
  `bad-request`. The answer's `path` is absolute. A session's folder goes when the session is ended.

## The terminal socket

`/terminals/{terminalId}/socket`, a websocket: one tmux attach client for the session, for as long as the
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
| 4404 | the id is not a session's | `no-terminal-session` |
| 4500 | the attach client could not start | `attach-failed-because`, with `reason` |
| 4500 | the attach client ended while the session stands | `terminal-disconnected` |

## The desktop sockets

Three websockets per desktop connection, tied by a pointer channel: a name the page makes up for one
connection, `[a-z0-9]{8,40}`, sent in each socket's `pointer` query (`docs/remote.md`, 「The relay」,
「The pointer」, 「The on-screen keyboard」). The service takes each upgrade behind the credentials of
「Conventions」 and hands the socket on to the desktop sidecar (「The desktop sidecar」), which answers it as
this section says.

### `/desktop/socket`

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
| negotiation error | no confirm, a malformed one, or a TLS handshake that failed or showed no certificate |

- **After the response** every byte is relayed both ways as it came, but for the logon packet's rewrite
  (`docs/remote.md`, 「Credentials」, 「Connection settings」).
- **It closes 1000** after an RDCleanPath error, when the desktop's side ends, and when the desktop redirects
  the connection, after telling the pointer channel.

### `/desktop/pointer`

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

### `/desktop/keys`

JSON text frames both ways, for the channel its `pointer` query names. A missing or invalid channel closes the
socket at once, 1008.

| Message | Direction | Fields |
|---|---|---|
| `ready` | service to browser | none: the socket has joined its channel |
| `focus` | service to browser | `editable`: whether a text field on the desktop holds focus; sent on a change alone |
| `text` | browser to service | `text`: the characters to type, 1 to 4,096 |
| `key` | browser to service | `key`: a physical key code, with `ctrl+`, `alt+`, `shift+` or `meta+` before it; `count?`: 1 to 500, 1 where none |

A message of any other shape is ignored.

### The desktop sidecar

The desktop's three sockets are answered by a bun process of this repository's own, `desktop-sidecar/`,
which the service starts and hands each desktop socket on to over the loopback address. Only the service
calls it.

- **The service starts it** as it starts to serve: `bun src/main.ts` in the folder `sidecar.folder` names,
  run by the program `sidecar.bun` names, with the environment below on top of the service's own. Where it
  ends, the service starts it again two seconds later; where the service stops, it goes with it.
- **What the service gives it,** each in its environment:

| Variable | What it is |
|---|---|
| `BMO_REMOTE_SIDECAR_HOST` | the loopback address it listens on, the host of `sidecar.listen` |
| `BMO_REMOTE_SIDECAR_PORT` | the port it listens on, the port of `sidecar.listen` |
| `BMO_REMOTE_SIDECAR_TOKEN` | the bearer it takes, made afresh each time the service starts it |
| `BMO_REMOTE_DESKTOP_HOST` | `desktop.host` |
| `BMO_REMOTE_DESKTOP_PORT` | `desktop.port`, dialled where the store holds no port |
| `BMO_REMOTE_DESKTOP_PASSWORD` | `desktop.password`, set only where one is kept |
| `BMO_REMOTE_STORE_PATH` | `store.path`, the store it reads the kept port from on every connection |
| `USER` | the account's name (「The account」), which the relay authenticates to the desktop as; bun answers the process's account from this variable rather than from the passwd database, so it is set whatever the service's own environment holds |

- **What it answers:** an upgrade to `/desktop/socket`, `/desktop/pointer` or `/desktop/keys` with the query
  the browser sent, carrying `Authorization: Bearer` and its token; a wrong or missing token is refused 401
  and any other path 404.
- **What the service carries:** every frame both ways as it came, keeping its kind, binary or text, and the
  close code and reason either side ends with. Where the sidecar cannot be reached, the service closes the
  browser's socket 1011.

## The console face

The service brings the remote screen to a console by bmo-ui's console plugin contract (bmo-ui's
`docs/console-bundles.md`), the one statement of the manifest, the bundle's files, their paths and their
guard. It serves them through bmo-chat's console face (bmo-chat's `docs/console-face.md`), which answers the
manifest at the contract's route and the bundle's files under `/console/`, fills the layer and the files'
paths from the bundle's folder, and refuses at start a manifest the contract refuses.

- **What the service supplies:**
  - its declaration of the manifest fields it decides, kept beside its code;
  - the bundle's folder, the one `console.folder` names, as the bundle's build writes it (「The console plugin
    bundle」): the module `remote.js`, its stylesheet `remote.css`, its words `words.json`, the chunks the
    module loads and the layer the build was made on;
  - the console's credential, `console.token`.
- **What the screen asks of the contract,** the declaration's values:
  - its name and service name `remote`, its title key `remote.title.remote`, its mark
    `i-material-symbols-devices-outline` and its screen path `/remote`;
  - the API prefix `/`: the screen calls every route and socket of this document;
  - the role `administrator`, with no owner key: the terminals and the desktop are the machine's own, not a
    user's;
  - the sidebar section `administration`: the screen is one of the services an administrator runs the system
    with, so a console that parts its sidebar draws its entry there;
  - a WebSocket, for the terminal socket and the desktop sockets; no event stream, and no notice kinds.
- **Where no face stands,** with no console credential set or a bundle folder the face cannot read, the
  service still answers every other route to its own token, and says why on its standard error at start; the
  console's credential is then taken nowhere, and the console leaves the screen out as a service whose
  manifest does not answer.

## Refusals

| Status | Code | When |
|---|---|---|
| 400 | `bad-request` | the body or the query is not the shape the route takes; the sentence names what is wrong |
| 401 | `unauthorized` | the bearer token is missing or wrong |
| 403 | `forbidden` | a route the screen uses, or a file of the bundle, is called with the console's credential and no role that allows the manifest's |
| 404 | `not-found` | no member stands at the key the path names, or the bundle holds no file at the path |
| 404 | `no-route` | no route or socket answers the method and path |
| 500 | `failed` | tmux could not read, open, rename or end the sessions; the sentence is the failure |

## The client

`bmo-remote`'s crate is the service's client: one method for each HTTP route that answers JSON, sending and
reading the types of `docs/openapi.json`, which the crate also generates, with the service's own token. The
command reaches the service through it, and any other Rust caller may. The console face is a console's to
read, and the client has no method for it. The console plugin bundle carries the TypeScript client generated
from the same document, `client/shared/openapi.ts`, and calls through bmo-ui's `relay` module; a socket is
opened by the page itself, with the console's credential the console adds when it relays the upgrade.

## The OpenAPI document

`docs/openapi.json` is the contract: every route, its parameters, its body, its answers, the codes it can
refuse with, and the schemas of `docs/api.md`'s members. It is generated from the service's own types, and
`bmo-remote openapi` prints it. Its version is the service's.

## The store

A SQLite file, the one `store.path` names, opened and migrated when the service starts. It holds one value:

| Key | What it is |
|---|---|
| `desktop_port` | the port the relay dials, read on every connection; with none, or one that is not a whole number from 1 to 65535, `desktop.port` is dialled |

## The command

`bmo-remote` is one binary, the service, its client and its command alike, read by bmo-cli as a unit command
(bmo-cli's `docs/boundary.md`, 「Unit commands」).

- **`bmo-remote serve`** opens and migrates the store and answers the routes and sockets.
- **`bmo-remote health`** asks the service the settings name, with the service's own token, waits for its
  answer or the connection's end, and ends 0 where it answers ready.
- **`bmo-remote console-reach`** prints, as one JSON object, how a console reaches the service: `address`, the
  base address the settings name, `consoleToken`, the console's credential, and `token`, the service's own
  token, which the console face's routes refuse. A deployment's console probe runs it (bmo-testbed's
  `docs/deploy.md`, 「The console probe」).
- **`bmo-remote openapi`** prints the OpenAPI document the code generates.
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
- **bun**, which runs the desktop sidecar (「The desktop sidecar」).
- **The RDP server** at `desktop.host` and the stored port or `desktop.port`, over TLS, dialled by the
  sidecar.
- **fcitx5 and AT-SPI** on the account's session bus, for the input method's state and a text field's focus:
  the sidecar runs `fcitx5-remote`, and the focus watcher under `python3` with GObject introspection's AT-SPI
  binding.

## Settings

The settings are read at start in layers, each overriding the one before: the defaults, which are the
repository's own `settings.toml` built into the binary; then `settings.toml` and `settings.local.toml` where
they stand in the settings folder, the one `BMO_REMOTE_SETTINGS` names, else the folder above the one holding
the binary (a deployment's root); then `BMO_REMOTE_<TABLE>__<KEY>` in the environment. A relative path is read
from the settings folder. An empty token lets no caller in by it.

| Table | Key | What it is | Default |
|---|---|---|---|
| `server` | `listen` | where the service answers, as `host:port` | `127.0.0.1:3320` |
| `server` | `token` | the service's own token, which the command presents | none |
| `desktop` | `host` | the RDP server's address | `127.0.0.1` |
| `desktop` | `port` | the RDP server's port where the store holds none | `3389` |
| `desktop` | `password` | the password the relay answers the desktop's authentication with (`docs/remote.md`, 「Credentials」), kept in the local settings or the environment | none |
| `sidecar` | `listen` | where the desktop sidecar answers, a loopback `host:port` (「The desktop sidecar」) | `127.0.0.1:3321` |
| `sidecar` | `bun` | the program that runs it, a path or a name found on the `PATH` | `bun` |
| `sidecar` | `folder` | its package folder, the one a release carries | `desktop-sidecar` |
| `terminal` | `socket` | the tmux socket's name, letters, digits, `_` and `-` | `bmo-remote` |
| `terminal` | `config` | the tmux configuration file, the one a release carries | `deploy/tmux.conf` |
| `terminal` | `pastes` | the folder a picture pasted into a session is kept under, a folder for each session | `pastes` |
| `store` | `path` | the SQLite file of 「The store」 | `remote.db` |
| `console` | `token` | the console's credential, which the console presents; with none, no console face stands (「The console face」) | none |
| `console` | `folder` | the console bundle's folder, the one the bundle's build writes and a release carries (「The console face」) | `client/dist` |

## The console plugin bundle

`bmo-remote-client`, in `client/`: the remote screen, mounted at `/remote`, with `/remote/desktop` and
`/remote/terminal/<id>` below it (`docs/screen.md`), built as bmo-ui's console plugin contract states a bundle
(bmo-ui's `docs/console-bundles.md`, 「What a bundle is」).

- **The release it is built on.** bmo-ui's packed release file, the one bmo-chat's `shared-versions.toml`
  pins, vendored under `client/vendor/` as the release verb wrote it.
- **The build.** `bun run bundle` builds the pages into `client/dist/` with bmo-ui's bundle build, which leaves
  the libraries the console shares unbundled and writes the layer the bundle was built on:
  - `remote.js`, one ECMAScript module whose default export holds the three routes, the two windows of one
    session standing on no layout of the console's, and the chunks it imports under `chunks/`, the RDP
    backend among them;
  - `remote.css`, its stylesheet: the utility classes its templates use, built on bmo-ui's tokens without
    the tokens themselves, the styles its components scope to themselves, xterm's, and the terminal's faces
    inlined;
  - `words.json`, its words, each language file's tree under its locale's code;
  - `layer.json`, the layer.
  - What Nuxt gives a page by name is imported by the package's own path, and the module stands in itself
    what no console gives it, in `client/module/`: the open tabs are kept in the browser under the screen's
    key `remote`, put back when the screen stands.
  - A deployment builds it in its release before the release is put live (`testbed.toml`), and the service
    answers it through its console face (「The console face」). The bundle's check builds it too.
- **The Nuxt project.** `client/` is also a Nuxt project on bmo-ui's layer, which `bun run typecheck`
  prepares and typechecks; nothing is packed from it.
- **Where a screen calls the service:** through bmo-ui's `relay` module, a route by its call and a socket at
  its socket address, its query carried (bmo-ui's `docs/console-bundles.md`, 「How a bundle mounts」).
- **Wording:** the screen's own words are the bundle's language pack, one JSON file to a language under
  `client/i18n/`: `ko.json`, and `en.json` holding the same keys. The module's build writes them into
  `words.json` under each file's code, and the console merges them into its own pack.
  - **From the layer's own words,** which the console answers, the keys every screen shares, under `common.`:
    `action.cancel`, `action.more`, `action.save` and `label.name`.
  - **From the bundle's own pack,** the 81 keys under `remote`. The screen shows a refusal of the routes, or
    an `error` of the terminal socket, by the key its code names, under `remote.error.` but for
    `terminal-disconnected`, which is `remote.status.terminal-disconnected`; every code the service answers
    has its key, `unauthorized`, `forbidden`, `bad-request`, `not-found`, `no-route`, `failed` and
    `no-terminal-session` among them. A local failure the service does not name has a key of its own in the
    same pack.
  - `remote.title.remote`, `remote.title.desktop`, `remote.title.remote_desktop`, `remote.title.rename`,
    `remote.title.terminal_page`
  - `remote.label.extra_keys`, `remote.label.font_size`, `remote.label.input_mode`, `remote.label.menu`,
    `remote.label.open_sessions`, `remote.label.padding`, `remote.label.password`, `remote.label.quality`,
    `remote.label.quality_balanced`, `remote.label.quality_fast`, `remote.label.quality_sharp`,
    `remote.label.resolution`, `remote.label.size_1280x720`, `remote.label.size_1600x900`,
    `remote.label.size_1920x1080`, `remote.label.size_2560x1440`, `remote.label.size_auto`,
    `remote.label.touch_mode_pointer`, `remote.label.touch_mode_touch`, `remote.label.user`
  - `remote.action.connect`, `remote.action.disconnect`, `remote.action.end`, `remote.action.exit_fullscreen`,
    `remote.action.fullscreen`, `remote.action.keyboard_show`, `remote.action.new_terminal`,
    `remote.action.open_desktop`, `remote.action.open_here`, `remote.action.open_window`,
    `remote.action.reconnect`
  - `remote.aria.desktop_input`, `remote.aria.key_backspace`, `remote.aria.key_down`, `remote.aria.key_enter`,
    `remote.aria.key_left`, `remote.aria.key_right`, `remote.aria.key_up`
  - `remote.status.connecting`, `remote.status.connection_ended`, `remote.status.no_sessions`,
    `remote.status.not_connected`, `remote.status.open_elsewhere`, `remote.status.reconnecting`,
    `remote.status.session_ended`, `remote.status.session_over`, `remote.status.terminal-disconnected`,
    `remote.status.waking`
  - `remote.message.disconnect_desktop`, `remote.message.end_many`, `remote.message.end_one`
  - `remote.question.disconnect_desktop`, `remote.question.end_many`, `remote.question.end_one`
  - `remote.error.access_denied`, `remote.error.attach-failed-because`, `remote.error.bad-request`,
    `remote.error.connect_failed`, `remote.error.end_failed`, `remote.error.failed`, `remote.error.forbidden`,
    `remote.error.load_failed`, `remote.error.logon_failed`, `remote.error.negotiation_failed`,
    `remote.error.no-route`, `remote.error.no-terminal-session`, `remote.error.not-found`,
    `remote.error.open_failed`, `remote.error.relay_refused`, `remote.error.relay_unreachable`,
    `remote.error.rename_failed`, `remote.error.terminals_refused`, `remote.error.terminals_status`,
    `remote.error.terminals_unreached`, `remote.error.unauthorized`, `remote.error.wrong_password`
  - A key ending in `-because` takes the socket's `reason` as `{reason}`.
  - `remote.error.terminals_refused` takes the refusal's own words as `{reason}`, and
    `remote.error.terminals_status` the answer's status as `{status}`.
  - `remote.question.end_one` takes `{name}`, the session's name, and `remote.question.end_many` `{n}`, how
    many sessions end.
  - `remote.status.waking` takes `{tries}`, the try the screen is on, and `{seconds}`, the seconds passed
    since the first.

## What the console does

bmo-web's console attaches the screen and relays it as the contract states a console does (bmo-ui's
`docs/console-bundles.md`, 「What a console owes」) and its own boundary states it (bmo-web's
`docs/boundary.md`); this repository holds none of it. What this service relies on beyond the contract:

- **It reaches the service** at the address `REMOTE_ADDRESS` names with the credential `REMOTE_TOKEN` names,
  the one this service's `console.token` holds, never the service's own token.
- **It guards the upgrades:** an upgrade under `/api/remote/` with no sign-in is refused 401, and one whose
  `Origin` is not the host it was sent to, or the forwarded host behind the proxy, 403, before anything is
  handed on (「Who checks what」).
- **It carries a socket's frames** both ways as they come, unbuffered, keeping each frame's kind, binary or
  text, and hands back the close code either side ends with.

## Missing in siblings

What another repository's own boundary must gain for this one to stand on it, each for that repository's
worker:

- **bmo-web:** its `REMOTE_TOKEN` named as the console's own credential that this service's `[console] token`
  holds, not the service's own token, as its boundary names the brain's and the artifact's.
- **bmo-cli:** name `node remote-desktop` and `remote-desktop` as served by `bmo-remote`, which declares them
  as nouns.

## Versions

The repository's version is the crate's, shared by the console plugin bundle. Until the first release it is
`0.1.0` plus a revision suffix: the first version, `0.1.0`, is the base and is no revision, and every later
version bump is one revision, `0.1.0-rev.<n>`, with `n` counting the bumps since the base from 1. Major,
minor and patch never move before the first release, whatever the change. This repository is
`0.1.0-rev.5`.
