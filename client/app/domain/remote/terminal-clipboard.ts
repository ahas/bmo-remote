import type { Terminal } from "@xterm/xterm";

// Copy and paste for the remote terminal (docs/remote.md, 「The terminal interface」).
//
// xterm turns the browser's own selection off and draws its own, which never reaches the
// clipboard, and it sends Ctrl+C to the shell as an interrupt — so on Windows and Linux there is no
// way to copy at all. This adds:
// - copying a selection the moment it is made;
// - Ctrl+Shift+C / Ctrl+Insert to copy, Ctrl+Shift+V / Shift+Insert to paste (macOS's Cmd+C and
//   Cmd+V stay xterm's);
// - OSC 52, how a program in the terminal (nvim's `"+y`, tmux's copy mode) asks for the clipboard.
//   xterm does not implement it. Such a write does not start from a gesture, which most browsers
//   refuse; a refused text is kept and written on the next press.
// - a pasted picture. A browser's paste carries words alone to a terminal, and a program there reads a picture from
//   the clipboard of the machine it runs on, which is not the reader's. A paste holding a picture is handed to the
//   caller, which keeps it as a file on that machine, and the file's path is pasted as words, the way a file
//   dropped on a terminal arrives. Ctrl+V, which xterm sends the program as a key, is read the same way where the
//   browser lets the page read the clipboard, and is the key it always was where the clipboard holds no picture.

// The largest OSC 52 payload taken for the clipboard (base64 characters).
const OSC52_MAX_PAYLOAD = 1_000_000;

function isCopyShortcut(event: KeyboardEvent): boolean {
  if (event.code === "KeyC") return event.ctrlKey && event.shiftKey;
  if (event.code === "Insert") return event.ctrlKey && !event.shiftKey;

  return false;
}

// Both raise the browser's own paste, which xterm takes, bracketed paste included.
function isPasteShortcut(event: KeyboardEvent): boolean {
  if (event.code === "KeyV") return event.ctrlKey && event.shiftKey;
  if (event.code === "Insert") return event.shiftKey && !event.ctrlKey;

  return false;
}

// The text of an OSC 52 body (`<selection>;<base64>`), or null. A request to read the clipboard back
// (`?`) is never answered — that would hand the owner's clipboard to whatever runs in the shell —
// but the sequence is still consumed, so no escape leaks onto the screen.
export function decodeOsc52(data: string): string | null {
  const separator = data.indexOf(";");

  if (separator < 0) return null;

  const payload = data.slice(separator + 1);

  if (payload === "" || payload === "?") return null;
  if (payload.length > OSC52_MAX_PAYLOAD) return null;

  try {
    const binary = atob(payload);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));

    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

// One thing a paste or the clipboard holds, as far as a picture is looked for in it.
interface Held {
  kind?: string;
  type: string;
  getAsFile?: () => File | null;
}

/** The first picture among what a paste holds, or null where it holds none. */
export function pastedPicture(items: Iterable<Held> | ArrayLike<Held> | null | undefined): File | null {
  for (const item of Array.from(items ?? [])) {
    if (item.kind === "file" && item.type.startsWith("image/")) {
      const file = item.getAsFile?.() ?? null;

      if (file !== null) return file;
    }
  }

  return null;
}

/** A kept file's path as the words a terminal is pasted: as it stands, or quoted where it holds a blank. */
export function pastedPath(path: string): string {
  return /\s/.test(path) ? `'${path.replaceAll("'", "'\\''")}' ` : `${path} `;
}

// Ctrl+V alone, the key xterm sends the program as it is.
function isPlainPaste(event: KeyboardEvent): boolean {
  return event.code === "KeyV" && event.ctrlKey && !event.shiftKey && !event.altKey && !event.metaKey;
}

export interface TerminalClipboardOptions {
  host: HTMLElement;
  // Copy a selection as soon as it is made.
  copyOnSelect?: boolean;
  pasteEnabled?: boolean;
  // Keeps a pasted picture where the program in the terminal can open it, and answers the file's path there, or
  // null where it could not be kept. Without it a picture is not looked for.
  keepPicture?: (picture: Blob) => Promise<string | null>;
}

