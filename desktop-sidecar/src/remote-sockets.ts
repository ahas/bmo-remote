import { guardUpgrade } from "./guard";

// Every websocket the console serves (docs/remote.md, 「The boundary」). Nitro finds a websocket's
// handler by its route, and under a base path the static-file middleware standing on that base is
// found first, so no route's own handler is ever reached. The console's sockets are therefore
// answered from the websocket layer's own hooks: each endpoint says which paths are its own, and a
// path no endpoint claims is refused.

export interface SocketPeerLike {
  id: string;
  request: { url: string };
  send: (data: unknown) => unknown;
  close: (code?: number, reason?: string) => void;
}

export interface SocketMessageLike {
  uint8Array: () => Uint8Array;
}

export interface SocketEndpoint {
  // The path below the console's base, without the query.
  claims: (path: string) => boolean;
  open: (peer: SocketPeerLike) => unknown;
  message: (peer: SocketPeerLike, message: SocketMessageLike) => unknown;
  close: (peer: SocketPeerLike) => unknown;
}

interface UpgradeLike {
  url: string;
  headers: Headers;
}

export function socketPath(url: string, baseURL: string): string | null {
  const pathname = new URL(url, "http://localhost").pathname;
  const base = baseURL.endsWith("/") ? baseURL : `${baseURL}/`;

  return pathname.startsWith(base) ? `/${pathname.slice(base.length)}` : null;
}

export function createSocketHooks(options: {
  baseURL: string;
  endpoints: () => SocketEndpoint[];
  guard?: (request: UpgradeLike) => Promise<void>;
}) {
  const guard = options.guard ?? guardUpgrade;

  function endpointOf(url: string): SocketEndpoint | undefined {
    const path = socketPath(url, options.baseURL);

    return path === null ? undefined : options.endpoints().find((one) => one.claims(path));
  }

  return {
    async upgrade(request: UpgradeLike): Promise<void> {
      if (!endpointOf(request.url)) throw new Response("Not Found", { status: 404 });

      await guard(request);
    },
    open(peer: SocketPeerLike) {
      return endpointOf(peer.request.url)?.open(peer);
    },
    message(peer: SocketPeerLike, message: SocketMessageLike) {
      return endpointOf(peer.request.url)?.message(peer, message);
    },
    close(peer: SocketPeerLike) {
      return endpointOf(peer.request.url)?.close(peer);
    },
    error(peer: SocketPeerLike) {
      return endpointOf(peer.request.url)?.close(peer);
    }
  };
}
