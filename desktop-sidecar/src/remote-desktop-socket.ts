import { userInfo } from "node:os";

import {
  CleanPathError,
  GENERAL_ERROR,
  NEGOTIATION_ERROR,
  decodeRequest,
  encodeError,
  rewriteCoreData,
  encodeResponse,
  tpktLength
} from "./rdcleanpath";

import { isRemoteDesktopQuality } from "./quality";

import { createClientFraming, createServerFraming, fastPathUpdates } from "./rdp-framing";
import { pointerMessage, readPointerUpdate } from "./rdp-pointers";
import { PERFORMANCE_FLAGS, rewriteClientInfo } from "./rdp-client-info";

import { NlaError, createNlaClient, derLength, subjectPublicKey } from "./rdp-nla";
import {
  PROTOCOL_HYBRID,
  PROTOCOL_SSL,
  readConnectionRequest,
  routingToken,
  selectedProtocol,
  withSelectedProtocol,
  writeConnectionRequest
} from "./rdp-negotiation";
import { readRedirection } from "./rdp-redirection";
import { createDesktopTypist } from "./rdp-typist";
import { readInputMethod } from "./remote-input-method";
import { desktopHostSetting, desktopPortSetting } from "./settings";
import { useStoreSql } from "./store";

import type { ClientInfoChange } from "./rdp-client-info";
import type { NlaCredentials } from "./rdp-nla";
import type { Redirection } from "./rdp-redirection";
import type { KeysMessage, TypistTiming } from "./rdp-typist";
import type { InputMethod } from "./remote-input-method";

import type { SocketEndpoint, SocketMessageLike, SocketPeerLike } from "./remote-sockets";

// The desktop websocket (docs/remote.md, 「The relay」): answers the browser's RDCleanPath request
// by dialling this PC's gnome-remote-desktop, turning that connection into TLS, authenticating for
// the browser, and relaying bytes from then on.

// The only machine the desktop reaches, and the port its RDP server listens on unless the store
// names another (docs/remote.md, 「Where the desktop is」).
export const DESKTOP_HOST = desktopHostSetting();
export const DEFAULT_DESKTOP_PORT = desktopPortSetting();
export const DESKTOP_PORT_KEY = "desktop_port";

export async function desktopPort(read: () => string | null | Promise<string | null> = readDesktopPortSetting): Promise<number> {
  const value = Number(await read());

  return Number.isInteger(value) && value > 0 && value < 65536 ? value : DEFAULT_DESKTOP_PORT;
}

async function readDesktopPortSetting(): Promise<string | null> {
  try {
    const row = await useStoreSql().get("SELECT value FROM kept_values WHERE key = ?", DESKTOP_PORT_KEY) as { value: string } | null;

    return row?.value ?? null;
  } catch {
    return null;
  }
}

export async function desktopTarget(): Promise<{ host: string; port: number }> {
  return { host: DESKTOP_HOST, port: await desktopPort() };
}

// Each step of the handshake is local and quick; one standing longer than this has failed.
const STEP_TIMEOUT_MS = 8_000;

export interface RdpUpstream {
  write: (bytes: Uint8Array) => void;
  end: () => void;
}

export interface DialHandlers {
  // The server's X.224 confirm and its certificate, once the connection is TLS and, where the relay
  // authenticates, past NLA.
  ready: (confirm: Uint8Array, certificate: Uint8Array) => void;
  data: (bytes: Uint8Array) => void;
  // A failure before `ready`, with the RDCleanPath error it is reported as.
  failed: (failure: DialFailure) => void;
  closed: () => void;
}

// The credentials the relay runs NLA with, where it authenticates for the browser.
export type Dial = (
  target: { host: string; port: number },
  request: Uint8Array,
  handlers: DialHandlers,
  nla?: NlaCredentials | null
) => RdpUpstream;

// WSA codes are what an RDCleanPath client understands for socket failures.
const WSA_CONNECTION_REFUSED = 10061;
const WSA_TIMED_OUT = 10060;
// What a refused NLA is reported as: the browser shows it as a refused logon.
const HTTP_UNAUTHORIZED = 401;
const HTTP_BAD_REQUEST = 400;

