import { createFocusSource } from "./remote-desktop-focus";
import { desktopSocket, pointerChannelOf } from "./remote-desktop-socket";
import { readKeysMessage } from "./rdp-typist";

import type { KeysMessage } from "./rdp-typist";
import type { SocketEndpoint, SocketMessageLike, SocketPeerLike } from "./remote-sockets";

// The desktop's keys socket (docs/remote.md, 「The on-screen keyboard」). It names the channel of the
// page's connection, as the pointer socket does, and what the on-screen keyboard sends over it is
// typed into that connection's own stream by the relay. A socket naming no valid channel is closed
// at once. Each joined socket is also told when a text field on the desktop takes focus or lets it go
// (「A text field taking focus」).

export type TypeInto = (channel: string, message: KeysMessage) => Promise<void>;

export interface FocusSource {
  subscribe: (listener: (editable: boolean) => void) => () => void;
}

export function createKeysSocket(type: TypeInto, focus: FocusSource) {
  const joined = new Map<string, string>();
  const unfollow = new Map<string, () => void>();
  const text = new TextDecoder();

  return {
    open(peer: SocketPeerLike): void {
      const channel = pointerChannelOf(peer.request.url);

      if (channel === null) {
        peer.close(1008, "no channel");

        return;
      }

      joined.set(peer.id, channel);
      peer.send(JSON.stringify({ type: "ready" }));
      unfollow.set(peer.id, focus.subscribe((editable) => peer.send(JSON.stringify({ type: "focus", editable }))));
    },
    message(peer: SocketPeerLike, incoming: SocketMessageLike): Promise<void> | undefined {
      const channel = joined.get(peer.id);
      const message = channel === undefined ? null : readKeysMessage(text.decode(incoming.uint8Array()));

      if (channel === undefined || message === null) return undefined;

      return type(channel, message);
    },
    close(peer: SocketPeerLike): void {
      joined.delete(peer.id);
      unfollow.get(peer.id)?.();
      unfollow.delete(peer.id);
    },
    joined
  };
}

const keysSocket = createKeysSocket((channel, message) => desktopSocket().type(channel, message), createFocusSource());

// The keys socket as one of the console's websocket endpoints.
export const desktopKeysEndpoint: SocketEndpoint = {
  claims: (path) => path === "/desktop/keys",
  open: (peer) => keysSocket.open(peer),
  message: (peer, message) => keysSocket.message(peer, message),
  close: (peer) => keysSocket.close(peer)
};