export function attachTerminalClipboard(term: Terminal, options: TerminalClipboardOptions): () => void {
  const { host, copyOnSelect = true, pasteEnabled = true, keepPicture } = options;

  // Text the clipboard refused for want of a gesture, tried again on the next press.
  let deferred: string | null = null;

  async function writeClipboard(text: string): Promise<boolean> {
    try {
      await navigator.clipboard.writeText(text);
      deferred = null;

      return true;
    } catch {
      // Not https, no permission, or outside a gesture: the fallback below.
    }

    const scratch = document.createElement("textarea");

    scratch.value = text;
    scratch.setAttribute("readonly", "");
    scratch.style.position = "fixed";
    scratch.style.opacity = "0";
    document.body.appendChild(scratch);
    scratch.select();

    try {
      const copied = document.execCommand("copy");

      if (copied) deferred = null;

      return copied;
    } finally {
      scratch.remove();
      term.focus();
    }
  }

  function copySelection(): void {
    const selection = term.getSelection();

    if (selection) void writeClipboard(selection);
  }

  // A text that could not be written is kept; dropping it would lose what the owner thinks is copied.
  function copyOrDefer(text: string): void {
    deferred = null;

    void writeClipboard(text).then((copied) => {
      if (!copied) deferred = text;
    });
  }

  // Inside a press, so the gesture rule is met.
  function flushDeferred(): void {
    const text = deferred;

    if (text === null) return;

    copyOrDefer(text);
  }

  function onOsc52(data: string): boolean {
    const text = decodeOsc52(data);

    if (text !== null) copyOrDefer(text);

    // Handled, so the sequence ends here.
    return true;
  }

  function onMouseUp(): void {
    if (!copyOnSelect) return;

    // xterm settles the selection on the document's mouseup, so this waits one tick.
    setTimeout(() => {
      if (term.hasSelection()) copySelection();
    }, 0);
  }

  // A picture kept on the terminal's machine arrives as its path, pasted as words.
  async function pastePicture(picture: Blob): Promise<void> {
    const path = await keepPicture?.(picture).catch(() => null);

    if (path) term.paste(pastedPath(path));
  }

  // The browser's own paste, taken before xterm where it holds a picture; a paste of words is xterm's as before.
  function onPaste(event: ClipboardEvent): void {
    if (!pasteEnabled || keepPicture === undefined) return;

    const picture = pastedPicture(event.clipboardData?.items);

    if (picture === null) return;

    event.preventDefault();
    event.stopPropagation();
    void pastePicture(picture);
  }

  // Ctrl+V with the clipboard read by the page: a picture on it is kept and its path pasted, and with none the key
  // goes to the program as xterm would have sent it.
  async function pasteFromClipboard(): Promise<void> {
    try {
      for (const item of await navigator.clipboard.read()) {
        const type = item.types.find((one) => one.startsWith("image/"));

        if (type !== undefined) {
          await pastePicture(await item.getType(type));

          return;
        }
      }
    } catch {
      // No permission or no gesture: the key below.
    }

    term.input("\x16", true);
  }

  // The shortcuts, before xterm consumes the key.
  function onKeyEvent(event: KeyboardEvent): boolean {
    if (event.type !== "keydown") return true;

    if (pasteEnabled && keepPicture !== undefined && isPlainPaste(event) && typeof navigator.clipboard?.read === "function") {
      event.preventDefault();
      void pasteFromClipboard();
      return false;
    }

    if (isCopyShortcut(event)) {
      event.preventDefault();
      copySelection();
      return false;
    }

    if (pasteEnabled && isPasteShortcut(event)) {
      // No preventDefault: the browser raises its own paste on the textarea and xterm takes it.
      // Returning false only stops xterm sending the key itself (Ctrl+V as \x16).
      return false;
    }

    return true;
  }

  term.attachCustomKeyEventHandler(onKeyEvent);
  host.addEventListener("mouseup", onMouseUp);

  const osc52Handler = term.parser.registerOscHandler(52, onOsc52);

  // The capture phase, so a press xterm swallows still passes here first.
  host.addEventListener("keydown", flushDeferred, true);
  host.addEventListener("mousedown", flushDeferred, true);
  host.addEventListener("paste", onPaste, true);

  return () => {
    host.removeEventListener("paste", onPaste, true);
    term.attachCustomKeyEventHandler(() => true);
    host.removeEventListener("mouseup", onMouseUp);
    host.removeEventListener("keydown", flushDeferred, true);
    host.removeEventListener("mousedown", flushDeferred, true);
    osc52Handler.dispose();
  };
}