export type DialFailure = { code: number; httpStatus?: number; tlsAlert?: number; wsaError?: number };

// Which failure before the answer this was, in words for the console's log (docs/remote.md, 「The
// relay」).
export function failureReason(failure: DialFailure): string {
  if (failure.httpStatus === HTTP_BAD_REQUEST) return "the request could not be read";
  if (failure.httpStatus === HTTP_UNAUTHORIZED) return "the desktop refused the credentials";
  if (failure.wsaError === WSA_CONNECTION_REFUSED) return "the desktop did not accept the connection";
  if (failure.wsaError === WSA_TIMED_OUT) return `a step stood longer than ${STEP_TIMEOUT_MS / 1000} seconds`;
  if (failure.code === NEGOTIATION_ERROR) return "the negotiation or its TLS handshake failed";

  return `failure ${JSON.stringify(failure)}`;
}

// Dials the RDP server with Bun's sockets: the X.224 request in the clear, one TPKT confirm back,
// then TLS on the same connection without checking the certificate — the peer is this machine,
// and its certificate is its own self-signed one. Where the server chose NLA and the relay was given
// credentials, CredSSP runs next, before the browser hears anything.
export const dialRdp: Dial = (target, request, handlers, nla) => {
  let plain: Bun.Socket<undefined> | undefined;
  let secure: Bun.Socket<undefined> | undefined;
  let received = new Uint8Array();
  let settled = false;
  let ended = false;

  const timer = setTimeout(() => fail({ code: GENERAL_ERROR, wsaError: WSA_TIMED_OUT }), STEP_TIMEOUT_MS);

  function fail(failure: DialFailure): void {
    if (settled) return;

    settled = true;
    clearTimeout(timer);
    handlers.failed(failure);
    stop();
  }

  function stop(): void {
    if (ended) return;

    ended = true;
    clearTimeout(timer);
    secure?.end();
    plain?.end();
  }

  function succeed(confirm: Uint8Array, certificate: Uint8Array): void {
    settled = true;
    clearTimeout(timer);
    handlers.ready(confirm, certificate);
  }

  function upgrade(socket: Bun.Socket<undefined>, confirm: Uint8Array): void {
    const authenticate = nla && selectedProtocol(confirm) === PROTOCOL_HYBRID ? nla : null;
    let credssp: ReturnType<typeof createNlaClient> | null = null;
    let certificate = new Uint8Array();
    let pending = new Uint8Array();

    const [, tls] = socket.upgradeTLS<undefined>({
      tls: { rejectUnauthorized: false },
      socket: {
        // The certificate is taken whether or not it verifies: the peer is this machine with its own
        // self-signed certificate, and Bun reports such a handshake as unauthorized even with
        // verification off. A handshake that did not finish shows no certificate at all.
        handshake(peer) {
          const x509 = peer.getPeerX509Certificate?.();

          if (!x509) {
            fail({ code: NEGOTIATION_ERROR });

            return;
          }

          certificate = new Uint8Array(x509.raw);

          if (!authenticate) {
            succeed(confirm, certificate);

            return;
          }

          try {
            const spki = new Uint8Array(x509.publicKey.export({ type: "spki", format: "der" }));

            credssp = createNlaClient(authenticate, subjectPublicKey(spki));
            peer.write(credssp.start());
          } catch {
            fail({ code: NEGOTIATION_ERROR });
          }
        },
        data(peer, bytes) {
          if (settled) {
            if (!ended) handlers.data(new Uint8Array(bytes));

            return;
          }

          if (!credssp) return;

          pending = join(pending, new Uint8Array(bytes));

          try {
            for (let length = derLength(pending); length !== null && pending.length >= length; length = derLength(pending)) {
              const message = pending.slice(0, length);

              pending = pending.slice(length);

              const step = credssp.next(message);

              peer.write(step.send);

              if (step.done) {
                succeed(confirm, certificate);

                return;
              }
            }
          } catch (error) {
              fail(error instanceof NlaError && error.refused ? { code: GENERAL_ERROR, httpStatus: HTTP_UNAUTHORIZED } : { code: NEGOTIATION_ERROR });
          }
        },
        close() {
          if (settled) finish();
          else fail({ code: NEGOTIATION_ERROR });
        },
        error() {
          if (settled) finish();
          else fail({ code: NEGOTIATION_ERROR });
        }
      }
    });

    secure = tls;
  }

  function finish(): void {
    if (ended) return;

    stop();
    handlers.closed();
  }

  Bun.connect<undefined>({
    hostname: target.host,
    port: target.port,
    socket: {
      open(socket) {
        plain = socket;
        socket.write(request);
      },
      data(socket, bytes) {
        if (secure || settled) return;

        received = join(received, new Uint8Array(bytes));

        let length: number | null;

        try {
          length = tpktLength(received);
        } catch {
          fail({ code: NEGOTIATION_ERROR });

          return;
        }

        if (length !== null) upgrade(socket, received.slice(0, length));
      },
      close() {
        if (!secure) fail({ code: NEGOTIATION_ERROR });
      },
      error() {
        if (!secure) fail({ code: GENERAL_ERROR, wsaError: WSA_CONNECTION_REFUSED });
      }
    }
  }).catch(() => fail({ code: GENERAL_ERROR, wsaError: WSA_CONNECTION_REFUSED }));

  return {
    write(bytes) {
      if (!ended) secure?.write(bytes);
    },
    end: stop
  };
};

