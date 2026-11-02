# The remote service's boundary

Every route and socket this service answers, its client, its command, its store, its settings, the console
plugin bundle it ships and what the console in front of it does. This document is the contract other units
match: bmo-web, whose console reads the bundle's manifest, loads the bundle and hands the remote screen's
requests on to these routes; bmo-cli, which runs the command; and the switch-over, which points the console at
this service. What the terminal and the desktop do is `docs/remote.md`, and the screen is `docs/screen.md`;
this document says how they are asked. A change to anything here changes this document in the same commit and
follows the version rule (「Versions」).

## Conventions

- **The service's paths carry no prefix.** A console or gateway that serves it to a browser mounts it under
  its own base, `/api/remote/` for the console, and passes each path on unchanged. The routes below are the
  service's own.
- **Every route takes `Authorization: Bearer <token>`,** the token of the settings, a websocket upgrade
  included; a missing or wrong token is answered 401 `unauthorized`, and an upgrade is refused so before it
  is taken. The console presents the token on every request it hands on.
- **Every route the screen uses also takes `Owner-Role`,** the role of the reader the console hands the
  request on for, set by the console in place of any the browser sent: the account, the terminal routes,
  the sockets and the bundle's module, stylesheet and chunks. A missing role, or one that does not allow the
  manifest's `administrator`, is answered 403 `forbidden` after the token is checked, and an upgrade is
  refused so before it is taken. The health, the manifest and the bundle's words take the token alone,
  since the console and the command read them for no reader. The service needs no `Owner-Key`: the
  terminals and the desktop are the machine's, not a user's.
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
| the bearer token | this service |
| the reader's role, `Owner-Role`, against the manifest's `administrator` on every route the screen uses | this service |
| reachable from this machine alone | this service's settings: `server.listen` is a loopback address |

## Health

`GET /health` answers `ready`, `reason` (null while it is ready) and `version`: the store is open and the
service answers. It takes the token alone.

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

- **A terminal** is `id` (`t-` and lower-case letters and digits), `title` (at most 80 characters, empty
  where it has none), `state` (`running`: the list holds the sessions that stand, and an ended session is
  gone from it) and `createdAt`.
- **A page of sessions** is taken by `after`, how many sessions were already read, and `limit`, how many to
  read: 100 where none is given, at most 1000.
- **An id that is not a session id's shape names no session,** so `GET`, `PATCH` and `DELETE` answer 404
  `not-found` for it as for an id no session has.

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
「The pointer」, 「The on-screen keyboard」). The service takes each upgrade behind its token and hands the
socket on to the desktop sidecar (「The desktop sidecar」), which answers it as this section says.

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

## The console bundle's routes

What a console reads to attach the remote screen (bmo-ui's `docs/console-bundles.md`), answered from the
bundle's folder, the one `console.folder` names, as the service read it when it started (「The console plugin
bundle」).

| Method and path | Takes | Answers |
|---|---|---|
| `GET /console-manifest` | the token | the manifest, below |
| `GET /console/words.json` | the token | the bundle's words: each language file's tree under its locale's code, `ko` and `en` |
| `GET /console/{file}` | the token and the role | a file of the module: `remote-<digest>.js`, the module; `remote-<digest>.css`, its stylesheet; `chunks/<name>-<hash>.js`, a chunk the module imports |

- **The manifest** is the contract's JSON object, with these values:

| Field | Value |
|---|---|
| `name` | `remote` |
| `title` | `remote.title.remote` |
| `icon` | `i-material-symbols-devices-outline` |
| `screenPath` | `/remote` |
| `serviceName` | `remote` |
| `bundle` | `/console/remote-<digest>.js` |
| `stylesheet` | `/console/remote-<digest>.css` |
| `words` | `/console/words.json` |
| `apiPrefix` | `/`: the screen calls every route and socket of this document, and the module's chunks stand under `/console/` |
| `role` | `administrator`: the terminals and the desktop are the machine's own |
| `ownerKey` | `false` |
| `events` | `false`: the service has no event stream |
| `websocket` | `true`: the terminal socket and the desktop sockets |
| `pushKinds` | none |

- **A path follows its bytes.** `<digest>` is the first 16 hexadecimal digits of the SHA-256 of the file's
  bytes, so a rebuilt module or stylesheet is answered at a new path and the manifest names it; a chunk's
  name carries a hash of its own bytes from the build.
