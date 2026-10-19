// Touch and the on-screen keyboard for the remote desktop (docs/remote.md, 「One desktop」).
//
// IronRDP's component reads a mouse from its canvas — position, buttons, wheel — and keys from the
// window while focus is inside it. A phone gives neither: a finger makes pointer events and, for a
// tap, a click at most; its keyboard types into a text box. So a finger's gestures are turned into
// the mouse events the canvas reads, and what is typed into a box standing inside the component is
// mirrored on the desktop.

import { commonPrefixLength } from "./terminal-ime";

// Travel past this is a drag, not a tap (px).
export const TAP_SLOP_PX = 8;
// Holding this long without moving is a right press (ms).
export const LONG_PRESS_MS = 500;
// Two fingers moving this far is one wheel step (px).
export const WHEEL_STEP_PX = 20;
// In pointer mode, how far the pointer moves for each pixel the finger moves.
export const POINTER_SPEED = 1.5;
// In pointer mode, a finger put down again this soon after a tap, and this near it, drags (ms, px).
export const DOUBLE_TAP_MS = 300;
export const DOUBLE_TAP_PX = 24;

// How a finger works the desktop: where it touches, or like a laptop's touchpad moving a pointer.
export type DesktopTouchMode = "touch" | "pointer";

const LEFT = 0;
const RIGHT = 2;

type Point = { x: number; y: number };

// How far apart the first two fingers are.
function spread(touches: TouchList): number {
  return Math.hypot(touches[1]!.clientX - touches[0]!.clientX, touches[1]!.clientY - touches[0]!.clientY);
}

function average(touches: TouchList): Point {
  let x = 0;
  let y = 0;

  for (let index = 0; index < touches.length; index += 1) {
    x += touches[index]!.clientX;
    y += touches[index]!.clientY;
  }

  return { x: x / touches.length, y: y / touches.length };
}

// How far two fingers may magnify the desktop while the phone's keyboard is up.
export const MAX_ZOOM = 4;

// The desktop as shown while the phone's keyboard is laid over it: moved and magnified, so what the
// keyboard covers can be brought into sight (docs/remote.md, 「One desktop」). The keyboard going down
// puts it back as it was.
export interface DesktopView {
  // Whether the keyboard is up, so gestures move the view.
  movable: () => boolean;
  // The keyboard came up or went down.
  keyboard: (up: boolean) => void;
  pan: (dx: number, dy: number) => void;
  // Magnifies by a factor, keeping the point of the window under it where it is.
  zoom: (factor: number, at: Point) => void;
  detach: () => void;
}

// A view of the element holding the desktop, which stands over the whole of its place. The element
// is moved by a transform, so its place keeps its size and the component reads a press where the
// desktop is shown under it.
export function createDesktopView(host: HTMLElement): DesktopView {
  let up = false;
  let scale = 1;
  let x = 0;
  let y = 0;
  // How much of the place's foot the keyboard covers (px).
  let covered = 0;

  function readCovered(): void {
    const rect = virtualKeyboard()?.boundingRect;
    const place = (host.parentElement ?? host).getBoundingClientRect();

    covered = rect && rect.height > 0 ? Math.min(place.height, Math.max(0, place.bottom - rect.top)) : 0;
  }

  // Keeps the view on the desktop: never past its edges, and the part above the keyboard filled.
  function apply(): void {
    if (!up) {
      scale = 1;
      x = 0;
      y = 0;
      host.style.transform = "";
      host.style.transformOrigin = "";

      return;
    }

    const width = host.clientWidth;
    const height = host.clientHeight;

    x = Math.min(0, Math.max(width - width * scale, x));
    y = Math.min(0, Math.max(height - covered - height * scale, y));
    host.style.transformOrigin = "0 0";
    host.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
  }

  function onGeometry(): void {
    readCovered();
    apply();
  }

  return {
    movable: () => up,
    keyboard(on) {
      if (on === up) return;

      up = on;

      if (on) {
        virtualKeyboard()?.addEventListener("geometrychange", onGeometry);
        readCovered();
      } else {
        virtualKeyboard()?.removeEventListener("geometrychange", onGeometry);
        covered = 0;
      }

      apply();
    },
    pan(dx, dy) {
      if (!up) return;

      x += dx;
      y += dy;
      apply();
    },
    zoom(factor, at) {
      if (!up) return;

      const next = Math.min(MAX_ZOOM, Math.max(1, scale * factor));
      const bounds = host.getBoundingClientRect();
      const kept = 1 - next / scale;

      x += (at.x - bounds.left) * kept;
      y += (at.y - bounds.top) * kept;
      scale = next;
      apply();
    },
    detach() {
      virtualKeyboard()?.removeEventListener("geometrychange", onGeometry);
      up = false;
      apply();
    }
  };
}

