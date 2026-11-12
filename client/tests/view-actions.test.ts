// Where what is done with the shown view stands (docs/screen.md, 「The view's menu」): in the page the view's menu
// offers the whole-window view and a window of its own; in the whole-window view the way back out of it stands at
// its row's left end and the menu no longer offers it.
import { expect, test } from "bun:test";

import { viewActions } from "../app/domain/remote/view-actions";

// The pack's words as their keys, so a test reads which words were chosen.
const t = (key: string) => key;

function standIn() {
  const seen = { full: [] as boolean[], windows: 0 };
  const on = { setFull: (full: boolean) => seen.full.push(full), openWindow: () => (seen.windows += 1) };

  return { seen, on };
}

test("in the page the menu offers the whole window and a window of its own, with no way back", () => {
  const { seen, on } = standIn();
  const actions = viewActions(t, false, on);

  expect(actions.menu.map((one) => one.label)).toEqual(["remote.action.fullscreen", "remote.action.open_window"]);
  expect(actions.back).toBeNull();

  actions.menu[0]!.onSelect();
  actions.menu[1]!.onSelect();
  expect(seen).toEqual({ full: [true], windows: 1 });
});

test("in the whole-window view the way back stands apart from the menu and leaves the view", () => {
  const { seen, on } = standIn();
  const actions = viewActions(t, true, on);

  expect(actions.menu.map((one) => one.label)).toEqual(["remote.action.open_window"]);
  expect(actions.back?.label).toBe("remote.action.exit_fullscreen");

  actions.back!.onSelect();
  expect(seen.full).toEqual([false]);
});
