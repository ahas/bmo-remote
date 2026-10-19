import { moveTab, pinnedFirst } from "bmo-ui/app/domain/tabs";

// The remote screen's open tabs (docs/screen.md): which sessions stand on the bar, in
// what order, which are pinned and which one is shown. Every running terminal session stands as a
// tab; closing a terminal tab ends its session. The state is kept for the account on the server.

export const DESKTOP_TAB = "desktop";

const TERMINAL_ID = /^t-[a-z0-9]+$/;

export interface RemoteTabs {
  tabs: string[];
  active: string | null;
  pinned: string[];
}

export const NO_TABS: RemoteTabs = { tabs: [], active: null, pinned: [] };

export function isRemoteTab(id: unknown): id is string {
  return typeof id === "string" && (id === DESKTOP_TAB || TERMINAL_ID.test(id));
}

export function isTerminalTab(id: string): boolean {
  return id !== DESKTOP_TAB;
}

// A kept value is used only as far as it reads as tabs; anything else is dropped.
export function tidyTabs(value: unknown): RemoteTabs {
  if (!value || typeof value !== "object") return NO_TABS;

  const { tabs, active, pinned } = value as { tabs?: unknown; active?: unknown; pinned?: unknown };
  const listed = Array.isArray(tabs) ? [...new Set(tabs.filter(isRemoteTab))] : [];
  const held = Array.isArray(pinned) ? [...new Set(pinned.filter((id): id is string => isRemoteTab(id) && listed.includes(id)))] : [];

  return {
    tabs: pinnedFirst(listed, (id) => held.includes(id)),
    active: isRemoteTab(active) && listed.includes(active) ? active : (listed[0] ?? null),
    pinned: held
  };
}

// Opens a tab, or shows it where it is already open.
export function openTab(state: RemoteTabs, id: string): RemoteTabs {
  if (!isRemoteTab(id)) return state;

  return { ...state, tabs: state.tabs.includes(id) ? state.tabs : [...state.tabs, id], active: id };
}

export function showTab(state: RemoteTabs, id: string): RemoteTabs {
  return state.tabs.includes(id) ? { ...state, active: id } : state;
}

// Takes tabs off the bar. A closed tab that was shown hands over to the tab after it, or the one
// before it where it was last.
export function closeTabs(state: RemoteTabs, ids: readonly string[]): RemoteTabs {
  const tabs = state.tabs.filter((id) => !ids.includes(id));
  const pinned = state.pinned.filter((id) => !ids.includes(id));

  if (state.active === null || tabs.includes(state.active)) return { tabs, active: state.active, pinned };

  const at = state.tabs.indexOf(state.active);
  const after = state.tabs.slice(at + 1).find((id) => tabs.includes(id));
  const before = state.tabs.slice(0, at).reverse().find((id) => tabs.includes(id));

  return { tabs, active: after ?? before ?? null, pinned };
}

export function moveTabs(state: RemoteTabs, from: number, to: number): RemoteTabs {
  return { ...state, tabs: moveTab(state.tabs, from, to, (id) => state.pinned.includes(id)) };
}

// A tab pinned or let go: the pinned tabs stand together at the left end.
export function pinRemoteTab(state: RemoteTabs, id: string, on: boolean): RemoteTabs {
  if (!state.tabs.includes(id)) return state;

  const pinned = on ? [...state.pinned.filter((one) => one !== id), id] : state.pinned.filter((one) => one !== id);
  const held = state.tabs.filter((one) => pinned.includes(one));
  const tabs = on ? [...held.filter((one) => one !== id), id, ...state.tabs.filter((one) => !pinned.includes(one))] : [...held, id, ...state.tabs.filter((one) => !pinned.includes(one) && one !== id)];

  return { ...state, tabs, pinned };
}

// The bar made to match the running sessions: a terminal tab whose session is gone is dropped, and
// every running session without a tab gets one at the end, in the order the sessions began. The
// desktop tab stands on its own.
export function matchLiveSessions(state: RemoteTabs, live: readonly string[]): RemoteTabs {
  const gone = state.tabs.filter((id) => isTerminalTab(id) && !live.includes(id));
  const kept = gone.length ? closeTabs(state, gone) : state;
  const missing = live.filter((id) => isRemoteTab(id) && !kept.tabs.includes(id));

  if (missing.length === 0) return kept;

  return { ...kept, tabs: [...kept.tabs, ...missing], active: kept.active ?? missing[0] ?? null };
}