// Gestures on the desktop's place, turned into mouse events on the canvas. In touch mode:
// - a tap is a left click where the finger was;
// - a drag is a left-button drag;
// - holding still is a right click;
// - two fingers moving up or down turn the wheel.
// In pointer mode the finger moves a pointer instead, as on a touchpad: a drag moves it, a tap is a
// left click where it stands, holding still is a right click there, a tap and a second touch that
// moves is a left-button drag, and two fingers turn the wheel.
// While the view can be moved, two fingers pinch and move it instead of turning the wheel, and in touch
// mode a drag moves it instead of holding the button.
export function attachDesktopTouch(
  host: HTMLElement,
  canvas: () => HTMLCanvasElement | null,
  mode: () => DesktopTouchMode = () => "touch",
  view: DesktopView | null = null
): () => void {
  let start: Point | null = null;
  let last: Point = { x: 0, y: 0 };
  let pointer: Point | null = null;
  let lastTap: { at: number; point: Point } | null = null;
  let pointerDrag = false;
  let moved = false;
  let dragging = false;
  let longFired = false;
  let twoFinger = false;
  let wheelY = 0;
  let panning = false;
  // Where two fingers moving the view last were: how far apart, and their middle.
  let pinch: { spread: number; middle: Point } | null = null;
  let longTimer: ReturnType<typeof setTimeout> | undefined;

  const previousTouchAction = host.style.touchAction;

  // The browser must not pan or zoom the page with these gestures; they are the desktop's.
  host.style.touchAction = "none";

  function mouse(type: string, point: Point, button: number, buttons: number): void {
    canvas()?.dispatchEvent(
      new MouseEvent(type, {
        clientX: point.x,
        clientY: point.y,
        button,
        buttons,
        bubbles: true,
        composed: true,
        cancelable: true
      })
    );
  }

  function click(point: Point, button: number): void {
    const held = button === RIGHT ? 2 : 1;

    mouse("mousemove", point, LEFT, 0);
    mouse("mousedown", point, button, held);
    mouse("mouseup", point, button, 0);
  }

  function wheel(point: Point, deltaY: number): void {
    canvas()?.dispatchEvent(
      new WheelEvent("wheel", {
        clientX: point.x,
        clientY: point.y,
        deltaY,
        deltaMode: 0,
        bubbles: true,
        composed: true,
        cancelable: true
      })
    );
  }

  function pointerMode(): boolean {
    return mode() === "pointer";
  }

  // Where the pointer stands: kept inside the canvas, and put in its middle the first time.
  function pointerAt(): Point {
    const bounds = canvas()?.getBoundingClientRect();

    pointer ??= bounds ? { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 } : { ...last };

    return pointer;
  }

  function movePointer(dx: number, dy: number): Point {
    const bounds = canvas()?.getBoundingClientRect();
    const at = pointerAt();
    const x = at.x + dx * POINTER_SPEED;
    const y = at.y + dy * POINTER_SPEED;

    pointer = bounds
      ? { x: Math.min(bounds.right - 1, Math.max(bounds.left, x)), y: Math.min(bounds.bottom - 1, Math.max(bounds.top, y)) }
      : { x, y };

    return pointer;
  }

  // Where a press lands: under the finger, or where the pointer stands.
  function pressPoint(finger: Point): Point {
    return pointerMode() ? pointerAt() : finger;
  }

  function cancelLong(): void {
    clearTimeout(longTimer);
    longTimer = undefined;
  }

  function onTouchStart(event: TouchEvent): void {
    event.preventDefault();

    if (event.touches.length >= 2) {
      cancelLong();

      if (dragging) mouse("mouseup", last, LEFT, 0);

      dragging = false;
      panning = false;
      twoFinger = true;
      wheelY = average(event.touches).y;
      pinch = { spread: spread(event.touches), middle: average(event.touches) };

      return;
    }

    const touch = event.touches[0]!;

    start = { x: touch.clientX, y: touch.clientY };
    last = start;
    moved = false;
    dragging = false;
    panning = false;
    longFired = false;
    twoFinger = false;
    pointerDrag = false;

    if (pointerMode()) {
      const now = Date.now();
      const again = lastTap !== null && now - lastTap.at <= DOUBLE_TAP_MS && Math.hypot(start.x - lastTap.point.x, start.y - lastTap.point.y) <= DOUBLE_TAP_PX;

      lastTap = null;

      if (again) {
        pointerDrag = true;
        mouse("mousedown", pointerAt(), LEFT, 1);

        return;
      }
    } else {
      mouse("mousemove", start, LEFT, 0);
    }

    longTimer = setTimeout(() => {
      longTimer = undefined;

      if (moved || twoFinger || !start) return;

      longFired = true;
      click(pressPoint(start), RIGHT);
    }, LONG_PRESS_MS);
  }

  function onTouchMove(event: TouchEvent): void {
    event.preventDefault();

    if (twoFinger) {
      if (event.touches.length < 2) return;

      if (view?.movable() && pinch) {
        const middle = average(event.touches);
        const apart = spread(event.touches);

        view.pan(middle.x - pinch.middle.x, middle.y - pinch.middle.y);
        if (pinch.spread > 0) view.zoom(apart / pinch.spread, middle);
        pinch = { spread: apart, middle };

        return;
      }

      const y = average(event.touches).y;
      const steps = Math.trunc((y - wheelY) / WHEEL_STEP_PX);

      if (steps === 0) return;

      wheelY += steps * WHEEL_STEP_PX;
      // Fingers going up move the content up, as a wheel turned toward the reader does.
      wheel(average(event.touches), -steps * WHEEL_STEP_PX);

      return;
    }

    const touch = event.touches[0];

    if (!touch || !start) return;

    if (pointerMode()) {
      const previous = last;

      last = { x: touch.clientX, y: touch.clientY };

      if (!moved && Math.hypot(last.x - start.x, last.y - start.y) > TAP_SLOP_PX) {
        moved = true;
        cancelLong();
      }

      if (moved || pointerDrag) mouse("mousemove", movePointer(last.x - previous.x, last.y - previous.y), LEFT, pointerDrag ? 1 : 0);

      return;
    }

    const previous = moved ? last : start;

    last = { x: touch.clientX, y: touch.clientY };

    if (!moved && Math.hypot(last.x - start.x, last.y - start.y) > TAP_SLOP_PX) {
      moved = true;
      cancelLong();

      if (!longFired && view?.movable()) {
        panning = true;
      } else if (!longFired) {
        dragging = true;
        mouse("mousedown", start, LEFT, 1);
      }
    }

    if (panning) view?.pan(last.x - previous.x, last.y - previous.y);
    else if (moved) mouse("mousemove", last, LEFT, dragging ? 1 : 0);
  }

  function onTouchEnd(event: TouchEvent): void {
    // The browser's own mouse events after a tap would click a second time.
    if (event.cancelable) event.preventDefault();

    cancelLong();

    if (twoFinger) {
      if (event.touches.length === 0) {
        twoFinger = false;
        pinch = null;
      }

      return;
    }

    if (pointerDrag) {
      mouse("mouseup", pointerAt(), LEFT, 0);
      pointerDrag = false;
    } else if (dragging) {
      mouse("mouseup", last, LEFT, 0);
      dragging = false;
    } else if (panning) {
      panning = false;
    } else if (start && !moved && !longFired && event.type === "touchend") {
      click(pressPoint(start), LEFT);

      if (pointerMode()) lastTap = { at: Date.now(), point: start };
    }

    start = null;
  }

  const options = { capture: true, passive: false } as const;

  host.addEventListener("touchstart", onTouchStart, options);
  host.addEventListener("touchmove", onTouchMove, options);
  host.addEventListener("touchend", onTouchEnd, options);
  host.addEventListener("touchcancel", onTouchEnd, options);

  return () => {
    cancelLong();
    host.style.touchAction = previousTouchAction;
    host.removeEventListener("touchstart", onTouchStart, true);
    host.removeEventListener("touchmove", onTouchMove, true);
    host.removeEventListener("touchend", onTouchEnd, true);
    host.removeEventListener("touchcancel", onTouchEnd, true);
  };
}

