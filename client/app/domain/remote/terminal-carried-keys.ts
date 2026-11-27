// A key the person was already holding when a terminal took the keyboard is not the terminal's
// (docs/remote.md, 「Rules the interface keeps」). The Enter that opened a terminal — from a list, a search, a
// link — is still going down when the terminal is mounted and takes focus, and the browser hands the rest of
// that press to the terminal, which would send it to the session as a keystroke of its own. So the keys held at
// the moment the terminal takes the keyboard are carried keys: every event of theirs that reaches the terminal is
// dropped, until each is released.

// The keys held down anywhere on the page, by their physical code.
const held = new Set<string>();
let tracking = false;

function track(): void {
  if (tracking || typeof document === "undefined") return;

  tracking = true;
  document.addEventListener("keydown", (event) => held.add(event.code), true);
  document.addEventListener("keyup", (event) => held.delete(event.code), true);
  // A key released while the page did not have the window is never seen going up.
  window.addEventListener("blur", () => held.clear());
}

const KEY_EVENTS = ["keydown", "keypress", "keyup"] as const;

export interface CarriedKeys {
  // The keys held right now become carried, for the terminal about to take the keyboard.
  carry: () => void;
  detach: () => void;
}

// Guards one terminal's host: its own key listeners stand inside the host, so a capture listener on the host
// meets every key event first.
export function attachCarriedKeys(host: HTMLElement): CarriedKeys {
  track();

  const carried = new Set<string>();
  const guard = (event: Event) => {
    const { code, type } = event as KeyboardEvent;

    if (!carried.has(code)) return;

    event.preventDefault();
    event.stopImmediatePropagation();
    if (type === "keyup") carried.delete(code);
  };

  for (const type of KEY_EVENTS) host.addEventListener(type, guard, true);

  return {
    carry: () => {
      carried.clear();
      for (const code of held) carried.add(code);
    },
    detach: () => {
      for (const type of KEY_EVENTS) host.removeEventListener(type, guard, true);
    }
  };
}
