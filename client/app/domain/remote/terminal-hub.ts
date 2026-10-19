// The remote screen's terminals (docs/remote.md), carried over from trainer's terminal hub. This module
// holds its state outside any component and is opened as it is by the tests, so it imports what it
// uses rather than leaning on Nuxt's auto-imports.
import { readonly, ref } from "vue";

import { type ITheme, Terminal } from "@xterm/xterm";

import { TOUCH_QUERY } from "bmo-ui/app/domain/prompt";
import { refusalText } from "./refusals";
import { attachTerminalClipboard } from "./terminal-clipboard";
import { attachTerminalIme } from "./terminal-ime";
import { attachTerminalTouchScroll } from "./terminal-touch-scroll";

import type { Ref } from "vue";
import type { TerminalIme } from "./terminal-ime";
import type { Translate } from "bmo-ui/shared/wording";

export type RemoteTerminalStatus = "idle" | "opening" | "open" | "closed" | "error";

// A key that sends nothing itself and changes the bytes of the key after it.
export type TerminalModifier = "ctrl" | "alt" | "shift" | "meta";

// What a view holds of one terminal. The view reads the state and never owns the terminal's life.
export interface RemoteTerminalSession {
  status: Readonly<Ref<RemoteTerminalStatus>>;
  lastError: Readonly<Ref<string | null>>;
  armedModifiers: Readonly<Ref<readonly TerminalModifier[]>>;
  // Puts the kept terminal element into the view's host and brings the terminal up.
  mount: (host: HTMLElement) => void;
  // Takes the element back out. Neither the terminal nor its connection ends.
  unmount: () => void;
  // Fits and repaints the terminal; called whenever it becomes visible.
  reveal: () => void;
  // Input as if typed, through the same path as a real key.
  input: (data: string) => void;
  // Ends the line the keyboard was writing, for keys that reach the shell another way.
  resetInput: () => void;
  toggleModifier: (modifier: TerminalModifier) => void;
  focus: () => void;
  // Takes focus away; on a phone this is the only way to lower the soft keyboard.
  blur: () => void;
  // Reconnects now if the connection is down.
  resume: () => void;
  // Tries again after an error.
  reconnect: () => void;
}

export interface TerminalEntry {
  id: string;
  baseURL: string;
  // The console's words, for what the terminal says of its own session.
  t: Translate;
  // The element the terminal is drawn in, kept apart from the document between views.
  element: HTMLElement;
  term: Terminal;
  // The view's element the terminal element currently stands in.
  host: HTMLElement | null;
  observer: ResizeObserver | null;
  // Set once the terminal has been opened on its element, which waits for the element to have a size.
  opened: { ime: TerminalIme; detach: (() => void)[] } | null;
  socket: WebSocket | null;
  retry: ReturnType<typeof setTimeout> | undefined;
  attempts: number;
  released: boolean;
  status: Ref<RemoteTerminalStatus>;
  lastError: Ref<string | null>;
  armedModifiers: Ref<TerminalModifier[]>;
}

// What the hub is built with. The console uses the browser's own; the tests hand over stand-ins.
export interface TerminalHubSeams {
  createTerminal: (options: ConstructorParameters<typeof Terminal>[0]) => Terminal;
  openSocket: (url: string) => WebSocket;
}

let seams: TerminalHubSeams = {
  createTerminal: (options) => new Terminal(options),
  openSocket: (url) => new WebSocket(url)
};

export function setTerminalHubSeams(next: Partial<TerminalHubSeams>): void {
  seams = { ...seams, ...next };
}

const ESC = "\x1b";

// The first byte of a frame to the server: typed input, or a JSON control message.
export const FRAME_INPUT = 0;
export const FRAME_CONTROL = 1;

// Close codes the server uses for a session that is not there, and for a normal end.
const CLOSE_NOT_FOUND = 4404;
const CLOSE_NORMAL = 1000;

