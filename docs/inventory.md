# What this repository takes from the old bmo

Every file, part of a file, test and service unit this repository takes from the old single repository,
with where each came from, how many, and what becomes of it here. Every set below was listed from the old
repository at its commit `3e4c032`, with `git ls-tree`, `git show` and `git grep` against that commit;
the command that lists a set stands beside it. Nothing here was copied with its history.

The tests are deferred: none is carried, written or run in this phase. They are written and run here once
the minimal services stand on the new repositories. The deferred tests are listed below so that work knows
what the old behaviour was held to.

## How the set was listed

- **By path:** `git ls-tree -r --name-only 3e4c032`, kept to the remote screen's components, domain modules
  and pages, `client/remote/`, the routes under `client/server/api/remote/`, the server modules named
  `remote-*`, `rdp-*` and `rdcleanpath*`, the websocket plugin and module, the IronRDP build scripts and
  vendor folder, the bench scripts, the terminal's font faces, the `remote_desktop` verb and lang files, and
  `docs/remote.md`. That gives 97 files.
- **By what they read:** every import of those files that leaves the set, and every font face the terminal
  names. That adds 3 files no path names: the symbol face the terminal falls back to, its licence, and the
  CaskaydiaCove licence.
- **So the set is 100 files.** 59 are carried or ported, 41 are not carried, each for the reason its table
  gives. Seven parts of other files are carried or listed beside them.
- **Earlier lists that disagree:** the old code graph's remote node names 86 files, and bmo-web's
  `docs/inventory.md` names 92 for this unit. The graph left out the bench scripts, the fonts and the vendor
  build's tests; bmo-web's list left out the verb, its two lang files and `docs/remote.md`, which are not
  the console's. Neither names the three files found by what the terminal reads.

## The server modules: 19 files, 3,566 lines, ported to Rust

The old console server's TypeScript, under `client/server/utils/`. Each becomes a module of the one crate
(`docs/api.md` is what it serves).

| Old file | Lines | Here |
|---|---|---|
| `remote-tmux.ts` | 273 | `src/terminal/tmux.rs`: the tmux server, its sessions and their labels |
| `remote-pty.ts` | 113 | `src/terminal/pty.rs`: one attach client in a pseudo-terminal per viewer |
| `remote-terminal-socket.ts` | 185 | `src/terminal/socket.rs`: the terminal socket |
| `remote-sockets.ts` | 72 | `src/terminal/socket.rs` and `src/http.rs`: which paths are a socket's, and the refusal of the rest |
| `remote-guard.ts` | 44 | `src/guard.rs`: the bearer token. Its sign-in and `Origin` checks are bmo-web's (「Not carried」) |
| `rdcleanpath.ts` | 294 | `src/desktop/rdcleanpath.rs`: the RDCleanPath request, response and errors. Its TPKT length is `framing.rs`'s and its core-data rewrite `client_info.rs`'s. The request's encoder and the response's reader, which only its tests use, are not carried (「Tests deferred」) |
| `rdp-negotiation.ts` | 115 | `src/desktop/negotiation.rs`: the X.224 request's protocols and routing token rewritten |
| `rdp-nla.ts` | 450 | `src/desktop/nla.rs`: CredSSP with NTLMv2, and the public key CredSSP binds read out of the server's certificate |
| `rdp-framing.ts` | 210 | `src/desktop/framing.rs`: where each TPKT and fast-path PDU ends |
| `rdp-redirection.ts` | 118 | `src/desktop/redirection.rs`: a server redirection packet read |
| `rdp-client-info.ts` | 174 | `src/desktop/client_info.rs`: the logon packet and the core data rewritten. The performance flags each quality puts in the logon packet are that quality's, in `src/desktop/quality.rs` |
| `rdp-pointers.ts` | 147 | `src/desktop/pointers.rs`: the fast-path pointer updates read into shapes |
| `rdp-input.ts` | 103 | `src/desktop/input.rs`: fast-path input PDUs |
| `rdp-typist.ts` | 187 | `src/desktop/typist.rs`: the keys socket's messages typed into the stream |
| `rdp-hangul.ts` | 42 | `src/desktop/hangul.rs`: a syllable as its 두벌식 keys |
| `remote-input-method.ts` | 143 | `src/desktop/input_method.rs`: fcitx5's state and trigger keys |
| `remote-desktop-focus.ts` | 92 | `src/desktop/focus.rs`: the focus watcher, started and stopped with the keys sockets |
| `remote-desktop-socket.ts` | 740 | `src/desktop/socket.rs`: the desktop and pointer sockets, the relay and its failures |
| `remote-desktop-keys.ts` | 64 | `src/desktop/keys.rs`: the keys socket |