function join(first: Uint8Array, second: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(first.length + second.length);

  out.set(first);
  out.set(second, first.length);

  return out;
}

interface Relay {
  upstream?: RdpUpstream;
  relaying: boolean;
  // Frames still to be searched for the client's core data, where the protocol chosen is written back.
  coreSearch: number;
  // Frames still to be searched for the client's logon packet, and what to change in it.
  infoSearch: number;
  info: ClientInfoChange;
  // What the server sends, cut into its PDUs.
  serverFraming: ReturnType<typeof createServerFraming>;
  // The page's channel for this connection: where its pointer shapes go, and what its keys socket names.
  pointer: string | null;
  // The protocol the server chose, where the relay ran NLA for the browser and told it TLS.
  hidden: number | null;
  // Set once the server has redirected the connection; nothing more of it is passed on.
  redirected: boolean;
  // Where the client's own PDUs end, and what the relay has to type once one has (「The on-screen
  // keyboard」).
  clientFraming: ReturnType<typeof createClientFraming>;
  typing: Uint8Array[];
  typist: ReturnType<typeof createDesktopTypist>;
}

// The logon packet follows the channel joins; the client's frames up to it are few.
const INFO_SEARCH_FRAMES = 32;

// Where the password the console logs on with comes from. It is the service's setting, handed to
// the sidecar in its environment, and is never sent to a page.
export function desktopPassword(): string | null {
  const configured = process.env.BMO_REMOTE_DESKTOP_PASSWORD ?? "";

  return configured === "" ? null : configured;
}

// A pointer channel's name: what the page makes up for one connection.
const POINTER_ID = /^[a-z0-9]{8,40}$/;

function queryOf(url: string, name: string): string | null {
  try {
    return new URL(url, "http://localhost").searchParams.get(name);
  } catch {
    return null;
  }
}

export function pointerChannelOf(url: string): string | null {
  const id = queryOf(url, "pointer");

  return id !== null && POINTER_ID.test(id) ? id : null;
}

// The pointer sockets by channel (docs/remote.md, 「The pointer」): a desktop connection publishes
// the shapes it reads to the channel its page named, and the page's pointer socket listens there.
export function createPointerChannels() {
  const listeners = new Map<string, Set<SocketPeerLike>>();

  return {
    listen(id: string, peer: SocketPeerLike): void {
      const set = listeners.get(id) ?? new Set();

      set.add(peer);
      listeners.set(id, set);
    },
    leave(id: string, peer: SocketPeerLike): void {
      const set = listeners.get(id);

      set?.delete(peer);

      if (set?.size === 0) listeners.delete(id);
    },
    publish(id: string, message: string): void {
      for (const peer of listeners.get(id) ?? []) peer.send(message);
    },
    listeners
  };
}

