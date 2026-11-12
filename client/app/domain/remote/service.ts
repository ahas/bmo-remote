// Where the remote screen calls its service: a route through bmo-ui's relay module's call, and a socket at the
// address the same module answers (bmo-ui's console plugin contract, "How a bundle mounts").
import { relayCall, relaySocketAddress } from "bmo-ui/app/domain/relay";

import type { RelayOptions } from "bmo-ui/app/domain/relay";

const SERVICE = "remote";

/** One of the service's routes called through the console's relay, its answer as the app's fetcher reads it. */
export function remoteCall<T = unknown>(path: string, options?: RelayOptions): Promise<T> {
  return relayCall<T>(SERVICE, path, options);
}

/** The address one of the service's sockets is opened at, its query carried, as `ws:` or `wss:`. */
export function remoteSocketUrl(path: string, query: Record<string, string | number> = {}): string {
  const asked = new URLSearchParams(Object.entries(query).map(([name, value]) => [name, String(value)])).toString();

  return relaySocketAddress(SERVICE, asked === "" ? path : `${path}?${asked}`);
}
