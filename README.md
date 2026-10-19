# bmo-remote

The console's remote access as one service with its own API: terminal sessions on the machine it runs on,
held by a tmux server of their own, and that machine's desktop, reached through GNOME's remote login over RDP
by a relay the browser's IronRDP client speaks RDCleanPath to. Its own command, `bmo-remote node
remote-desktop`, tells and sets which port the relay dials. It calls no other unit; the console in front of it
hands the remote screen's requests on, as `docs/api.md` states.

## Tests are deferred

No test is carried, written or run in this repository yet. The tests are written and run here once the
minimal services stand on the new repositories; until then the only check is the build check, `cargo check
--all-targets` and the bundle's typecheck. `docs/inventory.md` lists the tests the old behaviour was held to.

## Layout

| Folder | Holds |
|---|---|
| `src/` | The service and its command, one crate split into its own modules |
| `migrations/` | The store, its table made by these statements in order |
| `deploy/` | The service's user unit and the tmux configuration its sessions' server runs with |
| `docs/` | The canonical statements of what the service does |

At the root stand the Cargo manifest, `VERSION`, `testbed.toml`, `rustfmt.toml`, `CLAUDE.md`,
`korean-ledger.json`, `settings.toml` and `settings.local.toml.example`, the example of the local settings a
deployment gives.

## Documents

| Document | States |
|---|---|
| `docs/remote.md` | The terminal sessions and the desktop: what holds them, what crosses the wire, and the boundary |
| `docs/screen.md` | The console's remote screen: its tabs, its views and its menu |
| `docs/api.md` | The routes, the sockets, their messages and refusals, the command, the store, the settings, the console plugin bundle and what the console does |
| `docs/inventory.md` | What this repository takes from the old repository, with each set's count and source |

## Version

`VERSION` holds the repository's version in semver, the crate's own. `docs/api.md`, 「Versions」, says which
change moves which part.