- **The module's files are kept:** each is answered with `Cache-Control: private, max-age=31536000,
  immutable`; the manifest and the words with `no-cache`. The module and its chunks are
  `text/javascript`, the stylesheet `text/css`, the words and the manifest `application/json`.
- **Where the folder could not be read,** or holds no `remote.js` or no `words.json`, the service still
  answers every other route; the manifest is answered 500 `failed`, its sentence saying what is missing, so
  the console leaves the screen out, and the words and a file are answered 404 `not-found`. A file the folder
  does not hold is 404 `not-found`.

## Refusals

| Status | Code | When |
|---|---|---|
| 400 | `bad-request` | the body or the query is not the shape the route takes; the sentence names what is wrong |
| 401 | `unauthorized` | the bearer token is missing or wrong |
| 403 | `forbidden` | a route the screen uses is called with no `Owner-Role`, or with one that does not allow `administrator` |
| 404 | `not-found` | no member stands at the key the path names |
| 404 | `no-route` | no route or socket answers the method and path |
| 500 | `failed` | tmux could not read, open, rename or end the sessions; the sentence is the failure |

## The client

`bmo-remote`'s crate is the service's client: one method for each HTTP route that answers JSON, sending and
reading the types of `docs/openapi.json`, which the crate also generates, and sending `Owner-Role` where it is
given a role. The command reaches the service through it, and any other Rust caller may. The module's files
are a console's to fetch, and the client has no method for them. The console plugin bundle carries the
TypeScript client generated from the same document, `client/shared/openapi.ts`, and calls through it; a socket
is opened by the page itself, with the token the console adds when it relays the upgrade.

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
- **`bmo-remote health`** asks the service the settings name, with the settings' token, waits for its answer
  or the connection's end, and ends 0 where it answers ready.
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
from the settings folder. An empty token lets no caller in.

| Table | Key | What it is | Default |
|---|---|---|---|
| `server` | `listen` | where the service answers, as `host:port` | `127.0.0.1:3320` |
| `server` | `token` | the bearer token every caller presents | none |
| `desktop` | `host` | the RDP server's address | `127.0.0.1` |
| `desktop` | `port` | the RDP server's port where the store holds none | `3389` |
| `desktop` | `password` | the password the relay answers the desktop's authentication with (`docs/remote.md`, 「Credentials」), kept in the local settings or the environment | none |
| `sidecar` | `listen` | where the desktop sidecar answers, a loopback `host:port` (「The desktop sidecar」) | `127.0.0.1:3321` |
| `sidecar` | `bun` | the program that runs it, a path or a name found on the `PATH` | `bun` |
| `sidecar` | `folder` | its package folder, the one a release carries | `desktop-sidecar` |
| `terminal` | `socket` | the tmux socket's name, letters, digits, `_` and `-` | `bmo-remote` |
| `terminal` | `config` | the tmux configuration file, the one a release carries | `deploy/tmux.conf` |
| `store` | `path` | the SQLite file of 「The store」 | `remote.db` |
| `console` | `folder` | the console bundle's folder, the one the bundle's build writes and a release carries (「The console bundle's routes」) | `client/dist` |

## The console plugin bundle

`bmo-remote-client`, in `client/`: the remote screen, mounted at `/remote`, with `/remote/desktop` and
`/remote/terminal/<id>` below it (`docs/screen.md`), on bmo-ui's console plugin contract (bmo-ui's
`docs/console-bundles.md`). The same pages reach a console in two forms: the module the service serves, which
a console attaches by the manifest, and the layer pack, which a console still extending its bundles at build
time takes.

- **The served module.** `bun run bundle` builds the pages into `client/dist/` with `client/module.config.ts`:
  - `remote.js`, one ECMAScript module whose default export holds the three routes, the two windows of one
    session standing on no layout of the console's, and the chunks it imports under `chunks/`, the RDP
    backend among them;
  - `remote.css`, its stylesheet: the utility classes its templates use, built on bmo-ui's tokens without
    the tokens themselves, the styles its components scope to themselves, xterm's, and the terminal's faces
    inlined;
  - `words.json`, its words.
  - Every import of `vue`, `vue-router`, `vue-i18n`, `nuxt/app`, `@nuxt/ui` and `bmo-ui` is left unbundled,
    written as the package's own path: Nuxt UI's components as `@nuxt/ui/components/<Name>.vue`, bmo-ui's
    as `bmo-ui/app/components/<Name>.vue`, and what Nuxt makes importable by name from `vue`, `vue-i18n`
    and `nuxt/app`. A call goes through the console's own `$fetch`.
  - A console loading the module registers nothing for it, so the module stands in what a Nuxt host gives
    the pages, in `client/module/`: the console's title-bar pieces the screen draws stand empty, and the
    open tabs are kept in the browser under the screen's key `remote`, put back when the screen stands.
  - A deployment builds it in its release before the release is put live (`testbed.toml`), and the service
    answers it (「The console bundle's routes」). The bundle's check builds it too.
- **The layer pack.** `bun pm pack` packs `client/` into `bmo-remote-client-<version>.tgz`, carrying its
  package manifest, its declaration, its Nuxt configuration, `app/`, `shared/`, its language pack under
  `i18n/` and the vendored RDP backend. A host keeps the packed bundle in its own tree and depends on it by
  that file, depends on bmo-ui at the version the bundle's peer names, and names `bmo-remote-client` in its
  Nuxt configuration's `extends`, which brings bmo-ui's layer with it.
  - `client/console-bundle.json` declares the bundle to such a host, as bmo-ui's build-time contract up to
    `0.1.0-rev.6` reads it: the manifest's name, title key, icon, screen path, service name, stream, socket
    and notice kinds, and the language pack folder `i18n`. The service's test holds those values to the
    manifest's.
  - The bundle's peer is bmo-ui `0.1.0-rev.6` or later before `0.2.0`, since the screen takes its socket
    addresses from bmo-ui's `relay` module; its own install and typecheck stand on a packed
    `0.1.0-rev.7` under `client/vendor/`.
- **Where a screen calls the service:** a route at the address bmo-ui's `relay` module answers for the
  service's name and the route's path, and a socket at the socket address the same module answers, its
  query carried: both under the app's base path and the console's relay base, complete as given, so a
  console served under a path of its own takes the socket where it takes the route.
- **What a host extending the pack owes it,** declared in `client/host/` for the bundle's own typecheck
  alone: the components `DeployMark`, `TodoOpenButton` and `UsageMeters` of the console's top bar,
  registered by name and handed no props; `useKeptTabs(screen, { read, restore })`, made importable by name
  as Nuxt makes a project's own composables, which keeps the screen's open tabs for the account under the
  screen's key `remote`; and its i18n module, which merges the bundle's own pack into the host's locale of
  the same code.
- **Wording:** the screen's own words are the bundle's language pack, one JSON file to a language under
  `client/i18n/`: `ko.json`, and `en.json` holding the same keys. The module's build writes them into
  `words.json` under each file's code. For the layer pack, the bundle's Nuxt configuration registers
  them as the host registers its own locales, by code (`ko`, `en`), language tag (`ko-KR`, `en-US`) and file,
  and the host's i18n module reads a layer's locales as part of its own: where both name a code, the two
  files are one locale, the host's value standing where both hold a key.
  - **From the host's pack,** the keys every screen of the console shares, under `common.`: `action.cancel`,
    `action.more`, `action.save` and `label.name`.
  - **From the bundle's own pack,** the 79 keys under `remote`. The screen shows a refusal of the routes, or
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
  - `remote.action.connect`, `remote.action.disconnect`, `remote.action.disconnect_desktop`,
    `remote.action.end`, `remote.action.end_session`, `remote.action.exit_fullscreen`,
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
  - `remote.status.waking` takes `{tries}`, the try the screen is on, and `{seconds}`, the seconds passed
    since the first.

## What the console does

These are bmo-web's to carry; this repository holds none of them.

- **State its relay base** under `bmoUi.relayBase` in its app configuration: the path every service is
  relayed under, `/api`.
- **Read the manifest** at `GET /console-manifest` with the token, and attach the screen by it alone, for an
  administrator: the menu entry, the module from its relay address, its stylesheet and its words.
- **Hand on** every request for the service under `/api/remote/` whole — the method, the query, the body and
  the headers that say what is asked — with the token, to the address `REMOTE_ADDRESS` names, and hand the
  answer back as it came, behind the console's sign-in.
- **Set `Owner-Role`** on every request and upgrade it hands on, the signed-in reader's role, in place of any
  the browser sent; and `Owner-Key` where the login has a user, which this service does not read.
- **Hand on the websocket upgrades** under `/api/remote/` the same way: open the matching upgrade to this
  service with the token, then carry frames both ways as they come, unbuffered, keeping each frame's kind,
  binary or text, and hand back the close code either side ends with.
- **Refuse an upgrade** with no sign-in, 401, and one whose `Origin` is not the host it was sent to, or the
  forwarded host behind the proxy, 403, before handing anything on (「Who checks what」).
- **Serve the screen** at `/remote`, `/remote/desktop` and `/remote/terminal/<id>`, from the module; the
  console's own pack holds none of the `remote` keys.
- **Until it reads manifests,** extend the layer pack in place of the `/remote` placeholder, attach it by its
  declaration, merge its language pack and owe the host's parts the bundle declares (「The console plugin
  bundle」).

## Missing in siblings

What another repository's own boundary must gain for this one to stand on it, each for that repository's
worker:

- **bmo-web:** `REMOTE_ADDRESS` and `REMOTE_TOKEN` among its settings; the relay base `/api`; the handing on
  of `/api/remote/`, websocket upgrades included, which its boundary states for no unit yet; the sign-in and
  `Origin` checks on those upgrades; `Owner-Role` set on everything it hands on; and the screen attached by
  the manifest the service answers, the module loaded at run time in place of the layer pack it extends at
  build time.
- **bmo-cli:** name `node remote-desktop` and `remote-desktop` as served by `bmo-remote`, which declares them
  as nouns.

## Versions

The repository's version is the crate's, shared by the console plugin bundle. Until the first release it is
`0.1.0` plus a revision suffix: the first version, `0.1.0`, is the base and is no revision, and every later
version bump is one revision, `0.1.0-rev.<n>`, with `n` counting the bumps since the base from 1. Major,
minor and patch never move before the first release, whatever the change. This repository is
`0.1.0-rev.5`.