// Waits between reconnection attempts (ms); the last one repeats.
const RETRY_DELAYS_MS = [500, 1000, 2000, 4000, 8000, 15000];

// trainer's Argonaut theme, on a black background.
const ARGONAUT_THEME: ITheme = {
  foreground: "#FFFAF4",
  background: "#000000",
  cursor: "#AAAAAA",
  cursorAccent: "#000000",
  selectionBackground: "#002A3B",
  black: "#232323",
  red: "#FF000F",
  green: "#8CE10B",
  yellow: "#FFB900",
  blue: "#008DF8",
  magenta: "#6D43A6",
  cyan: "#00D8EB",
  white: "#FFFFFF",
  brightBlack: "#444444",
  brightRed: "#FF2740",
  brightGreen: "#ABE15B",
  brightYellow: "#FFD242",
  brightBlue: "#0092FF",
  brightMagenta: "#9A5FEB",
  brightCyan: "#67FFF0",
  brightWhite: "#FFFFFF"
};

// The faces the console carries for the terminal, and what is drawn until they arrive.
const TERMINAL_WEBFONTS = ["CaskaydiaCove Nerd Font Mono", "Noto Sans Symbols 2 Subset"] as const;
const TERMINAL_FALLBACK_FONT = "'CaskaydiaCove NFM', 'Cascadia Code', 'D2Coding', consolas, monospace";
const TERMINAL_FONT = `${TERMINAL_WEBFONTS.map((name) => `'${name}'`).join(", ")}, ${TERMINAL_FALLBACK_FONT}`;

export const TERMINAL_FONT_SIZES = [10, 11, 12, 13, 14, 16, 18, 22] as const;
export type TerminalFontSize = (typeof TERMINAL_FONT_SIZES)[number];
export const DEFAULT_TERMINAL_FONT_SIZE: TerminalFontSize = 13;

// Padding between the text and the edge (px). Zero is there for phones, where a few pixels are a column.
export const TERMINAL_PADDINGS = [0, 2, 4, 8, 12] as const;
export type TerminalPadding = (typeof TERMINAL_PADDINGS)[number];
export const DEFAULT_TERMINAL_PADDING: TerminalPadding = 8;

const FONT_SIZE_KEY = "bmo:remote-terminal-font-size";
const PADDING_KEY = "bmo:remote-terminal-padding";
const HAPTICS_KEY = "bmo:remote-terminal-haptics";
const EXTRA_KEYS_KEY = "bmo:remote-terminal-extra-keys";

// How long a key press and the start of a repeat buzz (ms).
const HAPTIC_PRESS_MS = 8;
const HAPTIC_HOLD_MS = 18;

// The shortest gap between two size claims (ms).
const CLAIM_INTERVAL_MS = 300;

const MINIMUM_COLS = 2;
const MINIMUM_ROWS = 1;

const entries = new Map<string, TerminalEntry>();

// Which terminal a view is showing. It is kept here rather than in the view, so that anything
// standing over the remote screen can hand the keyboard back without knowing the session behind it.
let shownId: string | null = null;

const isClient = () => typeof window !== "undefined" && typeof document !== "undefined";

function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStored(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // A private window or blocked site data: the choice holds for this visit only.
  }
}

// Whether the carried faces have arrived. xterm measures a cell once, when it opens, and again only
// when an option really changes; naming a face that has not arrived yet would leave it holding the
// fallback's width, with columns missing at the right. So the list names only the fallback until the
// faces are in, and correcting it then makes xterm measure again.
let webfontArrived = false;
let settling: Promise<void> | null = null;

function terminalFont(): string {
  return webfontArrived ? TERMINAL_FONT : TERMINAL_FALLBACK_FONT;
}

function whenFontsSettled(): Promise<void> {
  settling ??= settleFonts();

  return settling;
}