// A mouse's back and forward buttons are the desktop's while the pointer is over it: the browser is
// kept from moving through its history, and the component still reads the press and the release.
export function holdHistoryButtons(host: HTMLElement): () => void {
  const hold = (event: MouseEvent): void => {
    if (event.button === 3 || event.button === 4) event.preventDefault();
  };
  const types = ["mousedown", "mouseup", "auxclick", "pointerup"] as const;

  for (const type of types) host.addEventListener(type, hold as EventListener, true);

  return () => {
    for (const type of types) host.removeEventListener(type, hold as EventListener, true);
  };
}

// What floats over the page and holds focus while it is open: the component library's popovers,
// menus and select lists, and dialogs.
const FLOATING = '[data-reka-popper-content-wrapper], [role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]';

// The component takes focus the moment the mouse comes over it, so it can take the keys. A pointer
// on its way into something floating over the desktop crosses the desktop, and focus taken there
// closes that thing as focus leaving it. So while focus stands in something floating, the mouse
// coming over the desktop does not reach the component; a press on it still does. The mouse coming
// over an element does not leave the shadow root it happens in, so this stands in the component's.
export function holdHoverFocus(root: ShadowRoot): () => void {
  const hold = (event: Event): void => {
    const focused = document.activeElement;

    if (focused instanceof Element && focused.closest(FLOATING) !== null) event.stopPropagation();
  };

  root.addEventListener("mouseenter", hold, true);

  return () => root.removeEventListener("mouseenter", hold, true);
}

