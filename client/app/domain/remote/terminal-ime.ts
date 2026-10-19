import type { Terminal } from "@xterm/xterm";

// Korean input for the remote terminal (docs/remote.md, 「Rules the interface keeps」), carried over
// from trainer's terminal.
//
// xterm's own composition handling defers both `keydown(229)` and `compositionend` with
// `setTimeout(0)` and diffs the helper textarea when they run. The two delayed queues race, so a
// composed syllable can leave after the letter typed behind it ("안녕하세요 저는" arrives as
// "안녕하세 요저는"). Here the composition events are taken on the host in the capture phase, before
// xterm sees them, and what is committed is sent synchronously, in order.

// The key code a browser reports for a key the IME took.
const IME_KEY_CODE = 229;

const ESC = "\x1b";
const CR = "\r";

// How long a commit is held before it is sent (ms).
//
// Keyboards that stack a final consonant (천지인 and the like) commit `안`, then open a new
// composition at once that swallows that `안` again and puts `않` in its place. Sent at the commit,
// `안` would already be gone to the shell, where it cannot be taken back, and `안않` would remain.
// The measured gap is 3 ms; this leaves room for a slow machine and is still not a delay anyone
// notices.
const SETTLE_MS = 24;

// Keys that make no character by themselves. Pressed during a composition they must not end it:
// a double consonant (ㅆ, ㄲ) is typed through Shift, and reading Shift as the end would send `이`
// before `있`.
const NON_INPUT_KEYS = new Set([
  "Shift",
  "Control",
  "Alt",
  "AltGraph",
  "Meta",
  "CapsLock",
  "NumLock",
  "ScrollLock",
  "HangulMode",
  "HanjaMode"
]);

// Input types that end the line the keyboard was writing.
const LINE_BREAKS = new Set(["insertLineBreak", "insertParagraph"]);

// Whether the terminal gives a character two cells. Only what a composer produces is ever shown in
// the preview, and these ranges cover it.
function isWide(character: string): boolean {
  const code = character.codePointAt(0) ?? 0;

  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0x303e) ||
    (code >= 0x3041 && code <= 0x33ff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0xa960 && code <= 0xa97f) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6)
  );
}

const CAPTURED_EVENTS = ["compositionstart", "compositionupdate", "compositionend", "keydown", "input"] as const;

type CapturedEvent = (typeof CAPTURED_EVENTS)[number];

export interface TerminalImeOptions {
  // The element xterm is opened on; composition events are taken on it in the capture phase.
  host: HTMLElement;
  // Hands committed text to the terminal as input.
  send: (data: string) => void;
}

export interface TerminalIme {
  // Ends the line the keyboard was writing: whatever is held is sent, and the board starts empty.
  // Called for every key of the extra-keys row, which reaches the shell without passing here.
  reset: () => void;
  detach: () => void;
}

// A plain Escape. With an IME active the browser hides `key` behind "Process" and `keyCode` behind
// 229, so the physical `code` is read first.
function isPlainEscape(event: KeyboardEvent): boolean {
  if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return false;

  return event.code === "Escape" || event.key === "Escape";
}

function isEnter(event: KeyboardEvent): boolean {
  return event.key === "Enter" || event.code === "Enter" || event.code === "NumpadEnter";
}

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;

// How many characters two boards share from the front. A boundary falling inside a surrogate pair
// steps back one, so half an emoji is never taken as sent.
export function commonPrefixLength(before: string, after: string): number {
  const limit = Math.min(before.length, after.length);
  let length = 0;

  while (length < limit && before[length] === after[length]) length += 1;

  return length > 0 && isHighSurrogate(before.charCodeAt(length - 1)) ? length - 1 : length;
}

// How many characters two boards share from the back, not reaching into the shared front.
export function commonSuffixLength(before: string, after: string, prefix: number): number {
  const limit = Math.min(before.length, after.length) - prefix;
  let length = 0;

  while (length < limit && before[before.length - 1 - length] === after[after.length - 1 - length]) length += 1;

  return length > 0 && isLowSurrogate(before.charCodeAt(before.length - length)) ? length - 1 : length;
}

export function attachTerminalIme(term: Terminal, options: TerminalImeOptions): TerminalIme {
  const textarea = term.textarea;

  if (!textarea) return { reset: () => {}, detach: () => {} };

  return attachIme(term, textarea, options);
}