async function settleFonts(): Promise<void> {
  const fonts = isClient() ? document.fonts : undefined;

  if (fonts) {
    const probe = `${DEFAULT_TERMINAL_FONT_SIZE}px`;

    if (!TERMINAL_WEBFONTS.every((name) => fonts.check(`${probe} '${name}'`))) {
      await Promise.all(TERMINAL_WEBFONTS.map((name) => fonts.load(`${probe} '${name}'`))).catch(() => undefined);
    }
  }

  if (webfontArrived) return;

  webfontArrived = true;

  for (const entry of entries.values()) {
    entry.term.options.fontFamily = TERMINAL_FONT;
    revealOnNextFrame(entry);
  }
}

const fontSize = ref<TerminalFontSize>(DEFAULT_TERMINAL_FONT_SIZE);
const padding = ref<TerminalPadding>(DEFAULT_TERMINAL_PADDING);
const haptics = ref(true);
let choicesRestored = false;

// The owner's choices, read once in the browser before the first terminal stands.
function restoreChoices(): void {
  if (choicesRestored || !isClient()) return;

  choicesRestored = true;

  const size = Number(readStored(FONT_SIZE_KEY));
  const pad = readStored(PADDING_KEY);
  const buzz = readStored(HAPTICS_KEY);

  if (TERMINAL_FONT_SIZES.includes(size as TerminalFontSize)) fontSize.value = size as TerminalFontSize;
  if (pad !== null && TERMINAL_PADDINGS.includes(Number(pad) as TerminalPadding)) {
    padding.value = Number(pad) as TerminalPadding;
  }
  if (buzz !== null) haptics.value = buzz === "true";
}

// The terminal's font size. It moves only the terminal, not the page, so a larger font shows fewer
// columns rather than a larger frame.
export function useTerminalFontSize() {
  restoreChoices();

  function select(size: TerminalFontSize): void {
    fontSize.value = size;

    for (const entry of entries.values()) {
      entry.term.options.fontSize = size;
      revealOnNextFrame(entry);
    }

    writeStored(FONT_SIZE_KEY, String(size));
  }

  return { current: readonly(fontSize), select };
}

// Whether the owner turned the extra-keys row on or off; no choice leaves it to the screen's width.
// The row is part of what the server draws, so the choice is read once the page is mounted.
const extraKeys = ref<boolean | null>(null);

export function useTerminalExtraKeys() {
  function restore(): void {
    if (!isClient()) return;

    const stored = readStored(EXTRA_KEYS_KEY);

    if (stored !== null) extraKeys.value = stored === "true";
  }

  function choose(on: boolean): void {
    extraKeys.value = on;
    writeStored(EXTRA_KEYS_KEY, String(on));
  }

  return { choice: readonly(extraKeys), restore, choose };
}

export function useTerminalPadding() {
  restoreChoices();

  function select(size: TerminalPadding): void {
    padding.value = size;

    for (const entry of entries.values()) {
      applyPadding(entry);
      revealOnNextFrame(entry);
    }

    writeStored(PADDING_KEY, String(size));
  }

  return { current: readonly(padding), select };
}

function applyPadding(entry: TerminalEntry): void {
  entry.element.style.setProperty("--terminal-padding", `${padding.value}px`);
}

export type TerminalHaptic = "press" | "hold";

// An installed copy on a phone announces a key repeat itself; a second buzz would feel like two presses.
function isInstalledApp(): boolean {
  return isClient() && window.matchMedia?.("(display-mode: standalone)").matches === true;
}

// A buzz under the finger when an on-screen key is pressed. A device without a vibrator does nothing.
export function useTerminalHaptics() {
  restoreChoices();

  function set(on: boolean): void {
    haptics.value = on;
    writeStored(HAPTICS_KEY, String(on));
  }

  function tap(kind: TerminalHaptic): void {
    if (!haptics.value || typeof navigator === "undefined") return;
    if (kind === "hold" && isInstalledApp()) return;

    navigator.vibrate?.(kind === "hold" ? HAPTIC_HOLD_MS : HAPTIC_PRESS_MS);
  }

  return { enabled: readonly(haptics), set, tap };
}

