// The remote screen's desktop (docs/remote.md, 「The desktop」): one RDP connection for the whole
// app, drawn by IronRDP's web component. This module holds its state outside any component and
// imports what it uses rather than leaning on Nuxt's auto-imports.
import { readonly, ref, shallowRef } from "vue";

import { REMOTE_DESKTOP_QUALITIES } from "../../../shared/remote";

import { TOUCH_QUERY } from "bmo-ui/app/domain/prompt";
import { attachDesktopKeyboard, componentTyping, holdHoverFocus } from "./desktop-input";
import { canvasRasterise, createPointerShapes, pointerChannelId, readPointerMessage } from "./desktop-pointer";
import { remoteSocketUrl } from "./service";
import { keepTrying, retryable, wakePolicy } from "./desktop-wake";

import type { RemoteDesktopQuality } from "../../../shared/remote";
import type { Translate } from "bmo-ui/shared/wording";
import type { IronError, NewSessionInfo, UserInteraction } from "@devolutions/iron-remote-desktop";
import type { DesktopKeyboard, DesktopTouchMode, DesktopTyping } from "./desktop-input";
import type { WakeProgress } from "./desktop-wake";

// "away" is a connection given up because another window of the console took the desktop; "waking" is a
// desktop that did not answer being tried again (docs/remote.md, 「A desktop that does not answer」).
export type RemoteDesktopStatus = "idle" | "loading" | "connecting" | "waking" | "connected" | "ended" | "error" | "away";

// The one desktop is taken by whichever window connected last: the remote login hands the session to
// the newest connection, so the others let theirs go and say where it went.
const CHANNEL_NAME = "bmo-remote-desktop";
const WINDOW_ID = Math.random().toString(36).slice(2);

// The only desktop there is. The relay dials it whatever this says; the client needs a value.
const DESTINATION = "127.0.0.1:3389";
// The relay asks for no token; the client refuses to build a configuration without one.
const AUTH_TOKEN = "console";
// The backend's log level. Its initialisation refuses an empty one.
const LOG_LEVEL = "WARN";
// The component's scale value for fitting the picture to its place.
const SCALE_FIT = 1;

// The desktop size asked for on its own is the place's. On a phone, whose screen's shorter side is
// under this, the place's shape is scaled up until its shorter side is this long: a desktop the size
// of the phone would be unusable, and one of another shape would not fill the place.
const PHONE_SIDE_PX = 800;
const LARGEST_DESKTOP = { width: 3840, height: 2160 } as const;
const SMALLEST_DESKTOP = { width: 640, height: 480 } as const;
// How long the place must stand at one size before the desktop is connected again at it (ms).
export const RESIZE_SETTLE_MS = 600;
// What the browser sends as the password where the relay authenticates for it with the password the
// console keeps; the relay empties it from the logon packet.
const KEPT_PASSWORD_PLACEHOLDER = "bmo-console-kept-password";
// The component draws a line around itself while it takes the keys, and the browser draws its own
// focus ring on the canvas the component focuses; the desktop's place has neither.
const COMPONENT_STYLE = ".capturing-inputs, :focus, :focus-visible { outline: none !important; }";

export type DesktopSizeChoice = "auto" | "1280x720" | "1600x900" | "1920x1080" | "2560x1440";

export const DESKTOP_SIZE_CHOICES: readonly { value: DesktopSizeChoice; label: string }[] = [
  { value: "auto", label: "remote.label.size_auto" },
  { value: "1280x720", label: "remote.label.size_1280x720" },
  { value: "1600x900", label: "remote.label.size_1600x900" },
  { value: "1920x1080", label: "remote.label.size_1920x1080" },
  { value: "2560x1440", label: "remote.label.size_2560x1440" }
];

const QUALITY_LABELS: Record<RemoteDesktopQuality, string> = {
  fast: "remote.label.quality_fast",
  balanced: "remote.label.quality_balanced",
  sharp: "remote.label.quality_sharp"
};

// The share of the size chosen each quality asks the desktop for.
const QUALITY_SCALE: Record<RemoteDesktopQuality, number> = { fast: 0.75, balanced: 1, sharp: 1 };

export const DESKTOP_QUALITY_CHOICES = REMOTE_DESKTOP_QUALITIES.map((value) => ({ value, label: QUALITY_LABELS[value] }));

export const DESKTOP_TOUCH_CHOICES: readonly { value: DesktopTouchMode; label: string }[] = [
  { value: "touch", label: "remote.label.touch_mode_touch" },
  { value: "pointer", label: "remote.label.touch_mode_pointer" }
];