export type PointerChannels = ReturnType<typeof createPointerChannels>;

// Every pointer shape in a PDU the server sent, as messages for the page. The pointer is read on the
// fast path only, so a slow-path PDU, which starts with the TPKT version, is passed over.
const TPKT_VERSION = 3;

function pointerMessages(pdu: Uint8Array): string[] {
  if (pdu[0] === TPKT_VERSION) return [];

  const out: string[] = [];

  for (const update of fastPathUpdates(pdu) ?? []) {
    if (update.fragmentation !== 0 || update.compressed) continue;

    const shape = readPointerUpdate(update.code, update.data);

    if (shape) out.push(pointerMessage(shape));
  }

  return out;
}

// What the socket's address asks of the connection: the quality to draw at.
export function clientInfoChange(url: string): ClientInfoChange {
  const quality = queryOf(url, "quality");

  return { performanceFlags: isRemoteDesktopQuality(quality) ? PERFORMANCE_FLAGS[quality] : null };
}

// A frame with its logon packet rewritten, or null where it holds none. A frame may carry more than
// one packet; each is read on its own.
function rewriteFrame(bytes: Uint8Array, change: ClientInfoChange): Uint8Array | null {
  const packets: Uint8Array[] = [];
  let found = false;

  for (let at = 0; at < bytes.length; ) {
    if (bytes[at] !== 3 || at + 4 > bytes.length) return null;

    const length = (bytes[at + 2]! << 8) | bytes[at + 3]!;

    if (length < 7 || at + length > bytes.length) return null;

    const packet = bytes.subarray(at, at + length);
    const rewritten: Uint8Array | null = found ? null : rewriteClientInfo(packet, change);

    found ||= rewritten !== null;
    packets.push(rewritten ?? packet);
    at += length;
  }

  if (!found) return null;

  const out = new Uint8Array(packets.reduce((sum, one) => sum + one.length, 0));
  let write = 0;

  for (const one of packets) {
    out.set(one, write);
    write += one.length;
  }

  return out;
}

// The client core data comes in the first frame after the handshake; a few more are searched in case
// the client splits its writes.
const CORE_SEARCH_FRAMES = 4;

// How long a redirection waits for the page to connect again with its token (ms).
const REDIRECT_WAIT_MS = 30_000;

// The message the page's pointer socket is told a redirection with: connect again at once.
export const REDIRECT_MESSAGE = JSON.stringify({ type: "redirect" });

export interface DesktopSocketDeps {
  dial: Dial;
  password?: () => string | null;
  // The account the relay authenticates as.
  account?: () => string;
  // Where the desktop is.
  target?: () => { host: string; port: number };
  pointers?: PointerChannels;
  now?: () => number;
  // The desktop's input method, which the on-screen keyboard's Hangul is typed through.
  inputMethod?: () => Promise<InputMethod>;
  typist?: TypistTiming;
  // Where a refused connection is written down.
  log?: (line: string) => void;
}