export interface DesktopKeyboard {
  // Raises the phone's keyboard: focus in the box, given again where the box kept it with the keyboard
  // down. Returns whether the box has focus.
  show: () => boolean;
  // Takes focus out of the box, so the phone's keyboard goes down.
  hide: () => void;
  isOpen: () => boolean;
  // The caret on the desktop may have moved: the line being written is over.
  endLine: () => void;
  detach: () => void;
}

// Where what the box types goes: typed characters, and a key or chord pressed a number of times,
// named by its physical code with its modifiers joined in front by `+` (docs/remote.md, 「The on-screen
// keyboard」).
export interface DesktopTyping {
  text: (text: string) => void;
  key: (name: string, count?: number) => void;
}

// What a 12-key keyboard (천지인) spells a syllable with on its way, as ranges of characters: the dots
// of an unfinished vowel, conjoining jamo no syllable took up, and the old compatibility jamo, ㆍ
// among them. No key of the desktop types them, so the desktop drops them (docs/remote.md, 「The
// on-screen keyboard」).
// The last range begins at the Hangul filler, which draws nothing.
const UNFINISHED = /[·‥ᄀ-ᇿㅤ-ㆎ]/u;

// What the desktop holds of a line the box holds: the box's text, its Hangul composed, without what
// no key of the desktop types.
function desktopLine(value: string): string {
  return [...value.normalize("NFC")]
    .filter((character) => !UNFINISHED.test(character))
    .join("");
}

// The browser's own handle on the phone's keyboard (the VirtualKeyboard API), where it has one.
interface VirtualKeyboard extends EventTarget {
  overlaysContent: boolean;
  readonly boundingRect: DOMRect;
}

function virtualKeyboard(): VirtualKeyboard | null {
  return (navigator as Navigator & { virtualKeyboard?: VirtualKeyboard }).virtualKeyboard ?? null;
}

// The least a phone's keyboard takes off the visual viewport (px), so a browser bar coming and going is
// not taken for one.
export const KEYBOARD_LEAST_PX = 120;

// The keys the box sends as keys, by the browser's name, with the physical code each is sent by.
// Every one but the deletions ends the line.
export const DESKTOP_KEYS: readonly { key: string; code: string }[] = [
  { key: "Enter", code: "Enter" },
  { key: "Backspace", code: "Backspace" },
  { key: "Delete", code: "Delete" },
  { key: "Tab", code: "Tab" },
  { key: "Escape", code: "Escape" },
  { key: "ArrowLeft", code: "ArrowLeft" },
  { key: "ArrowRight", code: "ArrowRight" },
  { key: "ArrowUp", code: "ArrowUp" },
  { key: "ArrowDown", code: "ArrowDown" },
  { key: "Home", code: "Home" },
  { key: "End", code: "End" },
  { key: "PageUp", code: "PageUp" },
  { key: "PageDown", code: "PageDown" }
];