// How the owner has the desktop drawn and worked. Kept in the browser, as the terminal's choices are.
export interface DesktopSettings {
  size: DesktopSizeChoice;
  quality: RemoteDesktopQuality;
  touchMode: DesktopTouchMode;
}

export const DEFAULT_DESKTOP_SETTINGS: DesktopSettings = { size: "auto", quality: "balanced", touchMode: "touch" };

const SETTINGS_KEY = "bmo:remote-desktop-settings";

export function tidyDesktopSettings(value: unknown): DesktopSettings {
  const { size, quality, touchMode } = (value ?? {}) as Record<string, unknown>;

  return {
    size: DESKTOP_SIZE_CHOICES.some((one) => one.value === size) ? (size as DesktopSizeChoice) : DEFAULT_DESKTOP_SETTINGS.size,
    quality: (REMOTE_DESKTOP_QUALITIES as readonly unknown[]).includes(quality) ? (quality as RemoteDesktopQuality) : DEFAULT_DESKTOP_SETTINGS.quality,
    touchMode: touchMode === "pointer" || touchMode === "touch" ? touchMode : DEFAULT_DESKTOP_SETTINGS.touchMode
  };
}

function readSettings(): DesktopSettings {
  try {
    const stored = localStorage.getItem(SETTINGS_KEY);

    return tidyDesktopSettings(stored ? JSON.parse(stored) : null);
  } catch {
    return { ...DEFAULT_DESKTOP_SETTINGS };
  }
}

// IronRDP's error kinds, as its `IronErrorKind` numbers them, each with the key of its words.
const ERROR_KINDS: Record<number, string> = {
  1: "remote.error.wrong_password",
  2: "remote.error.logon_failed",
  3: "remote.error.access_denied",
  4: "remote.error.relay_refused",
  5: "remote.error.relay_unreachable",
  6: "remote.error.negotiation_failed"
};

const status = ref<RemoteDesktopStatus>("idle");
const lastError = ref<string | null>(null);
// The try a desktop that does not answer is on, and the seconds passed of its window, while it is tried again.
const waking = ref<WakeProgress | null>(null);
let wakeTimer: ReturnType<typeof setTimeout> | undefined;
let wakeTicker: ReturnType<typeof setInterval> | undefined;
// Ends the wait in hand, saying whether the next try goes ahead.
let wakeRelease: ((go: boolean) => void) | null = null;
const desktopSize = shallowRef<{ width: number; height: number } | null>(null);
// Typed for this visit only; never written anywhere.
const password = ref("");
const keyboardOpen = ref(false);
const settings = ref<DesktopSettings>({ ...DEFAULT_DESKTOP_SETTINGS });
let settingsRead = false;
let lastOptions: ConnectOptions | null = null;
let resizeTimer: ReturnType<typeof setTimeout> | undefined;
let placeSize: { width: number; height: number } | null = null;
// The size the connection in hand asked for.
let askedSize: { width: number; height: number } | null = null;

export interface ConnectOptions {
  // The console's words, for what the connection says when it fails.
  t: Translate;
  username: string;
  // The console keeps the password, and the relay authenticates with it.
  keptPassword: boolean;
  // How long, from the first try, a desktop that does not answer is tried again (s).
  wakeSeconds: number;
}

let element: HTMLElement | null = null;
let parking: HTMLElement | null = null;
let ui: UserInteraction | null = null;
let starting: Promise<UserInteraction> | null = null;
// The RDP backend's own module, for the extensions a connection is built with.
let backend: typeof import("@devolutions/iron-remote-desktop-rdp") | null = null;
// Counts connections begun, so one begun before another cannot settle the newer one's state.
let attempt = 0;
let hostOf: HTMLElement | null = null;
let keyboard: DesktopKeyboard | null = null;

let channel: BroadcastChannel | null = null;

// The pointer socket of the connection in hand, and the shapes it has named.
let pointerSocket: WebSocket | null = null;
// The keys socket of the connection in hand, and whether the relay has taken it on.
let keysSocket: WebSocket | null = null;
let keysReady = false;
// How long a connection waits for its pointer socket before going on without it (ms).
const POINTER_OPEN_MS = 1500;