export function createDesktopSocket(deps: DesktopSocketDeps) {
  const password = deps.password ?? desktopPassword;
  const account = deps.account ?? (() => userInfo().username);
  const target = deps.target ?? desktopTarget;
  const pointers = deps.pointers ?? createPointerChannels();
  const now = deps.now ?? Date.now;
  const inputMethod = deps.inputMethod ?? readInputMethod;
  const log = deps.log ?? ((line: string) => console.error(line));

  const relays = new Map<string, Relay>();
  // The routing token the server last redirected a connection with, and the one-time account it
  // named, for the next connection to carry and log on with (docs/remote.md, 「Redirection」). There
  // is one desktop, so there is one.
  let redirect: { token: Uint8Array; account: NlaCredentials | null; until: number } | null = null;

  function refuse(peer: SocketPeerLike, failure: DialFailure, where: { host: string; port: number } | null): void {
    log(`remote desktop: refused a connection${where ? ` to ${where.host}:${where.port}` : ""}: ${failureReason(failure)}`);
    peer.send(encodeError(failure));
    peer.close(1000, "refused");
  }

  function open(peer: SocketPeerLike): void {
    const relay: Relay = {
      relaying: false,
      coreSearch: CORE_SEARCH_FRAMES,
      infoSearch: INFO_SEARCH_FRAMES,
      info: clientInfoChange(peer.request.url),
      serverFraming: createServerFraming(),
      pointer: pointerChannelOf(peer.request.url),
      hidden: null,
      redirected: false,
      clientFraming: createClientFraming(),
      typing: [],
      typist: createDesktopTypist({
        send(pdu) {
          relay.typing.push(pdu);
          flushTyping(relay);
        },
        inputMethod,
        timing: deps.typist
      })
    };

    relays.set(peer.id, relay);
  }

  // The request as it goes to the server, and the credentials the relay runs NLA with, if any. The
  // relay authenticates where it keeps the password and the browser asked for no NLA of its own;
  // a waiting redirection's token goes in place of the browser's cookie.
  function prepare(x224: Uint8Array): { request: Uint8Array; nla: NlaCredentials | null } {
    // A waiting token is the next connection's and no other's, whatever becomes of that one.
    const waiting = redirect && redirect.until > now() ? redirect : null;
    const request = readConnectionRequest(x224);
    const kept = password();
    let nla: NlaCredentials | null = null;

    redirect = null;

    if (!request) return { request: x224, nla };

    if (kept !== null && request.protocols !== null && !(request.protocols & PROTOCOL_HYBRID)) {
      request.protocols |= PROTOCOL_HYBRID;
      nla = waiting?.account ?? { username: account(), password: kept };
    }

    if (waiting) request.token = waiting.token;

    return { request: writeConnectionRequest(x224, request), nla };
  }

  async function message(peer: SocketPeerLike, incoming: SocketMessageLike): Promise<void> {
    const relay = relays.get(peer.id);

    if (!relay) return;

    let bytes = incoming.uint8Array();

    if (relay.relaying) {
      if (relay.coreSearch > 0) {
        relay.coreSearch = rewriteCoreData(bytes, relay.hidden) ? 0 : relay.coreSearch - 1;
      } else if (relay.infoSearch > 0) {
        const rewritten: Uint8Array | null = rewriteFrame(bytes, relay.info);

        relay.infoSearch = rewritten ? 0 : relay.infoSearch - 1;
        bytes = rewritten ?? bytes;
      }

      relay.upstream?.write(bytes);

      if (relay.clientFraming.push(bytes)) flushTyping(relay);

      return;
    }

    // Only the first frame is a request; anything arriving before the answer is not ours to read.
    if (relay.upstream) return;

    let x224: Uint8Array;

    try {
      // The destination the browser names is read and never used.
      x224 = decodeRequest(bytes).x224;
    } catch (error) {
      if (!(error instanceof CleanPathError)) throw error;

      relays.delete(peer.id);
      refuse(peer, { code: GENERAL_ERROR, httpStatus: HTTP_BAD_REQUEST }, null);

      return;
    }

    const where = await target();
    const { request, nla } = prepare(x224);

    relay.upstream = deps.dial(where, request, {
      ready(confirm, certificate) {
        if (!relays.has(peer.id)) return;

        const chosen = selectedProtocol(confirm);

        relay.hidden = nla && chosen === PROTOCOL_HYBRID ? chosen : null;

        peer.send(
          encodeResponse({
            x224: relay.hidden === null ? confirm : withSelectedProtocol(confirm, PROTOCOL_SSL),
            certChain: [certificate],
            serverAddr: `${where.host}:${where.port}`
          })
        );
        relay.relaying = true;
      },
      data(chunk) {
        if (!relays.has(peer.id) || relay.redirected) return;

        for (const pdu of relay.serverFraming.push(chunk)) {
          const redirection = pdu[0] === TPKT_VERSION ? readRedirection(pdu) : null;

          if (redirection) {
            follow(peer, relay, redirection);

            return;
          }

          peer.send(pdu);

          if (relay.pointer) for (const one of pointerMessages(pdu)) pointers.publish(relay.pointer, one);
        }
      },
      failed(failure) {
        relay.typist.stop();

        if (!relays.delete(peer.id)) return;

        refuse(peer, failure, where);
      },
      closed() {
        relay.typist.stop();

        if (!relays.delete(peer.id)) return;

        for (const pdu of relay.serverFraming.flush()) peer.send(pdu);

        peer.close(1000, "desktop connection ended");
      }
    }, nla);
  }

  // What the relay has to type goes in only while the client's stream stands between two of its own
  // PDUs; a stream whose framing was lost is typed into no more.
  function flushTyping(relay: Relay): void {
    if (relay.clientFraming.lost) relay.typing.length = 0;
    if (!relay.relaying || !relay.clientFraming.between || relay.typing.length === 0) return;

    for (const pdu of relay.typing.splice(0)) relay.upstream?.write(pdu);
  }

  // The account the server handed the next connection, where it named one: gnome-remote-desktop
  // gives each hop a one-time user and password, and the daemon it hands to knows no other.
  function redirectedAccount(redirection: Redirection): NlaCredentials | null {
    if (redirection.username === null || redirection.password === null) return null;

    return { username: redirection.username, password: redirection.password, ...(redirection.domain ? { domain: redirection.domain } : {}) };
  }

  // The server sent this connection elsewhere: its token is kept for the page's next connection,
  // the page is told to make it, and this one ends. The browser never sees the redirection, which
  // the client in use does not follow.
  function follow(peer: SocketPeerLike, relay: Relay, redirection: Redirection): void {
    relay.redirected = true;
    relay.typist.stop();

    if (redirection.loadBalanceInfo) {
      redirect = { token: routingToken(redirection.loadBalanceInfo), account: redirectedAccount(redirection), until: now() + REDIRECT_WAIT_MS };
    }

    if (relay.pointer) pointers.publish(relay.pointer, REDIRECT_MESSAGE);

    relays.delete(peer.id);
    relay.upstream?.end();
    peer.close(1000, "redirected");
  }

  function close(peer: SocketPeerLike): void {
    const relay = relays.get(peer.id);

    relays.delete(peer.id);
    relay?.typist.stop();
    relay?.upstream?.end();
  }

  // What the on-screen keyboard sent over the keys socket naming a channel, typed into the connection
  // on that channel (docs/remote.md, 「The on-screen keyboard」). With no connection there, nothing is typed.
  function type(channel: string, keys: KeysMessage): Promise<void> {
    for (const relay of relays.values()) {
      if (relay.pointer === channel && relay.relaying && !relay.redirected) return relay.typist.type(keys);
    }

    return Promise.resolve();
  }

  return { open, message, close, type, relays, pointers };
}