function attachIme(term: Terminal, textarea: HTMLTextAreaElement, options: TerminalImeOptions): TerminalIme {
  const { host, send } = options;
  const view = host.querySelector<HTMLElement>(".composition-view");

  let composing = false;
  // The character behind a key the IME took (keydown 229) is known only from the input after it.
  let awaitingInput = false;
  // A composition forced to commit before its compositionend; that compositionend sends nothing.
  let flushed = false;
  // The line ended while a composition could still be alive; the board is emptied once it is not.
  let lineEnded = false;
  // What has been sent to the shell. The part of the board shared with it from the front is gone
  // already; only what follows is new.
  //
  // The textarea is the keyboard's, not ours. The keyboard counts where its composition starts on
  // that board, and a board changed under it loses that place: asked to swallow the syllable before,
  // it adds beside it instead, and the board itself carries the letter twice (`있긴한데` written as
  // `있긴긴한데`). So the board is emptied only where no composition can be alive — when the line
  // ends and when focus leaves.
  let sent = "";
  let settling: ReturnType<typeof setTimeout> | undefined;

  function block(event: Event): void {
    event.stopPropagation();
  }

  // The size of one cell, read back from the size the renderer settled on.
  function cellSize(): { width: number; height: number } {
    const screen = host.querySelector<HTMLElement>(".xterm-screen");

    if (!screen || term.cols <= 0 || term.rows <= 0) return { width: 0, height: 0 };

    return { width: screen.clientWidth / term.cols, height: screen.clientHeight / term.rows };
  }

  function moveView(): void {
    if (!view) return;

    const { width: cellWidth, height: cellHeight } = cellSize();

    if (cellWidth <= 0) return;

    const buffer = term.buffer.active;

    view.style.left = `${Math.min(buffer.cursorX, term.cols - 1) * cellWidth}px`;
    view.style.top = `${buffer.cursorY * cellHeight}px`;
    view.style.height = `${cellHeight}px`;
    view.style.lineHeight = `${cellHeight}px`;
    // The terminal's own face and size; the preview layer would otherwise inherit the page's.
    view.style.fontFamily = term.options.fontFamily ?? "";
    view.style.fontSize = `${term.options.fontSize ?? 0}px`;
  }

  function onCompositionStart(event: CompositionEvent): void {
    block(event);

    // A commit still held means this composition came to swallow it: the held commit is dropped
    // and the preview kept, so `안` does not blink while `않` is built.
    const continuing = settling !== undefined;

    clearTimeout(settling);
    settling = undefined;

    composing = true;
    awaitingInput = false;
    flushed = false;

    if (view) {
      if (!continuing) view.textContent = "";

      view.classList.add("active");
      moveView();
    }
  }

  function onCompositionUpdate(event: CompositionEvent): void {
    block(event);
    // Only the place is set here; the characters are drawn on `input`, once the textarea holds them.
    moveView();
  }

  // Draws what is composed and not yet sent, one cell (or two) per character, read from the
  // textarea: the event carries only what this composition made, without the syllable it reopened.
  function paintPreview(): void {
    if (!view) return;

    const pending = textarea.value.slice(commonPrefixLength(sent, textarea.value));

    view.textContent = "";

    const cell = cellSize();

    for (const character of pending) {
      const box = document.createElement("span");

      box.textContent = character;
      box.style.display = "inline-block";
      box.style.width = `${cell.width * (isWide(character) ? 2 : 1)}px`;
      box.style.textAlign = "center";
      view.append(box);
    }

    moveView();
  }

  // Sends what the board holds beyond what was sent.
  //
  // The board does not only grow behind what was sent. A keyboard moving a final consonant onto the
  // next syllable rewrites the last sent place (`욘` becomes `요나`), and what follows the shared
  // front is then sent as new. But a keyboard may also rewrite the middle of the board while the
  // text after it stays — an autocorrection replacing a word already typed past. The shared front
  // then ends at the edit, and everything after it, already sent, would go out a second time and
  // repeat with whatever is typed next. Sent bytes cannot be taken back and a shell's line cannot
  // be edited from here, so such a rewrite sends nothing: the board is taken as the new truth.
  function drain(): void {
    const value = textarea.value;
    const prefix = commonPrefixLength(sent, value);
    const rewroteMiddle = prefix < sent.length && commonSuffixLength(sent, value, prefix) > 0;
    const fresh = rewroteMiddle ? "" : value.slice(prefix);

    sent = value;

    if (fresh) send(fresh);
  }

  // Sends the finished characters in front of what this composition holds; they are out of its
  // reach. A board that does not end with the composition's data cannot be read, and then nothing is
  // sent: sending late is better than sending wrong.
  function releaseSettledPrefix(data: string): void {
    if (!data) return;

    const value = textarea.value;

    if (!value.endsWith(data) || value.length === data.length) return;

    const settledLength = value.length - data.length;
    const shared = commonPrefixLength(sent, value);

    if (settledLength <= shared) return;

    const fresh = value.slice(shared, settledLength);

    sent = value.slice(0, settledLength);

    if (fresh) send(fresh);

    paintPreview();
  }

  // Empties the board once the line it held has ended and no composition can still count on it.
  function endLine(): void {
    if (composing || flushed) {
      lineEnded = true;

      return;
    }

    lineEnded = false;
    textarea.value = "";
    sent = "";
  }

  // The hold ran out with no new composition: the commit is final.
  function settle(): void {
    settling = undefined;

    drain();

    view?.classList.remove("active");

    // Space or punctuation that ended the composition arrives in the input that follows.
    awaitingInput = true;

    if (lineEnded) endLine();
  }

  // Finishes a held commit at once, before a key unrelated to the composition reaches xterm.
  function settleNow(): void {
    if (settling === undefined) return;

    clearTimeout(settling);
    settle();
  }

  function onCompositionEnd(event: CompositionEvent): void {
    block(event);

    if (flushed) {
      flushed = false;
      composing = false;
      view?.classList.remove("active");

      if (lineEnded) endLine();

      return;
    }

    composing = false;

    // Some browsers send an empty `data`; the textarea is what is read.
    if (!textarea.value && event.data) textarea.value = event.data;

    // What stands before this composition's own text cannot be swallowed by it and goes now; the
    // composition's last character is held.
    releaseSettledPrefix(event.data);

    clearTimeout(settling);
    settling = setTimeout(settle, SETTLE_MS);
  }

  // Commits the composition before a key the IME did not take reaches xterm. The browser's
  // composition may still be alive, so the textarea is left as it is; compositionend tidies up.
  function flushComposition(): void {
    if (!composing) return;

    composing = false;
    flushed = true;
    view?.classList.remove("active");

    drain();
  }

  function onKeyDown(event: KeyboardEvent): void {
    // Escape is sent from here: with an IME active its key code reads 229, and xterm lets it pass
    // as a composition key, so it would never arrive.
    if (isPlainEscape(event)) {
      block(event);
      settleNow();
      flushComposition();
      awaitingInput = false;
      send(ESC);
      return;
    }

    // Modifier and mode keys change nothing here, and must not drop `awaitingInput`.
    if (NON_INPUT_KEYS.has(event.key)) return;

    if (event.keyCode === IME_KEY_CODE) {
      block(event);
      awaitingInput = true;

      // An Enter the IME took still ends the line: at once when nothing is composed or held, and
      // otherwise once that commit is through.
      if (isEnter(event)) {
        if (settling === undefined) endLine();
        else lineEnded = true;
      }

      return;
    }

    // A key the IME did not take goes on to xterm, after whatever composition was pending.
    settleNow();
    flushComposition();
    awaitingInput = false;

    // An ended line ends the board. A chord ends it too: it is a command to the shell, and the
    // keyboard's text before it is no longer the line being written.
    if (isEnter(event) || event.ctrlKey || event.altKey) endLine();
  }

  function onInput(event: Event): void {
    const { inputType, isComposing } = event as InputEvent;

    if (composing || isComposing) {
      block(event);
      paintPreview();
      return;
    }

    // The input reflecting a commit. The hold decides whether it is final.
    if (inputType === "insertCompositionText") {
      block(event);
      return;
    }

    // Input nobody waited for is xterm's; what the board holds counts as sent, or the next commit
    // would send again what xterm already did.
    if (!awaitingInput) {
      sent = textarea.value;

      return;
    }

    block(event);
    settleNow();
    awaitingInput = false;

    // A line break the IME took: the text before it, then the terminal's own Enter.
    if (LINE_BREAKS.has(inputType)) {
      textarea.value = textarea.value.replace(/[\r\n]+$/, "");
      drain();
      send(CR);
      lineEnded = false;
      endLine();
      return;
    }

    drain();

    if (lineEnded) endLine();
  }

  const handlers: Record<CapturedEvent, EventListener> = {
    compositionstart: onCompositionStart as EventListener,
    compositionupdate: onCompositionUpdate as EventListener,
    compositionend: onCompositionEnd as EventListener,
    keydown: onKeyDown as EventListener,
    input: onInput
  };

  // The preview follows the cursor, which moves only once the sent text has come back from the shell.
  const cursorMove = term.onCursorMove?.(() => {
    if (view?.classList.contains("active")) moveView();
  });

  // Focus leaving ends the board: no composition is alive, and the keyboard lets go of its place.
  function onBlur(): void {
    settleNow();

    textarea.value = "";
    sent = "";
    lineEnded = false;
  }

  function reset(): void {
    settleNow();
    flushComposition();
    awaitingInput = false;
    endLine();
  }

  textarea.addEventListener("blur", onBlur);

  for (const type of CAPTURED_EVENTS) {
    host.addEventListener(type, handlers[type], true);
  }

  return {
    reset,
    detach() {
      cursorMove?.dispose();
      // A held commit is sent before the terminal goes; closing it is not losing the last letter.
      settleNow();
      textarea.removeEventListener("blur", onBlur);

      for (const type of CAPTURED_EVENTS) {
        host.removeEventListener(type, handlers[type], true);
      }
    }
  };
}