function listen(): void {
  if (channel !== null || typeof BroadcastChannel === "undefined") return;

  channel = new BroadcastChannel(CHANNEL_NAME);
  channel.onmessage = (event: MessageEvent) => {
    const message = event.data as { type?: string; from?: string } | null;

    if (message?.type !== "taken" || message.from === WINDOW_ID) return;
    if (status.value !== "connected" && status.value !== "connecting" && status.value !== "waking") return;

    disconnect();
    status.value = "away";
  };
}

export function useRemoteDesktop() {
  if (!settingsRead && typeof window !== "undefined") {
    settingsRead = true;
    settings.value = readSettings();
    listen();
  }

  return {
    settings: readonly(settings),
    setSettings,
    placeResized,
    status: readonly(status),
    lastError: readonly(lastError),
    waking: readonly(waking),
    desktopSize: readonly(desktopSize),
    password,
    keyboardOpen: readonly(keyboardOpen),
    showKeyboard,
    connect,
    disconnect,
    mount,
    unmount,
    reveal,
    canvas,
    interaction: () => ui
  };
}

// The component is destroyed a moment after it leaves the document, and a connection with it. So it
// never leaves: between views it waits in a hidden place that is always in the document, and moving
// it between two places inside the document keeps it whole.
function park(): HTMLElement {
  if (!parking) {
    parking = document.createElement("div");
    parking.hidden = true;
    parking.dataset.remoteDesktopParking = "";
    document.body.append(parking);
  }

  return parking;
}

async function start(t: Translate): Promise<UserInteraction> {
  const [, rdp] = await Promise.all([
    import("@devolutions/iron-remote-desktop"),
    import("@devolutions/iron-remote-desktop-rdp")
  ]);

  backend = rdp;

  const created = document.createElement("iron-remote-desktop") as HTMLElement & { module?: unknown };

  created.setAttribute("scale", "fit");
  created.setAttribute("flexcenter", "true");
  created.module = rdp.Backend;

  // The component announces itself as soon as it is upgraded, which can be before anything awaited
  // after this returns; the listener is in place first.
  const readied = new Promise<UserInteraction>((resolve) => {
    created.addEventListener(
      "ready",
      (event) => {
        const detail = (event as CustomEvent).detail as { irgUserInteraction?: UserInteraction } | UserInteraction;

        resolve("irgUserInteraction" in detail && detail.irgUserInteraction ? detail.irgUserInteraction : (detail as UserInteraction));
      },
      { once: true }
    );
  });

  element = created;
  (hostOf ?? park()).append(created);

  // The rule goes in as an adopted sheet rather than an element: the component takes keys only while
  // its own markup is the first element of its shadow root, and an element put there before it
  // mounts would stand first.
  if (created.shadowRoot) {
    const sheet = new CSSStyleSheet();

    sheet.replaceSync(COMPONENT_STYLE);
    created.shadowRoot.adoptedStyleSheets = [...created.shadowRoot.adoptedStyleSheets, sheet];
    // The component lives as long as the page, so the hold stands as long.
    holdHoverFocus(created.shadowRoot);
  }

  const [interaction] = await Promise.all([readied, rdp.init(LOG_LEVEL)]);

  ui = interaction;

  if (created.shadowRoot) {
    keyboard = attachDesktopKeyboard(created.shadowRoot, {
      label: t("remote.aria.desktop_input"),
      typing,
      focused(on) {
        interaction.setKeyboardUnicodeMode(on);
        keyboardOpen.value = on;
      }
    });
  }

  return interaction;
}

export function proxyAddress(quality: RemoteDesktopQuality, pointer: string): string {
  return remoteSocketUrl("/desktop/socket", { quality, pointer });
}

// Opens the pointer socket for one connection and shows each shape it brings on the desktop's
// canvas. Resolves once it is open, or failed, or has stood too long: the desktop works without it,
// with the browser's arrow.
function openPointer(id: string): Promise<WebSocket> {
  closePointer();

  const socket = new WebSocket(remoteSocketUrl("/desktop/pointer", { pointer: id }));
  const shapes = createPointerShapes(canvasRasterise);
  const text = new TextDecoder();

  pointerSocket = socket;
  // The development server's relay may hand a text frame over as binary.
  socket.binaryType = "arraybuffer";
  socket.onmessage = (event: MessageEvent) => {
    if (pointerSocket !== socket) return;

    const data: unknown = event.data instanceof ArrayBuffer ? text.decode(event.data) : event.data;

    if (isRedirect(data)) {
      follow();

      return;
    }

    const message = readPointerMessage(data);

    if (message) ui?.setCursorStyleOverride(shapes(message));
  };

  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(socket), POINTER_OPEN_MS);
    const done = () => {
      clearTimeout(timer);
      resolve(socket);
    };

    socket.onopen = done;
    socket.onerror = done;
  });
}

