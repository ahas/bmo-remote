# bmo-remote

The console's remote access as one service with its own API: terminal sessions on the machine it runs on,
held by a tmux server of their own, and that machine's desktop, reached through GNOME's remote login over RDP
by a relay the browser's IronRDP client speaks RDCleanPath to. Its own command, `bmo-remote node
remote-desktop`, tells and sets which port the relay dials. It calls no other unit; the console in front of it
hands the remote screen's requests on, as `docs/api.md` states.

## Tests

The tests in `tests/` are the repository-wide personal-data check in `tests/personal_data.rs`
(`PERSONAL-DATA.md`), which reads every tracked file for a mail address, a home path, a telephone number, a
token and a private network address; the old archive's kept desktop port taken into the store,
`tests/import.rs`; and the console bundle's routes, `tests/console.rs`: the manifest read through bmo-ui's
`consoleManifest` and held to `client/console-bundle.json`, the token and the role refused 401 and 403, and
the module's path following its bytes. They run with `cargo test`; the manifest's reading runs bun in
`client/`, whose packages the testbed's setup installs. The bundle's own tests stand in `client/tests/`: a
desktop that does not answer, tried again until it answers, refuses or is let go of, against a stand-in
desktop and a stand-in clock (`docs/remote.md`, 「A desktop that does not answer」), run by `bun run test`
inside `client/` as part of the bundle's check. The other behaviour tests are deferred: they are
written and run here once the minimal services stand on the new repositories, and until then the build check,
`cargo check --all-targets`, and the checks of the bundle and the desktop sidecar stand beside them.
`docs/inventory.md` lists the tests the old behaviour was held to.

## Layout

| Folder | Holds |
|---|---|
| `src/` | The service and its command, one crate split into its own modules |
| `migrations/` | The store, its table made by these statements in order |
| `client/` | The console plugin bundle: the remote screen, a project of its own |
| `desktop-sidecar/` | The desktop sidecar: the bun package the service starts to answer the desktop's sockets, a project of its own |
| `deploy/` | The service's user unit and the tmux configuration its sessions' server runs with |
| `tests/` | The repository-wide personal-data check and the behaviour tests that stand |
| `docs/` | The canonical statements of what the service does |
| `.graph/` | The code graph: one node per feature, the files it is made of, and the APIs it exposes and calls |

At the root stand the Cargo manifest, `VERSION`, `testbed.toml`, `rustfmt.toml`, `CLAUDE.md`,
`PERSONAL-DATA.md`, `korean-ledger.json`, `settings.toml` and `settings.local.toml.example`, the example of
the local settings a deployment gives.

## The console plugin bundle

`client/` holds the console's remote screen on bmo-ui's console plugin contract, with the IronRDP web
client's RDP backend vendored under `client/vendor/` and the script that builds it under `client/scripts/`,
and carries the TypeScript client generated from `docs/openapi.json` in `client/shared/openapi.ts`. It
reaches a console in two forms (`docs/api.md`, 「The console plugin bundle」):

- **the served module:** `bun run bundle` builds the pages with `client/module.config.ts` into `client/dist/`,
  standing in from `client/module/` what a Nuxt host would give them; the service answers it with its
  manifest at `GET /console-manifest`, and a deployment builds it in its release;
- **the layer pack:** `bun pm pack` packs `client/` as `bmo-remote-client`, a Nuxt layer on top of bmo-ui that
  declares itself in `client/console-bundle.json`, for a console that extends its bundles at build time.
  Such a host owes it bmo-ui at the version the bundle's peer names (a packed copy stands in `client/vendor/`
  for the bundle's own install and typecheck); its i18n module, which merges the bundle's own language pack
  under `client/i18n/` into the host's; the title-bar pieces `DeployMark`, `TodoOpenButton` and
  `UsageMeters`, and `useKeptTabs`, declared in `client/host/`; and a relay base under `bmoUi.relayBase`,
  with the service's own routes and sockets relayed under it (`docs/api.md`, 「What the console does」).

The screen says a refusal by its code in the pack's words. The bundle's check is `bun run check` inside
`client/`, which installs its locked packages, typechecks it, runs its tests and builds the module; the testbed
runs it as the check of a project of its own.

## Documents

| Document | States |
|---|---|
| `docs/remote.md` | The terminal sessions and the desktop: what holds them, what crosses the wire, and the boundary |
| `docs/screen.md` | The console's remote screen: its tabs, its views and its menu |
| `docs/api.md` | The routes, the sockets, their messages and refusals, the command, the store, the settings, the console plugin bundle and what the console does |
| `docs/inventory.md` | What this repository takes from the old repository, with each set's count and source |
| `PERSONAL-DATA.md` | What may never stand in this repository: a person's name, address, path, device or network details, a room member's, a company's, or a line of an actual conversation, and the check that holds it |

## Version

`VERSION` holds the repository's version, shared by the crate and the console plugin bundle. Until the first
release it is `0.1.0` plus a revision suffix; `docs/api.md`, 「Versions」, states the rule.