let shared: ReturnType<typeof createDesktopSocket> | undefined;

export function desktopSocket(): ReturnType<typeof createDesktopSocket> {
  shared ??= createDesktopSocket({ dial: dialRdp });

  return shared;
}

// The page's pointer socket: it names its channel and only listens. A socket naming no valid
// channel is closed at once.
export function createPointerSocket(pointers: () => PointerChannels) {
  const joined = new Map<string, string>();

  return {
    open(peer: SocketPeerLike): void {
      const id = pointerChannelOf(peer.request.url);

      if (id === null) {
        peer.close(1008, "no pointer channel");

        return;
      }

      joined.set(peer.id, id);
      pointers().listen(id, peer);
    },
    message(): void {},
    close(peer: SocketPeerLike): void {
      const id = joined.get(peer.id);

      joined.delete(peer.id);

      if (id !== undefined) pointers().leave(id, peer);
    }
  };
}

const pointerSocket = createPointerSocket(() => desktopSocket().pointers);

// The pointer socket as one of the console's websocket endpoints.
export const desktopPointerEndpoint: SocketEndpoint = {
  claims: (path) => path === "/desktop/pointer",
  open: (peer) => pointerSocket.open(peer),
  message: () => undefined,
  close: (peer) => pointerSocket.close(peer)
};

// The desktop socket as one of the console's websocket endpoints.
export const desktopEndpoint: SocketEndpoint = {
  claims: (path) => path === "/desktop/socket",
  open: (peer) => desktopSocket().open(peer),
  message: (peer, message) => desktopSocket().message(peer, message),
  close: (peer) => desktopSocket().close(peer)
};