// The relay's word that the desktop sent this connection on: to the login screen, or from it to the
// session (docs/remote.md, 「Redirection」). The relay keeps the token the next connection carries.
export function isRedirect(data: unknown): boolean {
  if (typeof data !== "string") return false;

  try {
    return (JSON.parse(data) as { type?: unknown }).type === "redirect";
  } catch {
    return false;
  }
}

// Connects again at once, where the relay said the desktop moved the connection on.
function follow(): void {
  if (lastOptions === null) return;

  const options = lastOptions;

  disconnect();
  void connect(options);
}

// Opens the keys socket for one connection, naming the connection's channel: what the on-screen
// keyboard types goes there once the relay says it is ready, and through the component until then.
function openKeys(channel: string): WebSocket {
  closeKeys();

  const socket = new WebSocket(remoteSocketUrl("/desktop/keys", { pointer: channel }));
  const text = new TextDecoder();

  keysSocket = socket;
  socket.binaryType = "arraybuffer";
  socket.onmessage = (event: MessageEvent) => {
    if (keysSocket !== socket) return;

    try {
      const message = JSON.parse(event.data instanceof ArrayBuffer ? text.decode(event.data) : String(event.data)) as {
        type?: string;
        editable?: unknown;
      };

      if (message.type === "ready") keysReady = true;
      else if (message.type === "focus" && typeof message.editable === "boolean") followFocus(message.editable);
    } catch {
      // A message that is not JSON says nothing.
    }
  };
  socket.onclose = () => {
    if (keysSocket === socket) keysReady = false;
  };

  return socket;
}

// Closes the keys socket, the one given or whichever is open; one that is no longer the open one is
// left to whoever replaced it.
function closeKeys(which: WebSocket | null = keysSocket): void {
  if (which === null || which !== keysSocket) return;

  which.close();
  keysSocket = null;
  keysReady = false;
}

// Where the on-screen keyboard's typing goes (docs/remote.md, 「The on-screen keyboard」).
function typing(): DesktopTyping {
  const socket = keysSocket;

  if (!socket || !keysReady || socket.readyState !== WebSocket.OPEN) return componentTyping();

  return {
    text: (text) => socket.send(JSON.stringify({ type: "text", text })),
    key: (key, count = 1) => socket.send(JSON.stringify({ type: "key", key, count }))
  };
}

// Closes the pointer socket, the one given or whichever is open, and puts the arrow back. A socket
// that is no longer the open one is left to whoever replaced it.
function closePointer(which: WebSocket | null = pointerSocket): void {
  if (which === null || which !== pointerSocket) return;

  which.close();
  pointerSocket = null;
  ui?.setCursorStyleOverride(null);
}

// The desktop size to ask for: the size chosen, or on its own the place's size, scaled up to a
// desktop's on a phone. The quality then scales it: the server's work and its answer to a key grow
// with the pixels, so the fast quality asks for fewer and the picture is stretched to its place. Last it is
// scaled as a whole into what a desktop can be, so its shape still fills the place, and evened,
// since some servers refuse odd sizes.
export function requestedDesktopSize(
  choice: DesktopSizeChoice,
  place: { width: number; height: number },
  screen: { width: number; height: number },
  quality: RemoteDesktopQuality = "balanced"
): { width: number; height: number } {
  let size = { width: Math.max(1, place.width), height: Math.max(1, place.height) };

  if (choice !== "auto") {
    const [width, height] = choice.split("x").map(Number) as [number, number];

    size = { width, height };
  } else if (Math.min(screen.width, screen.height) < PHONE_SIDE_PX) {
    const up = PHONE_SIDE_PX / Math.min(size.width, size.height);

    size = { width: size.width * up, height: size.height * up };
  }

  const scale = QUALITY_SCALE[quality];
  const width = size.width * scale;
  const height = size.height * scale;
  const grow = Math.max(1, SMALLEST_DESKTOP.width / width, SMALLEST_DESKTOP.height / height);
  const fit = grow * Math.min(1, LARGEST_DESKTOP.width / (width * grow), LARGEST_DESKTOP.height / (height * grow));
  const even = (value: number, low: number, cap: number) => Math.max(low, Math.min(cap, Math.floor(value / 2) * 2));

  return {
    width: even(width * fit, SMALLEST_DESKTOP.width, LARGEST_DESKTOP.width),
    height: even(height * fit, SMALLEST_DESKTOP.height, LARGEST_DESKTOP.height)
  };
}

