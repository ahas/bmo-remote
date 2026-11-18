# bmo-remote

The console's remote access as one service with its own API: terminal sessions on the machine it runs on,
held by a tmux server of their own, and that machine's desktop, reached through GNOME's remote login over RDP
by a relay the browser's IronRDP client speaks RDCleanPath to. Its own command, `bmo-remote node
remote-desktop`, tells and sets which port the relay dials. It calls no other unit; the console in front of it
hands the remote screen's requests on, as `docs/api.md` states.

## Tests

The testbed's `personal-data` check reads every tracked file for a mail address, a home path, a telephone
number, a token and a private network address (`PERSONAL-DATA.md`). The tests in `tests/` are the old archive's kept desktop port taken into the store,
`tests/import.rs`; and the console face, `tests/console.rs`: the manifest the service serves read through
bmo-ui's own reading on the release the client vendors, the service's declaration and credentials wired to
bmo-chat's console face, the console's credential and the reader's role asked where the screen needs them, and
the service's own token refused on the face and taken on the screen's routes. The face's own rules are its
crate's tests'. They run with `cargo test`; the manifest's reading runs bun on the vendored release file.
A test that writes files writes them in a folder of its own under the system's temporary folder, and a test
that starts a tmux server starts it on a socket of its own; both are taken down when the test ends, whether it
passes or panics.
The bundle's own tests stand in `client/tests/`: a desktop that does not answer, tried again until it
answers, refuses or is let go of, against a stand-in desktop and a stand-in clock (`docs/remote.md`, 「A
desktop that does not answer」), run by `bun run test` inside `client/` as part of the bundle's check. The other behaviour tests are deferred: they are
written and run here once the minimal services stand on the new repositories, and until then the testbed's
own static check of the crate, which formats it and lints it with every target compiled, and the checks of the
bundle and the desktop sidecar stand beside them.
`docs/inventory.md` lists the tests the old behaviour was held to.

## Layout

| Folder | Holds |
|---|---|
| `src/` | The service and its command, one crate split into its own modules |
| `migrations/` | The store, its table made by these statements in order |
| `client/` | The console plugin bundle: the remote screen, a project of its own |
| `desktop-sidecar/` | The desktop sidecar: the bun package the service starts to answer the desktop's sockets, a project of its own |
| `deploy/` | The service's user unit and the tmux configuration its sessions' server runs with |
| `tests/` | The behaviour tests that stand |
| `docs/` | The canonical statements of what the service does |

At the root stand the Cargo manifest, `VERSION`, `testbed.toml`, `rustfmt.toml`, `CLAUDE.md`,
`PERSONAL-DATA.md`, `korean-ledger.json`, `settings.toml` and `settings.local.toml.example`, the example of
the local settings a deployment gives.

## The console plugin bundle

`client/` holds the console's remote screen as a bundle of bmo-ui's console plugin contract, with the IronRDP
web client's RDP backend vendored under `client/vendor/` and the script that builds it under `client/scripts/`,
and carries the TypeScript client generated from `docs/openapi.json` in `client/shared/openapi.ts`. It is built
on the bmo-ui release bmo-chat's `shared-versions.toml` pins, vendored under `client/vendor/`: `bun run bundle`
builds the pages with bmo-ui's bundle build into `client/dist/`, standing in from `client/module/` what no
console gives them, and the service answers it through bmo-chat's console face, a deployment building it in
its release (`docs/api.md`, 「The console face」, 「The console plugin bundle」).

The screen says a refusal by its code in the pack's words. The bundle's check is `bun run check` inside
`client/`, which installs its locked packages, typechecks it, runs its tests and builds the module; the testbed
runs it as the check of a project of its own.

## Documents

| Document | States |
|---|---|
| `docs/remote.md` | The terminal sessions and the desktop: what holds them, what crosses the wire, and the boundary |
| `docs/screen.md` | The console's remote screen: its tabs, its views and its menu |
| `docs/api.md` | The routes, the sockets, their messages and refusals, the command, the store, the settings, the console face, the console plugin bundle and what the console does |
| `docs/inventory.md` | What this repository takes from the old repository, with each set's count and source |
| `PERSONAL-DATA.md` | What may never stand in this repository: a person's name, address, path, device or network details, a room member's, a company's, or a line of an actual conversation, and the check that holds it |

## Version

`VERSION` holds the repository's version, shared by the crate and the console plugin bundle. Until the first
release it is `0.1.0` plus a revision suffix; `docs/api.md`, 「Versions」, states the rule.
