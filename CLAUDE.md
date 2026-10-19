# Working in bmo-remote

## The three standing principles

These hold every bmo-next repository, and every change here:

(a) each service runs on its own, with no context bleeding in from other repositories: it builds, tests and
runs from its own repository, data and settings, and never reads another repository's code, files, data
folders or tables; (b) services talk to each other only through documented APIs (HTTP routes, events, a
documented command), never by importing another service's code; (c) references run one way: lower code uses
the base, and the base never knows what is below it (no per-provider branch such as `if telegram`, no list of
the units below, no dependency on any service); where two repositories must know the same policy value, the
lowest service in the dependency direction owns it and the ones above read it through that service's API;
and each repository holds only what it uses itself, since the same thing kept in several places is the wrong
structure (archive document #301, 「원칙」).

## The documents come first

- `docs/` is the canonical statement of what the service does; the code is one realisation of it. Before
  changing code, read the document covering that area: `docs/remote.md` for the terminal sessions and the
  desktop relay, `docs/screen.md` for the console's remote screen, `docs/api.md` for the routes, the sockets,
  the command, the store, the settings and the console plugin bundle.
- A change that would make a document wrong or incomplete repairs the document first, stating what is true
  now, and the code is written to match.
- A document states what is true now: no change history, no rationale told through an earlier design, no
  pasted source, signature or config fragment, and no file-and-line pins.

## Boundaries

- **No other unit is called.** The console in front of the service checks the sign-in and the `Origin`; the
  service checks its bearer token and listens on a loopback address (`docs/api.md`, 「Who checks what」).
  Every other unit is reached through its API, never through its code, its tables or its files.
- **A client of another service is one module named for that service** under `src/clients/`, holding only
  the calls this repository makes, so it can be swapped for that service's own client.
- **Dependencies:** crates from the registry pinned in `Cargo.toml`, and among other repositories only the
  base libraries `bmo-chat`, `bmo-chat-client`, `bmo-ui` and `bmo-markup`.
- **The plumbing knows no route.** A route or a socket registers itself beside its own answer; adding one
  changes no file but its own.
- **The relay is a transparent pipe.** It never runs an RDP connection of its own; it rewrites and reads only
  what `docs/remote.md`, 「How it is reached」, names.
- **No lookup table standing in for polymorphism.** A value that differs per kind of message or per socket
  belongs to that kind or that socket.
- **No hand-written parser for a general format.** TOML, JSON, HTTP headers, command lines, DER and their kin
  are read by a maintained library; an RDP structure is read with `ironrdp-pdu` where it carries the type.

## Language

- Everything in this repository is English: code, comments, strings, tests, documents, commit messages and
  branch names.
- **Hangul the code inherently handles** — the 두벌식 keys a syllable is typed as, the terminal IME's
  composition — is written plainly, never as an escape or a character code, and each file's count of lines
  holding it stands in `korean-ledger.json`. No other Korean stands in code or tests.
- What the service answers is an English sentence for a log and a snake_case code a screen shows in its own
  language's words (`docs/api.md`, 「Refusals」). The screen's words stand in bmo-web's language pack.
- No personal data: no user names, home directories, machine names, internal addresses or names of any
  agent. What the service needs at runtime comes from its settings, never from the code.

## Layout

- `Cargo.toml` is the only manifest at the root, one crate split into its own modules, and no directory is
  named after its parent.
- The console plugin bundle stands in `client/`, a project of its own.
- Tests live in `tests/`; no test module stands in `src/`. The tests are deferred for now (README.md).

## The stages of a change

1. **Writing:** the only check is `cargo check --all-targets`, and for the bundle its typecheck.
2. **Review:** read the whole diff against the document governing it, then `cargo fmt --all --check` and
   `cargo clippy --all-targets -- -D warnings`.
3. **Verification:** the tests touched, then the whole suite once, output written to a file and the file
   read. Until the deferred tests stand, a change reaches stage 2 and is reported as such.