// Whether the keyboard follows the shown terminal on this screen (docs/remote.md, 「Rules the
// interface keeps」). A screen a finger drives is the exception: focus there raises the soft
// keyboard over a terminal somebody may only be looking at, and a finger asks for the keyboard by
// tapping the terminal.
function keyboardFollowsView(): boolean {
  return isClient() && window.matchMedia?.(TOUCH_QUERY).matches !== true;
}

// Says which terminal a view is showing, and takes it back when that view is hidden or goes. A view
// hidden after another was shown says nothing: the one now shown has already claimed the place.
export function showingTerminal(id: string, showing: boolean): void {
  if (showing) shownId = id;
  else if (shownId === id) shownId = null;
}

// Gives the keyboard to the shown terminal, or to the one named, and says whether it took it. It is
// claimed wherever a terminal has just become the view on screen — mounted, its tab shown, the
// whole-window view entered, a menu over it gone — so that a key pressed without clicking into the
// terminal first still reaches the shell. What it answers is for a caller that must know whether to
// leave focus where a library would otherwise put it back.
export function claimTerminalKeyboard(id: string | null = shownId): boolean {
  const entry = id === null ? undefined : entries.get(id);

  if (!entry?.opened || entry.released || !entry.host || !keyboardFollowsView()) return false;

  entry.term.focus();

  return true;
}

// The terminal of one session, made the first time a view asks for it and kept until released.
export function useRemoteTerminal(id: string, options: { baseURL: string; t: Translate }): RemoteTerminalSession {
  restoreChoices();
  watchPage();

  let entry = entries.get(id);

  if (!entry) {
    entry = createEntry(id, options.baseURL, options.t);
    entries.set(id, entry);
  }

  const bound = entry;

  return {
    status: readonly(bound.status),
    lastError: readonly(bound.lastError),
    armedModifiers: readonly(bound.armedModifiers),
    mount: (host) => mountEntry(bound, host),
    unmount: () => unmountEntry(bound),
    reveal: () => revealTerminal(bound),
    input: (data) => bound.term.input(data),
    resetInput: () => bound.opened?.ime.reset(),
    toggleModifier: (modifier) => toggleModifier(bound, modifier),
    focus: () => bound.term.focus(),
    blur: () => bound.term.blur(),
    resume: () => resume(bound),
    reconnect: () => reconnect(bound)
  };
}

// Lets a terminal go: its connection closes (the session goes on in tmux) and its drawing is freed.
export function releaseRemoteTerminal(id: string): void {
  const entry = entries.get(id);

  if (!entry) return;

  entry.released = true;
  entries.delete(id);
  showingTerminal(id, false);
  clearTimeout(entry.retry);
  entry.observer?.disconnect();
  entry.element.remove();

  const socket = entry.socket;

  entry.socket = null;
  socket?.close(CLOSE_NORMAL, "released");

  for (const detach of entry.opened?.detach ?? []) detach();

  entry.opened?.ime.detach();
  entry.term.dispose();
}

export function remoteTerminalIds(): string[] {
  return [...entries.keys()];
}

function createEntry(id: string, baseURL: string, t: Translate): TerminalEntry {
  const element = document.createElement("div");

  element.className = "terminal-host";

  void whenFontsSettled();

  const term = seams.createTerminal({
    fontFamily: terminalFont(),
    fontSize: fontSize.value,
    theme: ARGONAUT_THEME,
    cursorBlink: true,
    cursorStyle: "block",
    convertEol: false,
    scrollback: 5000
  });

  const entry: TerminalEntry = {
    id,
    baseURL,
    t,
    element,
    term,
    host: null,
    observer: null,
    opened: null,
    socket: null,
    retry: undefined,
    attempts: 0,
    released: false,
    status: ref<RemoteTerminalStatus>("idle"),
    lastError: ref<string | null>(null),
    armedModifiers: ref<TerminalModifier[]>([])
  };

  applyPadding(entry);

  return entry;
}

