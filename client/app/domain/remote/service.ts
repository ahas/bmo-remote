// Where the remote screen calls its service (bmo-ui's console plugin contract, "How a bundle mounts"): the
// app's base path, the console's relay base, the service's name, then the path as the service's own API
// writes it. The console relays everything under that address to the service unchanged, behind its own
// sign-in, and the address is complete as given, to the app's fetcher and to a socket alike.
import { relayAddress, relaySocketAddress } from "bmo-ui/app/domain/relay";

const SERVICE = "remote";

/** The address one of the service's routes is called at. */
export function remotePath(path: string): string {
  return relayAddress(SERVICE, path);
}

/** The address one of the service's sockets is opened at, its query carried, as `ws:` or `wss:`. */
export function remoteSocketUrl(path: string, query: Record<string, string | number> = {}): string {
  const asked = new URLSearchParams(Object.entries(query).map(([name, value]) => [name, String(value)])).toString();

  return relaySocketAddress(SERVICE, asked === "" ? path : `${path}?${asked}`);
}