## The routes: 5 files, 88 lines, ported to Rust

`git ls-tree -r --name-only 3e4c032 client/server/api/remote`, the test file left out. Each answers here
at the same path, behind this service's bearer token in place of the console's sign-in (`docs/api.md`).

| Old file | Lines | Here |
|---|---|---|
| `account.get.ts` | 10 | `src/account.rs`, `GET /api/remote/account` |
| `terminals.get.ts` | 14 | `src/terminal/routes.rs`, `GET /api/remote/terminals` |
| `terminals.post.ts` | 24 | `src/terminal/routes.rs`, `POST /api/remote/terminals` |
| `terminals/[id].delete.ts` | 14 | `src/terminal/routes.rs`, `DELETE /api/remote/terminals/{id}` |
| `terminals/[id].patch.ts` | 26 | `src/terminal/routes.rs`, `PATCH /api/remote/terminals/{id}` |

## What the server runs beside it: 2 files, 123 lines

| Old file | Lines | Here |
|---|---|---|
| `client/remote/tmux.conf` | 40 | `deploy/tmux.conf`, carried as it is and named by the `terminal.config` setting |
| `client/remote/desktop-focus.py` | 83 | `src/desktop/focus.rs`, an AT-SPI client inside the service in place of the Python helper it started |

## The command: 3 files, 87 lines

| Old file | Lines | Here |
|---|---|---|
| `bot/bmo-server/src/verbs/remote_desktop.rs` | 61 | `src/command.rs`, the `node remote-desktop` command, writing this repository's own store |
| `lang/bmo-lang/src/remote_desktop.rs` | 15 | not carried as a file: its four lines are the command's English lines in `src/command.rs` (`docs/api.md`, 「The command」) |
| `lang/bmo-lang/lang/ko/remote-desktop.yaml` | 11 | not carried: no screen shows these lines, and the command prints English |

## The console screen: 26 files and 5 fonts

Carried into the console plugin bundle under `client/`, at the same paths below `client/` they stood at.

| Old files | Count | Lines | Here |
|---|---|---|---|
| `client/app/components/`: `RemoteDesktop.vue`, `RemoteDesktopLogin.vue`, `RemoteExtraKeys.vue`, `RemoteRenameModal.vue`, `RemoteTerminal.vue`, `RemoteTerminalPanel.vue`, `RemoteViewMenu.vue`, `RemoteWindowBar.vue` | 8 | 844 | `client/app/components/` |
| `client/app/domain/remote/`: `desktop-hub.ts`, `desktop-input.ts`, `desktop-pointer.ts`, `sessions.ts`, `terminal-clipboard.ts`, `terminal-hub.ts`, `terminal-ime.ts`, `terminal-touch-scroll.ts` | 8 | 3,365 | `client/app/domain/remote/` |
| `client/app/pages/remote/`: `index.vue`, `desktop.vue`, `terminal/[id].vue` | 3 | 418 | `client/app/pages/remote/` |
| `client/scripts/build-ironrdp.ts`, `client/scripts/ironrdp-bundle.ts` | 2 | 70 | `client/scripts/` |
| `client/vendor/iron-remote-desktop-rdp/`: `avc420.js`, `egfx.patch`, `index.d.ts`, `iron-remote-desktop-rdp.js`, `package.json` | 5 | 5,268 | `client/vendor/iron-remote-desktop-rdp/` |
| `client/app/assets/fonts/`: `CaskaydiaCoveNerdFontMono-Regular.woff2`, `CaskaydiaCoveNerdFontMono-Bold.woff2`, `NotoSansSymbols2-subset.woff2`, `LICENSE-CaskaydiaCove.txt`, `LICENSE-NotoSansSymbols2.txt` | 5 | binary, and two licences | `client/app/assets/fonts/` |

- **Imports from the old console's shell** are rewritten onto bmo-ui's modules of the same names: `screen`
  (`useNarrow`), `prompt` (`TOUCH_QUERY`), `tabs` (`BarAction`, `BarTab`, `BarMenuItem`), `layers`
  (`useBackClose`) and `wording` (`Translate`). The components `ActionGroup`, `ScreenFrame`,
  `SettingsDialog` and `TabBar` are bmo-ui's too.
- **What bmo-ui does not serve** is the host's, declared in `client/host/` (`docs/api.md`, 「The console
  plugin bundle」): `useKeptTabs`, `DeployMark`, `TodoOpenButton` and `UsageMeters`.