// Opens the terminal on its element and wires its input. Done once, and only once the element has a
// size: a terminal opened in a hidden or unsized place measures its cells as nothing.
function openTerminal(entry: TerminalEntry): void {
  const { term, element } = entry;

  term.open(element);

  const detach: (() => void)[] = [
    attachTerminalClipboard(term, { host: element }),
    attachTerminalTouchScroll(term, element)
  ];

  // Every input — the device keyboard, the IME, the extra keys — passes here, so an armed modifier
  // applies exactly once whatever the key came from.
  const onData = term.onData((data) => sendInput(entry, consumeModifiers(entry, data)));
  const onResize = term.onResize(({ cols, rows }) => sendResize(entry, cols, rows));

  detach.push(
    () => onData.dispose(),
    () => onResize.dispose()
  );

  const ime = attachTerminalIme(term, { host: element, send: (data) => term.input(data) });

  // The view in front takes the size (see claimSize). A cursor already resting on the terminal
  // never enters it, so movement, presses and focus count as well.
  const claim = () => claimSize(entry);

  for (const type of ["pointerenter", "pointermove", "pointerdown", "focusin"] as const) {
    element.addEventListener(type, claim);
    detach.push(() => element.removeEventListener(type, claim));
  }

  entry.opened = { ime, detach };

  // A cell's size can change with the place unchanged — the carried face arriving late — and the
  // drawn area changes with it, so that is watched too.
  const screen = element.querySelector(".xterm-screen");

  if (screen) entry.observer?.observe(screen);

  // A terminal becomes real here, which for the one already on screen is the first moment it can
  // hold the keyboard. A view shown later claims it for itself.
  if (shownId === entry.id) claimTerminalKeyboard(entry.id);
}

function mountEntry(entry: TerminalEntry, host: HTMLElement): void {
  if (entry.released) return;

  entry.host = host;
  host.appendChild(entry.element);

  entry.observer?.disconnect();
  entry.observer = new ResizeObserver(() => revealTerminal(entry));
  entry.observer.observe(entry.element);

  const screen = entry.element.querySelector(".xterm-screen");

  if (screen) entry.observer.observe(screen);

  revealTerminal(entry);

  void whenFontsSettled().then(() => revealOnNextFrame(entry));
}

function unmountEntry(entry: TerminalEntry): void {
  entry.observer?.disconnect();
  entry.observer = null;
  entry.element.remove();
  entry.host = null;
}

// Brings the terminal on screen up to date.
//
// A terminal keeps receiving while it is hidden or out of the document, and xterm does not always
// repaint what arrived in the meantime when it is shown again: a size unchanged by the showing never
// triggers the resize that would redraw it, and its own visibility watch can miss a removal and a
// return that fall within one observation. Left to that, the screen stays black until the window is
// resized. So every way a terminal comes into view — a view mounting it, a tab shown, the document
// shown again, the faces arriving — comes here, and here it is fitted and then repainted whole,
// whether anything changed or not.
export function revealTerminal(entry: TerminalEntry): void {
  if (entry.released || !entry.host || !entry.element.isConnected) return;

  if (!entry.opened) {
    if (entry.element.clientWidth <= 0 || entry.element.clientHeight <= 0) return;

    openTerminal(entry);
  }

  fitTerminal(entry.term, entry.element);
  entry.term.refresh(0, Math.max(0, entry.term.rows - 1));

  if (!entry.socket && entry.status.value !== "closed" && entry.status.value !== "error") connect(entry);
}

function revealOnNextFrame(entry: TerminalEntry): void {
  if (!isClient()) return;

  requestAnimationFrame(() => revealTerminal(entry));
}

let pageWatched = false;

// The document coming back into view: every terminal is repainted, and a dropped connection is
// picked up at once rather than at its next retry.
function watchPage(): void {
  if (pageWatched || !isClient()) return;

  pageWatched = true;

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;

    for (const entry of entries.values()) {
      revealTerminal(entry);
      resume(entry);
    }
  });
}

