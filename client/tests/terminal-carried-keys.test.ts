// A key held when a terminal takes the keyboard is not the terminal's (docs/remote.md, 「Rules the interface
// keeps」): every event of it that reaches the terminal is dropped until it is released, and a key pressed after
// reaches the terminal as it always did. The page and the terminal's host are plain event targets here; a real
// browser's handing of the rest of a press to the newly focused terminal was measured by hand.
import { beforeAll, expect, test } from "bun:test";

function key(type: string, code: string): Event {
  return Object.assign(new Event(type, { bubbles: true, cancelable: true }), { code });
}

let attachCarriedKeys: typeof import("../app/domain/remote/terminal-carried-keys").attachCarriedKeys;
const page = new EventTarget();

beforeAll(async () => {
  Object.assign(globalThis, { document: page, window: new EventTarget() });
  ({ attachCarriedKeys } = await import("../app/domain/remote/terminal-carried-keys"));
});

// What the terminal inside the host is handed of each event: the host's own listener stands for it.
function terminalOn(host: EventTarget): string[] {
  const seen: string[] = [];

  for (const type of ["keydown", "keypress", "keyup"]) host.addEventListener(type, (event) => seen.push(`${type}:${(event as Event & { code: string }).code}`));

  return seen;
}

test("the Enter held as the terminal takes the keyboard never reaches it, and the next one does", () => {
  const host = new EventTarget();
  const carried = attachCarriedKeys(host as HTMLElement);
  const seen = terminalOn(host);

  // The Enter goes down on the page, the terminal takes the keyboard, and the rest of the press reaches it.
  page.dispatchEvent(key("keydown", "Enter"));
  carried.carry();
  const press = key("keypress", "Enter");

  host.dispatchEvent(press);
  host.dispatchEvent(key("keyup", "Enter"));
  page.dispatchEvent(key("keyup", "Enter"));

  expect(press.defaultPrevented).toBe(true);
  expect(seen).toEqual([]);

  // Pressed again in the terminal, it is the terminal's.
  page.dispatchEvent(key("keydown", "Enter"));
  host.dispatchEvent(key("keydown", "Enter"));
  host.dispatchEvent(key("keypress", "Enter"));

  expect(seen).toEqual(["keydown:Enter", "keypress:Enter"]);
  page.dispatchEvent(key("keyup", "Enter"));
  carried.detach();
});

test("with no key held, taking the keyboard carries nothing", () => {
  const host = new EventTarget();
  const carried = attachCarriedKeys(host as HTMLElement);
  const seen = terminalOn(host);

  carried.carry();
  host.dispatchEvent(key("keydown", "KeyA"));

  expect(seen).toEqual(["keydown:KeyA"]);
  carried.detach();
});