- **The screen's words** are the bundle's own language pack, `client/i18n/locales/ko.yaml`: the 75 keys under
  `remote` of the old console's `client/i18n/locales/ko.yaml` (its lines 2037 to 2119), each value as it
  stood, and one key for each of the three refusal codes the old screen had none for, `failed`, `not_found`
  and `unauthorized`. `client/i18n/locales/en.yaml` holds the same keys in English. The five shared keys
  the screen reads stay in the host's pack (`docs/api.md`, 「The console plugin bundle」).
- **Where the screen showed the server's sentence** — a session not opened, renamed or ended, and the
  terminal socket's `error` — it shows the pack's words for the refusal's code (`docs/api.md`, 「The console
  plugin bundle」), through `client/app/domain/remote/refusals.ts`, since the service answers English and codes.
- **The IronRDP build's work directory** is the user's cache folder where none is named, outside every
  repository and data folder.
- **The packages** the screen stands on are pinned as the old console pinned them: `@xterm/xterm` 5.5.0,
  `@devolutions/iron-remote-desktop` 0.11.0, and the vendored `@devolutions/iron-remote-desktop-rdp`. The terminal IME reads
  which characters take two cells from `get-east-asian-width`, Unicode's East Asian Width, rather than from
  a table of its own.

## The documents: 1 file

| Old file | Lines | Here |
|---|---|---|
| `docs/remote.md` | 627 | `docs/remote.md`, stated for this repository: its settings, store and boundary in place of the console's environment, the archive's settings table and the console's sign-in |

## Parts of other files: 7

| Old file | Part | Here |
|---|---|---|
| `client/app/assets/css/main.css` | the two `@font-face` rules of `CaskaydiaCove Nerd Font Mono` and the one of `Noto Sans Symbols 2 Subset` | the bundle's own style sheet, `client/app/assets/css/terminal-fonts.css` |
| `client/shared/config.ts` | `REMOTE_DESKTOP_QUALITIES` and `isRemoteDesktopQuality` | `src/desktop/quality.rs` for the relay, `client/shared/remote.ts` for the screen |
| `client/shared/types.ts` | `RemoteTerminalInfo` | `src/terminal/tmux.rs` for the routes, `client/shared/remote.ts` for the screen |
| `bot/bmo-server/src/verbs/machine.rs` | the `node remote-desktop` arm, with its alias `remote-desktop` and its `--port` and `--default` flags | `src/command.rs` |
| `docs/web.md` | the section 「Remote screen」 | `docs/screen.md` |
| `bot/bmo-server/tests/integration/machine_verbs.rs` | `the_remote_desktop_port_is_told_changed_refused_and_let_go_again` | deferred (「Tests deferred」) |
| `client/app/assets/css/fonts.test.ts` | the cases holding the terminal's families, `CaskaydiaCove Nerd Font Mono` and `Noto Sans Symbols 2 Subset` | deferred (「Tests deferred」) |

## Not carried: 41 files

The two lang files of the command (「The command」) and the 39 files below.

### Tests deferred: 32 files, 6,615 lines

`git ls-tree -r --name-only 3e4c032` over the set's folders, kept to `*.test.ts`. Each is written again here
once tests are, against the Rust module or the screen file it held.

| Folder | Files |
|---|---|
| `client/server/utils/` | `rdcleanpath.test.ts`, `rdp-client-info.test.ts`, `rdp-framing.test.ts`, `rdp-hangul.test.ts`, `rdp-negotiation.test.ts`, `rdp-nla.test.ts`, `rdp-pointers.test.ts`, `rdp-redirection.test.ts`, `rdp-typist.test.ts`, `remote-desktop-focus.test.ts`, `remote-desktop-keys.test.ts`, `remote-desktop-socket.test.ts`, `remote-guard.test.ts`, `remote-input-method.test.ts`, `remote-pty.test.ts`, `remote-sockets.test.ts`, `remote-terminal-socket.test.ts`, `remote-tmux.test.ts` (18) |
| `client/server/api/remote/` | `terminals.test.ts` (1) |
| `client/app/domain/remote/` | `desktop-input.test.ts`, `desktop-pointer.test.ts`, `sessions.test.ts`, `terminal-clipboard.test.ts`, `terminal-fixes.test.ts`, `terminal-hub.test.ts`, `terminal-ime.test.ts`, `terminal-touch-scroll.test.ts` (8) |
| `client/scripts/` | `ironrdp-avc420.test.ts`, `ironrdp-bundle.test.ts` (2) |
| `client/scripts/`, the bench's | `bench.test.ts`, `bench-server.test.ts`, `bench-bot.test.ts` (3): not written again, since the bench is not carried (below) |