export function socketUrl(entry: Pick<TerminalEntry, "id" | "baseURL">, cols: number, rows: number): string {
  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  const base = entry.baseURL.endsWith("/") ? entry.baseURL : `${entry.baseURL}/`;

  return `${scheme}//${location.host}${base}api/remote/terminals/${encodeURIComponent(entry.id)}/socket?cols=${cols}&rows=${rows}`;
}

export function inputFrame(data: string | Uint8Array): Uint8Array {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const frame = new Uint8Array(bytes.length + 1);

  frame[0] = FRAME_INPUT;
  frame.set(bytes, 1);

  return frame;
}

export function controlFrame(message: Record<string, unknown>): Uint8Array {
  const bytes = new TextEncoder().encode(JSON.stringify(message));
  const frame = new Uint8Array(bytes.length + 1);

  frame[0] = FRAME_CONTROL;
  frame.set(bytes, 1);

  return frame;
}

function connect(entry: TerminalEntry): void {
  if (entry.released || entry.socket) return;

  clearTimeout(entry.retry);
  entry.retry = undefined;
  entry.status.value = "opening";

  const socket = seams.openSocket(socketUrl(entry, entry.term.cols, entry.term.rows));

  socket.binaryType = "arraybuffer";
  entry.socket = socket;

  socket.onmessage = (event: MessageEvent) => {
    if (entry.socket !== socket) return;

    if (typeof event.data === "string") {
      control(entry, event.data);
    } else {
      entry.term.write(new Uint8Array(event.data as ArrayBuffer));
    }
  };

  socket.onclose = (event: CloseEvent) => {
    if (entry.socket !== socket) return;

    entry.socket = null;

    if (entry.released || entry.status.value === "closed") return;

    if (event.code === CLOSE_NOT_FOUND) {
      entry.status.value = "error";
      entry.lastError.value ??= entry.t("remote.error.no_terminal_session");

      return;
    }

    entry.status.value = "idle";
    scheduleRetry(entry);
  };
}

function control(entry: TerminalEntry, text: string): void {
  let message: { type?: unknown; code?: unknown; reason?: unknown };

  try {
    message = JSON.parse(text) as typeof message;
  } catch {
    return;
  }

  if (message.type === "ready") {
    entry.status.value = "open";
    entry.attempts = 0;
    entry.lastError.value = null;
  } else if (message.type === "exit") {
    entry.status.value = "closed";
    entry.term.writeln(`\r\n\x1b[33m[${entry.t("remote.status.session_ended")}]\x1b[0m`);
  } else if (message.type === "error") {
    entry.lastError.value = refusalText(entry.t, message);
  }
}

function scheduleRetry(entry: TerminalEntry): void {
  clearTimeout(entry.retry);

  const wait = RETRY_DELAYS_MS[Math.min(entry.attempts, RETRY_DELAYS_MS.length - 1)]!;

  entry.attempts += 1;
  entry.retry = setTimeout(() => {
    entry.retry = undefined;

    if (entry.host) connect(entry);
  }, wait);
}

function resume(entry: TerminalEntry): void {
  if (entry.released || entry.socket || entry.status.value === "closed" || entry.status.value === "error") return;
  if (!entry.opened) return;

  connect(entry);
}

function reconnect(entry: TerminalEntry): void {
  if (entry.released) return;

  entry.lastError.value = null;
  entry.status.value = "idle";
  entry.attempts = 0;
  entry.socket?.close(CLOSE_NORMAL, "reconnect");
  entry.socket = null;

  if (entry.opened) connect(entry);
}

function sendInput(entry: TerminalEntry, data: string): void {
  if (entry.socket?.readyState !== WebSocket.OPEN) return;

  entry.socket.send(inputFrame(data));
}

function sendResize(entry: TerminalEntry, cols: number, rows: number): void {
  if (entry.socket?.readyState !== WebSocket.OPEN) return;

  entry.socket.send(controlFrame({ type: "resize", cols, rows }));
}

