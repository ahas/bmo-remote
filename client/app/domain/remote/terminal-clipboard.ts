import type { Terminal } from "@xterm/xterm";

// Copy and paste for the remote terminal, carried over from trainer's terminal.
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

export interface TerminalClipboardOptions {
  host: HTMLElement;
  // Copy a selection as soon as it is made.
  copyOnSelect?: boolean;
  pasteEnabled?: boolean;
}

export function attachTerminalClipboard(term: Terminal, options: TerminalClipboardOptions): () => void {
  const { host, copyOnSelect = true, pasteEnabled = true } = options;

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

  // The shortcuts, before xterm consumes the key.
  function onKeyEvent(event: KeyboardEvent): boolean {
    if (event.type !== "keydown") return true;

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

  return () => {
    term.attachCustomKeyEventHandler(() => true);
    host.removeEventListener("mouseup", onMouseUp);
    host.removeEventListener("keydown", flushDeferred, true);
    host.removeEventListener("mousedown", flushDeferred, true);
    osc52Handler.dispose();
  };
}