The Korean these tests type into the IME and the desktop is test input the tested code inherently handles;
where it is written again, it is written plainly and counted in `korean-ledger.json`.

### The old dev console's bench: 3 files, 1,000 lines

`client/scripts/bench.ts`, `bench-server.ts` and `bench-bot.ts` stood up the old monolith's development
console: its ports, its copy of the archive, its account service and its tmux socket. They read the
archive's tables, which are other units', and nothing of them is this unit's behaviour. A development
instance of this service is the same binary on a settings file of its own (`docs/api.md`, 「Settings」).

### The console server's websocket plumbing: 3 files, 202 lines

| Old file | Why it is not carried |
|---|---|
| `client/server/plugins/websocket.ts` | It hung the sockets on the Nuxt server's websocket hooks. Here each socket is a route of the service's own router |
| `client/modules/dev-websocket.ts` | It relayed upgrades past the Bun development server, which hands on no websocket upgrade. This service has no development server in front of it |
| `client/server/plugins/dev-use.ts` | It wrote when the development console was last used, for the old bench's lifecycle. Nothing here reads it |

### Not this unit's: 1 file

`client/app/assets/fonts/CaskaydiaCoveNFM-Regular.subset.woff2` is the whole console's small monospace face,
which every screen uses; the terminal draws with its own faces above. It stays with the console.

### What the old console checked for this unit

`remote-guard.ts` asked for the console's sign-in and refused a websocket upgrade whose `Origin` is not the
host it was sent to. Both stay with the console, which a browser reaches; this service answers the console
alone, on a loopback address, and checks its token (`docs/api.md`, 「Who checks what」).

## Stored state: 1

| What | Old place | Here |
|---|---|---|
| the port the relay dials | archive table `settings`, key `remote_desktop_port` | this repository's store, read on every connection (`docs/api.md`, 「The store」) |

The terminal sessions, their labels and how many viewers each has are tmux's own and are kept nowhere else,
here as before.

## Secrets and settings: 3

| What | Old place | Here |
|---|---|---|
| the desktop's RDP password | the console's environment, `BMO_REMOTE_DESKTOP_PASSWORD` | the setting `desktop.password`, in the deployment's local settings file |
| the tmux socket's name | the console's environment, `BMO_REMOTE_TMUX_SOCKET`, else a name chosen by whether the console ran from a workbench | the setting `terminal.socket` |
| the tmux configuration | `remote/tmux.conf` in the tree the console ran from | the setting `terminal.config`, naming the deployed `tmux.conf` |

## Service units: 2

| Unit | Old place | Here |
|---|---|---|
| `bmo-remote.service` | none: the console server answered the routes | `deploy/bmo-remote.service`, the service itself |
| `bmo-remote-<socket>.service` | a transient user unit the console started for the tmux server | the same transient unit, started by this service with `systemd-run --user` |

## Crates and packages

- **The relay's protocol reading stands on maintained crates:** `ironrdp-rdcleanpath` for the RDCleanPath
  PDUs, `ironrdp-pdu` for the TPKT and fast-path framing and the security protocols, `sspi` for the CredSSP
  client with NTLM, and `x509-cert` with `der` for the server's certificate and a CredSSP message's length.
  The X.224 request's rewrite, the redirection packet's read, the core data's rewrite and the logon packet's
  rewrite are written by hand: decoding them with `ironrdp-pdu` and encoding them again would not keep the
  browser's own bytes, and it has no decoder for the redirection packet.
- **The pointer updates are decoded with `ironrdp-pdu`,** asked only for the pointer update codes. Turning a
  shape's masks into RGBA pixels is written by hand, since no crate draws an RDP pointer the way a browser
  cursor is drawn. A new shape's pixels reach the page in base64 through `base64`.
- **The input method is read with maintained crates:** `zbus` asks fcitx5's controller for its state on the
  account's session bus, in place of the `fcitx5-remote` command, and `rust-ini` reads fcitx5's
  configuration files for its trigger keys and its Hangul layout.
- **No crate of the old workspace is depended on.** The verb read `bmo-lang` for its lines, `bmo-policy` for
  filling them and the old server's settings module for the archive row; its lines are English here, and
  the row is this repository's store.
- **No `bmo-*` package of another unit.** The screen depends on bmo-ui alone among the base libraries.
- **Policy files:** none. Nothing in the set reads `policy/`.