const claimedAt = new WeakMap<TerminalEntry, number>();

// The view in front takes the size.
//
// One session watched from two places has one size, whichever was sent last, and the other view
// gets output laid out for a grid it does not have. So the moment a person stands before a view — a
// hand arriving, focus coming in — its size is sent again, even unchanged, and tmux redraws for it.
// Gestures within a short gap are dropped: each is a redraw.
function claimSize(entry: TerminalEntry): void {
  const now = performance.now();
  const last = claimedAt.get(entry);

  if (last !== undefined && now - last < CLAIM_INTERVAL_MS) return;

  claimedAt.set(entry, now);
  sendResize(entry, entry.term.cols, entry.term.rows);
}

function toggleModifier(entry: TerminalEntry, modifier: TerminalModifier): void {
  const armed = entry.armedModifiers.value;

  entry.armedModifiers.value = armed.includes(modifier)
    ? armed.filter((one) => one !== modifier)
    : [...armed, modifier];
}

// Applies the armed modifiers to one input and disarms them: a modifier lives for one key.
export function consumeModifiers(entry: Pick<TerminalEntry, "armedModifiers">, data: string): string {
  const modifiers = entry.armedModifiers.value;

  if (modifiers.length === 0) return data;

  entry.armedModifiers.value = [];

  return applyModifiers(data, modifiers);
}

// The bytes a modifier makes. Ctrl keeps a character's low five bits (Ctrl+C is \x03); Alt and Meta
// put an ESC in front. A key that is already an escape sequence, or a character outside ASCII, is
// left as it is.
export function applyModifiers(data: string, modifiers: TerminalModifier[]): string {
  if (data.length !== 1 || data.charCodeAt(0) > 0x7f) return data;

  let out = data;

  // Only Shift changes what was typed, so it goes first; only a letter has one shifted form.
  if (modifiers.includes("shift")) out = out.toUpperCase();
  if (modifiers.includes("ctrl")) out = String.fromCharCode(out.charCodeAt(0) & 0x1f);
  if (modifiers.includes("alt") || modifiers.includes("meta")) out = `${ESC}${out}`;

  return out;
}

// Fits the terminal to its place. The fit addon is not used: it assumes a 15px scrollbar wherever it
// cannot measure one, and on a phone, where the bar floats over the text, that leaves columns empty.
export function fitTerminal(term: Terminal, host: HTMLElement): boolean {
  const size = proposeTerminalSize(term, host);

  if (!size) return false;

  if (size.cols !== term.cols || size.rows !== term.rows) term.resize(size.cols, size.rows);

  return true;
}

// The rows and columns that fit, with the cell size read back from what is drawn.
export function proposeTerminalSize(term: Terminal, host: HTMLElement): { cols: number; rows: number } | null {
  const xterm = host.querySelector<HTMLElement>(".xterm");
  const screen = host.querySelector<HTMLElement>(".xterm-screen");

  // A detached element has no computed style, and measuring it breaks rows and columns.
  if (!xterm || !screen || !host.isConnected) return null;

  const cols = term.cols;
  const rows = term.rows;

  if (cols <= 0 || rows <= 0) return null;

  const cell = { width: screen.clientWidth / cols, height: screen.clientHeight / rows };

  if (cell.width <= 0 || cell.height <= 0) return null;

  const style = getComputedStyle(xterm);
  const padX = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
  const padY = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
  const viewport = host.querySelector<HTMLElement>(".xterm-viewport");
  const bar = viewport ? viewport.offsetWidth - viewport.clientWidth : 0;

  return {
    cols: Math.max(MINIMUM_COLS, Math.floor((host.clientWidth - padX - bar) / cell.width)),
    rows: Math.max(MINIMUM_ROWS, Math.floor((host.clientHeight - padY) / cell.height))
  };
}

// The name a session is shown under: its label, or its id where it has none.
export function sessionName(session: { id: string; label: string }): string {
  return session.label || session.id;
}
