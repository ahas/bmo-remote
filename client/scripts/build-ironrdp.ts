// Builds the RDP backend the remote desktop screen runs on (docs/remote.md, 「How it is reached」):
// IronRDP's own web client at a pinned upstream commit, with the graphics pipeline attached by the
// patch kept beside the build and its H.264 pictures handed to the browser's decoder in avc420.js
// beside it, written into client/vendor/iron-remote-desktop-rdp.
//
//   bun client/scripts/build-ironrdp.ts [work directory]
//
// It needs git, npm, rustup and wasm-pack on the path; the work directory, the user's cache by default,
// holds the checkout and the Rust build between runs.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { unbaseInlinedWasm } from "./ironrdp-bundle";

export const IRONRDP_REPOSITORY = "https://github.com/Devolutions/IronRDP.git";
export const IRONRDP_COMMIT = "b149f500b85124c513646494335fb6cee525d897";

const vendor = resolve(import.meta.dir, "../vendor/iron-remote-desktop-rdp");
const work = resolve(process.argv[2] ?? join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "bmo-remote", "ironrdp"));
const checkout = join(work, "IronRDP");

function run(command: string, args: string[], cwd: string): void {
  console.log(`$ ${command} ${args.join(" ")}  (${cwd})`);

  const done = spawnSync(command, args, { cwd, stdio: "inherit" });

  if (done.status !== 0) {
    console.error(`${command} failed (exit code ${done.status})`);
    process.exit(1);
  }
}

mkdirSync(work, { recursive: true });

if (!existsSync(checkout)) run("git", ["clone", "--quiet", IRONRDP_REPOSITORY, "IronRDP"], work);

run("git", ["fetch", "--quiet", "origin", IRONRDP_COMMIT], checkout);
run("git", ["checkout", "--quiet", "--force", IRONRDP_COMMIT], checkout);
run("git", ["clean", "--quiet", "-fd", "crates"], checkout);
run("git", ["apply", join(vendor, "egfx.patch")], checkout);
copyFileSync(join(vendor, "avc420.js"), join(checkout, "crates/ironrdp-web/src/avc420.js"));
run("rustup", ["target", "add", "wasm32-unknown-unknown"], checkout);
run("wasm-pack", ["build", "--target", "web"], join(checkout, "crates/ironrdp-web"));

const client = join(checkout, "web-client/iron-remote-desktop-rdp");

run("npm", ["install", "--no-audit", "--no-fund"], client);
run("npm", ["run", "build-alone"], client);

copyFileSync(join(client, "dist/index.d.ts"), join(vendor, "index.d.ts"));
writeFileSync(join(vendor, "iron-remote-desktop-rdp.js"), unbaseInlinedWasm(readFileSync(join(client, "dist/iron-remote-desktop-rdp.js"), "utf8")));

// The package keeps the upstream manifest, marked as this build.
const manifest = JSON.parse(readFileSync(join(client, "dist/package.json"), "utf8")) as { version: string };

manifest.version = `${manifest.version}-egfx.${IRONRDP_COMMIT.slice(0, 7)}`;
writeFileSync(join(vendor, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Wrote ${manifest.version} to ${vendor}.`);