function currentSize(): { width: number; height: number } {
  const place = placeSize ?? { width: window.innerWidth, height: window.innerHeight };

  return requestedDesktopSize(settings.value.size, place, { width: window.screen.width, height: window.screen.height }, settings.value.quality);
}

// A new choice, kept, and put into effect: the touch mode at once, the size and the quality by
// connecting again.
function setSettings(next: Partial<DesktopSettings>): void {
  const before = settings.value;

  settings.value = tidyDesktopSettings({ ...before, ...next });

  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings.value));
  } catch {
    // A private window or blocked site data: the choice holds for this visit only.
  }

  if (settings.value.size !== before.size || settings.value.quality !== before.quality) reconnect();
}

// Connects again with the settings as they now are. The desktop is never resized under a
// connection: the client keeps drawing into a picture of the size it connected at and panics on the
// first frame beyond it (docs/remote.md, 「Connection settings」).
function reconnect(): void {
  if (lastOptions === null || (status.value !== "connected" && status.value !== "connecting" && status.value !== "waking")) return;

  const options = lastOptions;

  disconnect();
  void connect(options);
}

// The place the desktop stands in has a new size. The picture is fitted to it at once; once it has
// stood still, a desktop sized to its place connects again at the new size. A browser that cannot lay
// the phone's keyboard over the page shrinks the page for it, so while it is up the desktop keeps its
// size.
function placeResized(width: number, height: number): void {
  placeSize = { width, height };
  reveal();
  clearTimeout(resizeTimer);

  if (keyboardOpen.value) return;

  resizeTimer = setTimeout(() => {
    if (keyboardOpen.value || status.value !== "connected" || settings.value.size !== "auto") return;

    const wanted = currentSize();

    if (askedSize && askedSize.width === wanted.width && askedSize.height === wanted.height) return;

    reconnect();
  }, RESIZE_SETTLE_MS);
}

export function describeError(t: Translate, error: unknown): string {
  const failure = error as Partial<IronError> | undefined;
  const kind = typeof failure?.kind === "function" ? failure.kind() : undefined;

  if (kind !== undefined && ERROR_KINDS[kind]) return t(ERROR_KINDS[kind]);

  return t("remote.error.connect_failed");
}

// A dial overtaken by a newer connection or a disconnect; its end settles nothing.
const OVERTAKEN = new Error("the connection was overtaken");

// One connection begun: the client loaded, then dialled until the desktop answers, refuses or the window is
// spent (docs/remote.md, 「A desktop that does not answer」).
async function connect(options: ConnectOptions): Promise<void> {
  if (status.value === "connecting" || status.value === "connected" || status.value === "loading" || status.value === "waking") return;

  lastOptions = options;

  const mine = ++attempt;

  lastError.value = null;
  endWaking();
  status.value = "loading";

  let interaction: UserInteraction;

  try {
    starting ??= start(options.t);
    interaction = await starting;
  } catch {
    starting = null;

    if (mine !== attempt) return;

    status.value = "error";
    lastError.value = options.t("remote.error.load_failed");

    return;
  }

  if (mine !== attempt) return;

  status.value = "connecting";

  const policy = wakePolicy(options.wakeSeconds);
  const outcome = await keepTrying(() => dial(interaction, options, mine), policy, {
    now: Date.now,
    wait: (ms, progress) => pause(ms, progress, mine)
  });

  // A connection let go of while its try was out settles nothing.
  if (mine !== attempt || outcome.kind === "dropped" || (status.value !== "connecting" && status.value !== "waking")) return;

  endWaking();

  if (outcome.kind === "failed") {
    const reason = describeError(options.t, outcome.error);

    status.value = "error";
    // A desktop that never answered within the window says so; one that refused says only why.
    lastError.value =
      outcome.tries > 0 && retryable(outcome.error) ? options.t("remote.error.no_answer", { window: policy.windowMs / 1000, reason }) : reason;

    return;
  }

  const { session, pointerOf, keysOf } = outcome.value;

  status.value = "connected";
  channel?.postMessage({ type: "taken", from: WINDOW_ID });
  desktopSize.value = session.initialDesktopSize;
  interaction.setVisibility(true);
  reveal();

  session.run().then(
    () => {
      closePointer(pointerOf);
      closeKeys(keysOf);

      if (mine === attempt && status.value === "connected") status.value = "ended";
    },
    (error: unknown) => {
      closePointer(pointerOf);
      closeKeys(keysOf);

      if (mine !== attempt || status.value !== "connected") return;

      status.value = "error";
      lastError.value = describeError(options.t, error);
    }
  );
}

