# bmo-remote

The console's remote access as one service with its own API: terminal sessions on the machine it runs on,
held by a tmux server of their own, and that machine's desktop, reached through GNOME's remote login over RDP
by a relay the browser's IronRDP client speaks RDCleanPath to. Its own command, `bmo-remote node
remote-desktop`, tells and sets which port the relay dials. It calls no other unit; the console in front of it
hands the remote screen's requests on, as `docs/api.md` states.

## Tests are deferred

No test is carried, written or run in this repository yet. The tests are written and run here once the
minimal services stand on the new repositories; until then the only check is the build check, `cargo check
--all-targets`, and the typechecks of the bundle and the desktop sidecar. `docs/inventory.md` lists the tests the old behaviour was held to.

## Layout

| Folder | Holds |
|---|---|
| `src/` | The service and its command, one crate split into its own modules |
| `migrations/` | The store, its table made by these statements in order |
| `client/` | The console plugin bundle: the remote screen, a project of its own |
| `desktop-sidecar/` | The desktop sidecar: the bun package the service starts to answer the desktop's sockets, a project of its own |
| `deploy/` | The service's user unit and the tmux configuration its sessions' server runs with |
| `docs/` | The canonical statements of what the service does |

At the root stand the Cargo manifest, `VERSION`, `testbed.toml`, `rustfmt.toml`, `CLAUDE.md`,
`korean-ledger.json`, `settings.toml` and `settings.local.toml.example`, the example of the local settings a
deployment gives.

## The console plugin bundle

`client/` holds the console's remote screen as a Nuxt layer on top of bmo-ui, packed as `bmo-remote-client`,
with the IronRDP web client's RDP backend vendored under `client/vendor/` and the script that builds it under
`client/scripts/`. A host console extends it as it extends bmo-ui, and owes it:

- bmo-ui itself, at the version the bundle's peer names; for the bundle's own install and typecheck a packed
  copy stands in `client/vendor/`;
- its i18n module, which merges the bundle's own language pack under `client/i18n/locales/` into the host's,
  and a pack answering the few keys every screen shares (`docs/api.md`, 「The console plugin bundle」);
- the title-bar pieces `DeployMark`, `TodoOpenButton` and `UsageMeters`, and `useKeptTabs`, declared in
  `client/host/`;
- the routes and sockets under `/api/remote/` handed on to this service (`docs/api.md`, 「What the console
  does」).

The screen says a refusal by its code in the pack's words. The bundle's check is `bun run check` inside
`client/`, which installs its locked packages and typechecks it; the testbed runs it as the check of a project
of its own.

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
