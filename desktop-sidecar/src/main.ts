import { desktopKeysEndpoint } from "./remote-desktop-keys";
import { desktopEndpoint, desktopPointerEndpoint } from "./remote-desktop-socket";
import { createSocketHooks } from "./remote-sockets";
import { sidecarHost, sidecarPort } from "./settings";

import type { ServerWebSocket } from "bun";
import type { SocketPeerLike } from "./remote-sockets";

// The desktop sidecar (docs/api.md, 「The desktop sidecar」): the desktop's three websockets, answered on the
// loopback address for the service, which takes the browser's upgrades and hands them on here. Each socket
// says which path is its own, and a path none claims is refused.

const hooks = createSocketHooks({
  baseURL: "/",
  endpoints: () => [desktopEndpoint, desktopPointerEndpoint, desktopKeysEndpoint]
});

interface Held {
  url: string;
  peer?: SocketPeerLike;
}

// The socket as the endpoints know a peer: one object for as long as it is open.
function peerOf(socket: ServerWebSocket<Held>): SocketPeerLike {
  socket.data.peer ??= {
    id: crypto.randomUUID(),
    request: { url: socket.data.url },
    send: (data) => socket.send(data as string | Uint8Array),
    close: (code, reason) => socket.close(code, reason)
  };

  return socket.data.peer;
}

// What an endpoint's handler failed with goes to the log, and the socket stays as the endpoint left it.
function settle(handled: unknown, what: string): void {
  Promise.resolve(handled).catch((error: unknown) => console.error(`desktop sidecar: ${what} failed:`, error));
}

const text = new TextEncoder();

const server = Bun.serve<Held>({
  hostname: sidecarHost(),
  port: sidecarPort(),
  async fetch(request, server) {
    try {
      await hooks.upgrade({ url: request.url, headers: request.headers });
    } catch (refusal) {
      if (refusal instanceof Response) return refusal;

      throw refusal;
    }

    if (server.upgrade(request, { data: { url: request.url } })) return undefined;

    return new Response("Upgrade Required", { status: 426 });
  },
  websocket: {
    open(socket) {
      settle(hooks.open(peerOf(socket)), "open");
    },
    message(socket, message) {
      const bytes = typeof message === "string" ? text.encode(message) : new Uint8Array(message);

      settle(hooks.message(peerOf(socket), { uint8Array: () => bytes }), "a message");
    },
    close(socket) {
      settle(hooks.close(peerOf(socket)), "close");
    }
  }
});

console.error(`desktop sidecar: listening on ${server.hostname}:${server.port}`);
