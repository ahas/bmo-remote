// What the sidecar reads of its environment: every value is the service's own setting, handed over by the
// service as it starts the sidecar (docs/api.md, 「The desktop sidecar」). The desktop password is read where
// the relay uses it, under `BMO_REMOTE_DESKTOP_PASSWORD`.

export class SettingMissing extends Error {
  constructor(name: string) {
    super(`${name} is not set: the service gives it as it starts the sidecar`);
  }
}

function setting(name: string): string {
  const written = process.env[name];

  if (written === undefined || written === "") {
    throw new SettingMissing(name);
  }

  return written;
}

function port(name: string): number {
  const written = setting(name);
  const read = Number(written);

  if (!Number.isInteger(read) || read <= 0 || read > 65_535) {
    throw new Error(`${name} is not a port: ${written}`);
  }

  return read;
}

// The loopback address the sidecar listens on.
export function sidecarHost(): string {
  return setting("BMO_REMOTE_SIDECAR_HOST");
}

// The port the sidecar listens on.
export function sidecarPort(): number {
  return port("BMO_REMOTE_SIDECAR_PORT");
}

// The bearer the service presents on every upgrade it hands on.
export function sidecarToken(): string {
  return setting("BMO_REMOTE_SIDECAR_TOKEN");
}

// The RDP server's address, `desktop.host`.
export function desktopHostSetting(): string {
  return setting("BMO_REMOTE_DESKTOP_HOST");
}

// The RDP server's port where the store holds none, `desktop.port`.
export function desktopPortSetting(): number {
  return port("BMO_REMOTE_DESKTOP_PORT");
}

// The service's store, `store.path`, which holds the port the relay dials.
export function storePath(): string {
  return setting("BMO_REMOTE_STORE_PATH");
}
