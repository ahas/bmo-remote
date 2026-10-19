import type { Terminal } from "@xterm/xterm";

// Finger swipes on the remote terminal, turned into wheel steps (docs/remote.md, 「Rules the
// interface keeps」).
//
// A full-screen program — tmux, an editor, codex — puts the terminal on the alternate screen, where
// no past lines pile up; a phone has nothing to scroll there however far the finger goes. The past
// is the program's, and a wheel is how it is asked for. So a swipe becomes wheel events handed to
// the terminal, which already knows what to make of them: a mouse report when the program reads the
// mouse, arrow keys otherwise. The remote terminal always runs under tmux with mouse reporting on,
// so every swipe there is a wheel.

// Finger travel per wheel step, in rows. Measured, one step moves one row, so the row under the
// finger follows it.
const LINES_PER_NOTCH = 1;

// The row height to use while none can be measured, so a gesture never divides by zero.
const FALLBACK_ROW_PX = 17;

// Sideways travel past this is selecting text, not scrolling.
const HORIZONTAL_SLOP_PX = 24;

// Speed kept per 16 ms after the finger lifts, and the speed below which the glide stops (px/ms).
const FRICTION = 0.94;
const MIN_SPEED = 0.04;

// How far back the lift speed is measured (ms); longer would mix in the slow start of a swipe.
const SAMPLE_MS = 90;

export function attachTerminalTouchScroll(term: Terminal, host: HTMLElement): () => void {
  let tracking = false;
  let lastY = 0;
  let startX = 0;
  let startY = 0;
  let lastX = 0;
  let samples: { y: number; at: number }[] = [];
  let glideFrame: number | undefined;

  // The browser is told the whole gesture is ours. Otherwise it may read a drag as its own pan
  // before the first move arrives and take the pointer away — a cancel, and no swipe at all.
  const previousTouchAction = host.style.touchAction;

  host.style.touchAction = "none";

  // Finger travel per wheel step, measured from the rows as drawn, so a larger font scrolls alike.
  function stepPx(): number {
    const screen = host.querySelector<HTMLElement>(".xterm-screen");
    const rowPx = screen && term.rows > 0 ? screen.clientHeight / term.rows : 0;

    return (rowPx > 1 ? rowPx : FALLBACK_ROW_PX) * LINES_PER_NOTCH;
  }

  // A swipe is a wheel when there is nothing of the browser's to scroll: the alternate screen, or a
  // program reading the mouse (the terminal marks its element when one does). A plain shell keeps its
  // own scrollback, which the browser already scrolls.
  function shouldTranslate(): boolean {
    if (term.buffer.active.type === "alternate") return true;

    return host.querySelector(".xterm.enable-mouse-events") !== null;
  }

  function onTouchStart(event: TouchEvent): void {
    // Two fingers are zooming.
    if (event.touches.length !== 1) {
      tracking = false;
      return;
    }

    const touch = event.touches[0]!;

    stopGlide();

    tracking = true;
    lastY = touch.clientY;
    lastX = touch.clientX;
    startX = touch.clientX;
    startY = touch.clientY;
    samples = [{ y: touch.clientY, at: performance.now() }];
  }

  function onTouchMove(event: TouchEvent): void {
    if (!tracking || !shouldTranslate()) return;

    const touch = event.touches[0];

    if (!touch) return;

    if (
      Math.abs(touch.clientX - startX) > HORIZONTAL_SLOP_PX &&
      Math.abs(touch.clientX - startX) > Math.abs(touch.clientY - startY)
    ) {
      tracking = false;
      return;
    }

    lastX = touch.clientX;

    const now = performance.now();

    samples.push({ y: touch.clientY, at: now });
    samples = samples.filter((sample) => now - sample.at <= SAMPLE_MS);

    const step = stepPx();
    const moved = touch.clientY - lastY;
    const steps = Math.trunc(moved / step);

    if (steps === 0) return;

    // Only the consumed travel moves the reference; the remainder counts toward the next step.
    lastY += steps * step;

    // This gesture is a wheel: the page does not pan with it, and the terminal does not swallow it.
    if (event.cancelable) event.preventDefault();
    event.stopPropagation();

    emit(steps * step, touch.clientX, touch.clientY);
  }

  // Sends a wheel step where the finger is, since a mouse report needs a cell to report.
  //
  // It is dispatched on what lies under the finger so the report names that cell. A finger that has
  // run off the terminal — a fast swipe past its edge, a bar laid over it — is over something that is
  // not the terminal's, and a wheel sent there never reaches the terminal at all; that step then goes
  // to the terminal's own screen instead.
  function emit(movedPx: number, x: number, y: number): void {
    const under = document.elementFromPoint(x, y);
    const target =
      under && host.contains(under) ? under : (host.querySelector<HTMLElement>(".xterm-screen") ?? host);

    // Fingers going up go back in time; the wheel's sign is the opposite.
    target.dispatchEvent(
      new WheelEvent("wheel", {
        deltaY: -movedPx,
        deltaMode: 0,
        clientX: x,
        clientY: y,
        bubbles: true,
        cancelable: true
      })
    );
  }

  function stopGlide(): void {
    if (glideFrame === undefined) return;

    cancelAnimationFrame(glideFrame);
    glideFrame = undefined;
  }

  // Keeps scrolling after the finger lifts, slowing by friction, one wheel step per row passed.
  function glide(speed: number): void {
    const step = stepPx();
    let carried = 0;
    let previous = performance.now();

    const tick = (now: number): void => {
      // A frame after a pause would carry a long gap; it is cut so no page jumps in one frame.
      const elapsed = Math.min(now - previous, 64);

      previous = now;
      speed *= FRICTION ** (elapsed / 16);

      if (Math.abs(speed) < MIN_SPEED) {
        glideFrame = undefined;
        return;
      }

      carried += speed * elapsed;

      const steps = Math.trunc(carried / step);

      if (steps !== 0) {
        carried -= steps * step;
        emit(steps * step, lastX, lastY);
      }

      glideFrame = requestAnimationFrame(tick);
    };

    glideFrame = requestAnimationFrame(tick);
  }

  function onTouchEnd(): void {
    if (!tracking) return;

    tracking = false;

    // The lift speed is read over the last stretch: a finger hesitates as it lifts.
    const oldest = samples[0];
    const newest = samples[samples.length - 1];

    samples = [];

    if (!oldest || !newest) return;

    const span = newest.at - oldest.at;

    if (span <= 0) return;

    const speed = (newest.y - oldest.y) / span;

    if (Math.abs(speed) < MIN_SPEED) return;

    glide(speed);
  }

  // The capture phase: the terminal stops propagation in its own touch handling, so on the
  // alternate screen nothing would reach a listener in the bubble phase. Not passive, since the
  // default is prevented.
  const options = { capture: true, passive: false } as const;

  host.addEventListener("touchstart", onTouchStart, options);
  host.addEventListener("touchmove", onTouchMove, options);
  host.addEventListener("touchend", onTouchEnd, options);
  host.addEventListener("touchcancel", onTouchEnd, options);

  return () => {
    stopGlide();

    host.style.touchAction = previousTouchAction;
    host.removeEventListener("touchstart", onTouchStart, true);
    host.removeEventListener("touchmove", onTouchMove, true);
    host.removeEventListener("touchend", onTouchEnd, true);
    host.removeEventListener("touchcancel", onTouchEnd, true);
  };
}