const DELETIONS = new Set(["Backspace", "Delete"]);
const LINE_BREAKS = new Set(["insertLineBreak", "insertParagraph"]);
// The key code a browser reports for a key the IME took.
const IME_KEY_CODE = 229;

// A chord's name: its modifiers, then the key's physical code.
function chordName(event: KeyboardEvent, code: string): string {
  const modifiers = [event.ctrlKey && "ctrl", event.altKey && "alt", event.shiftKey && "shift", event.metaKey && "meta"].filter(Boolean);

  return [...modifiers, code].join("+");
}

// The physical code of a letter or digit key, read from the character it typed: a phone's keyboard
// reports no code of its own.
function characterCode(character: string): string {
  return /^[0-9]$/.test(character) ? `Digit${character}` : `Key${character.toUpperCase()}`;
}

// A text box standing inside the component, whose line is mirrored on the desktop.
//
// It stands in the component's shadow root because the component takes keys only while focus is
// inside it. What the box holds is what was typed on the desktop since it was last emptied, less what
// no key of the desktop types: every change of the box — a syllable still being composed included —
// takes back with Backspace what no longer matches and types the rest. None of the box's own key
// events reach the component, which would otherwise type them a second time.
export function attachDesktopKeyboard(
  root: ShadowRoot,
  options: { label: string; typing: () => DesktopTyping; focused: (on: boolean) => void }
): DesktopKeyboard {
  const box = document.createElement("textarea");

  box.setAttribute("autocapitalize", "off");
  box.setAttribute("autocomplete", "off");
  box.setAttribute("autocorrect", "off");
  box.setAttribute("spellcheck", "false");
  box.setAttribute("aria-label", options.label);
  Object.assign(box.style, {
    position: "absolute",
    left: "0",
    bottom: "0",
    width: "1px",
    height: "1px",
    opacity: "0",
    border: "0",
    padding: "0",
    resize: "none"
  });
  root.append(box);

  // What the desktop holds of the line being written.
  let sent = "";
  let composing = false;
  // The line ended while a composition could still be alive; the box is emptied once it is not.
  let lineEnded = false;

  function mirror(): void {
    const value = desktopLine(box.value);
    const prefix = commonPrefixLength(sent, value);
    const taken = [...sent.slice(prefix)].length;
    const fresh = value.slice(prefix);

    sent = value;

    if (taken > 0) options.typing().key("Backspace", taken);
    if (fresh) options.typing().text(fresh);
  }

  // The phone's keyboard is laid over the page while the box has focus, so the desktop keeps its place
  // and its size; the view moves to show what it covers.
  function overlay(on: boolean): void {
    const keyboard = virtualKeyboard();

    if (keyboard) keyboard.overlaysContent = on;
  }

  // Empties the box, but never under a composition: a keyboard that has its text changed under it
  // loses the place its composition started.
  function endLine(): void {
    if (composing) {
      lineEnded = true;

      return;
    }

    lineEnded = false;
    box.value = "";
    sent = "";
  }

  function onInput(event: Event): void {
    const { inputType } = event as InputEvent;

    if (LINE_BREAKS.has(inputType)) {
      box.value = box.value.replace(/[\r\n]+$/, "");
      mirror();
      options.typing().key("Enter");
      endLine();

      return;
    }

    mirror();
  }

  function onCompositionStart(): void {
    composing = true;
  }

  function onCompositionEnd(): void {
    composing = false;
    mirror();

    if (lineEnded) endLine();
  }

  function onKeyDown(event: KeyboardEvent): void {
    event.stopPropagation();

    if (event.isComposing || event.keyCode === IME_KEY_CODE) return;

    const known = DESKTOP_KEYS.find((one) => one.key === event.key);
    const chord = event.ctrlKey || event.altKey || event.metaKey;

    if (known && DELETIONS.has(known.key) && !chord) {
      // A deletion in the box is carried by the change it makes; on an empty box there is none.
      if (box.value !== "") return;

      event.preventDefault();
      options.typing().key(known.code);

      return;
    }

    if (known) {
      event.preventDefault();
      mirror();
      options.typing().key(chordName(event, known.code));
      endLine();

      return;
    }

    if (chord && /^[A-Za-z0-9]$/.test(event.key)) {
      event.preventDefault();
      mirror();
      options.typing().key(chordName(event, characterCode(event.key)));
      endLine();
    }
  }

  function hold(event: Event): void {
    event.stopPropagation();
  }

  // Whether the phone's keyboard has come up for the box since it took focus, and the visual viewport's
  // height when it did. A phone that lowers its keyboard by its own key leaves focus in the box, which
  // would raise it again with the next touch, so the box lets go of focus once the keyboard has gone
  // down (docs/remote.md, 「The on-screen keyboard」).
  let raised = false;
  let viewportHeight = 0;

  function keyboardWent(up: boolean): void {
    if (up) raised = true;
    else if (raised) box.blur();
  }

  function onGeometry(): void {
    keyboardWent(virtualKeyboard()!.boundingRect.height > 0);
  }

  function onViewport(): void {
    keyboardWent(window.visualViewport!.height < viewportHeight - KEYBOARD_LEAST_PX);
  }

  function watchKeyboard(on: boolean): void {
    const keyboard = virtualKeyboard();
    const method = on ? "addEventListener" : "removeEventListener";

    raised = false;

    if (keyboard) keyboard[method]("geometrychange", onGeometry);
    else if (window.visualViewport) {
      viewportHeight = window.visualViewport.height;
      window.visualViewport[method]("resize", onViewport);
    }
  }

  function onFocus(): void {
    watchKeyboard(true);
    options.focused(true);
  }

  function onBlur(): void {
    watchKeyboard(false);
    overlay(false);
    composing = false;
    lineEnded = false;
    box.value = "";
    sent = "";
    options.focused(false);
  }

  // A press on the desktop may move its caret, so what the box holds is no longer that line.
  function onPress(event: Event): void {
    if (event.target !== box) endLine();
  }

  box.addEventListener("input", onInput);
  box.addEventListener("compositionstart", onCompositionStart);
  box.addEventListener("compositionend", onCompositionEnd);
  box.addEventListener("keydown", onKeyDown);
  box.addEventListener("keyup", hold);
  box.addEventListener("keypress", hold);
  box.addEventListener("focus", onFocus);
  box.addEventListener("blur", onBlur);
  root.addEventListener("mousedown", onPress, true);

  const isOpen = () => root.activeElement === box;

  return {
    show() {
      if (isOpen()) {
        if (raised) return true;

        box.blur();
      }

      overlay(true);
      box.focus({ preventScroll: true });

      if (!isOpen()) overlay(false);

      return isOpen();
    },
    hide() {
      if (isOpen()) box.blur();
    },
    isOpen,
    endLine,
    detach() {
      watchKeyboard(false);
      overlay(false);
      box.removeEventListener("input", onInput);
      box.removeEventListener("compositionstart", onCompositionStart);
      box.removeEventListener("compositionend", onCompositionEnd);
      box.removeEventListener("keydown", onKeyDown);
      box.removeEventListener("keyup", hold);
      box.removeEventListener("keypress", hold);
      box.removeEventListener("focus", onFocus);
      box.removeEventListener("blur", onBlur);
      root.removeEventListener("mousedown", onPress, true);
      box.remove();
    }
  };
}

// Typing through the component itself, in its Unicode mode, until the keys socket is ready: a
// character as a key press carrying it, and a key by the physical code it has. The desktop takes only
// the characters its keymap has, and a chord goes as its key alone.
export function componentTyping(): DesktopTyping {
  function press(key: string, code: string): void {
    window.dispatchEvent(new KeyboardEvent("keydown", { key, code, bubbles: true, cancelable: true }));
    window.dispatchEvent(new KeyboardEvent("keyup", { key, code, bubbles: true, cancelable: true }));
  }

  return {
    text(text) {
      for (const character of text) press(character, "");
    },
    key(name, count = 1) {
      const known = DESKTOP_KEYS.find((one) => one.code === name.split("+").at(-1));

      if (!known) return;

      for (let index = 0; index < count; index += 1) press(known.key, known.code);
    }
  };
}
