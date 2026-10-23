// Where the remote screen calls its service (bmo-ui's console plugin contract, "How a bundle mounts"):
// the console's relay base, the service's name, then the path as the service's own API writes it. The
// console relays everything under that address to the service unchanged, behind its own sign-in.
import { relayAddress } from "bmo-ui/app/domain/relay";

const SERVICE = "remote";

/** The address one of the service's routes is called at. */
export function remotePath(path: string): string {
  return relayAddress(SERVICE, path);
}

// A route's address is resolved under the app's base path by the host's `$fetch`; a socket is opened by hand,
// so its address is put under that base here, where it does not already stand there, as `$fetch` does.
function underAppBase(address: string): string {
  const base = useRuntimeConfig().app.baseURL.replace(/\/+$/, "");

  return base === "" || address === base || address.startsWith(`${base}/`) ? address : `${base}${address}`;
}

/** The address one of the service's sockets is opened at, its query carried, as `ws:` or `wss:`. */
export function remoteSocketUrl(path: string, query: Record<string, string | number> = {}): string {
  const url = new URL(underAppBase(remotePath(path)), location.href);

  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";

  for (const [name, value] of Object.entries(query)) url.searchParams.set(name, String(value));

  return url.toString();
}