// One try: the connection's pointer and keys sockets, then the RDP connection through the relay.
async function dial(
  interaction: UserInteraction,
  options: ConnectOptions,
  mine: number
): Promise<{ session: NewSessionInfo; pointerOf: WebSocket; keysOf: WebSocket }> {
  const pointer = pointerChannelId();
  const pointerOf = await openPointer(pointer);

  if (mine !== attempt) {
    closePointer(pointerOf);

    throw OVERTAKEN;
  }

  const keysOf = openKeys(pointer);
  const size = currentSize();

  askedSize = size;

  const config = interaction
    .configBuilder()
    .withDestination(DESTINATION)
    .withProxyAddress(proxyAddress(settings.value.quality, pointer))
    .withAuthToken(AUTH_TOKEN)
    .withUsername(options.username)
    .withPassword(options.keptPassword ? KEPT_PASSWORD_PLACEHOLDER : password.value)
    .withDesktopSize(size)
    // Where the console keeps the password the relay runs NLA with it; a password typed here is
    // the browser's to authenticate with.
    .withExtension(backend!.enableCredssp(!options.keptPassword))
    .build();

  try {
    return { session: await interaction.connect(config), pointerOf, keysOf };
  } catch (error) {
    closePointer(pointerOf);
    closeKeys(keysOf);

    throw error;
  }
}

// Waits before the next try, saying meanwhile that the desktop is being woken; false where the connection
// was overtaken or let go during the wait.
function pause(ms: number, progress: WakeProgress, mine: number): Promise<boolean> {
  if (mine !== attempt || (status.value !== "connecting" && status.value !== "waking")) return Promise.resolve(false);

  status.value = "waking";
  waking.value = progress;
  clearInterval(wakeTicker);
  wakeTicker = setInterval(() => {
    const now = waking.value;

    if (now) waking.value = { ...now, seconds: Math.min(now.seconds + 1, now.window) };
  }, 1000);

  return new Promise((resolve) => {
    wakeRelease = (go) => {
      wakeRelease = null;
      clearTimeout(wakeTimer);
      resolve(go);
    };
    wakeTimer = setTimeout(() => wakeRelease?.(mine === attempt && status.value === "waking"), ms);
  });
}

// Ends the waking: the wait in hand lets its connection go, and the line stops counting.
function endWaking(): void {
  wakeRelease?.(false);
  clearInterval(wakeTicker);
  waking.value = null;
}

function disconnect(): void {
  if (status.value !== "connected" && status.value !== "connecting" && status.value !== "waking") return;

  status.value = "idle";
  endWaking();
  closePointer();
  closeKeys();
  ui?.shutdown();
}

// Puts the desktop into a view's place. Moving it within the document keeps the component alive.
function mount(host: HTMLElement): void {
  hostOf = host;

  if (element) host.append(element);

  reveal();
}

function unmount(host: HTMLElement): void {
  if (hostOf !== host) return;

  hostOf = null;

  if (element) park().append(element);
}

// Fits the picture to the place it now stands in; the component measures only on a window resize.
function reveal(): void {
  if (!ui || status.value !== "connected") return;

  ui.setScale(SCALE_FIT as Parameters<UserInteraction["setScale"]>[0]);
}

// Raises the phone's keyboard for the desktop.
function showKeyboard(): void {
  if (status.value !== "connected") return;

  keyboard?.show();
}

// A text field on the desktop took focus or every one let it go (docs/remote.md, 「A text field taking
// focus」). Only a touch screen follows it: elsewhere the component takes the keys itself.
function followFocus(editable: boolean): void {
  if (!window.matchMedia(TOUCH_QUERY).matches) return;

  if (editable) showKeyboard();
  else keyboard?.hide();
}

// The component's drawing surface, where pointer events are read.
function canvas(): HTMLCanvasElement | null {
  return element?.shadowRoot?.querySelector("canvas") ?? null;
}

// The component's shadow root, where an element must stand for its key handling to listen.
export function desktopShadowRoot(): ShadowRoot | null {
  return element?.shadowRoot ?? null;
}
