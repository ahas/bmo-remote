// What the served module stands in for the screen's pages (module/host.ts), declared for the bundle's own
// typecheck, where the pages take it by name as Nuxt makes a project's own composables; nothing here ships.

// What a screen keeps of its open tabs across visits: what it keeps, read fresh each time it changes, and
// how a kept value is put back, null where nothing was kept.
interface HostKeptTabs<S> {
  read: () => S;
  restore: (kept: unknown) => void;
}

declare global {
  // Keeps a screen's open tabs in the browser under the screen's key.
  function useKeptTabs<S>(screen: string, kept: HostKeptTabs<S>): void;
}

export {};
