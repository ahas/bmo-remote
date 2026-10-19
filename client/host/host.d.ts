// What the host owes the screen, declared for the bundle's own typecheck alone (docs/api.md, "The console
// plugin bundle"). A host registers the three components by name and makes the function importable by name,
// as Nuxt makes a project's own composables; nothing here ships.

import type { DefineComponent } from "vue";

// What a screen keeps of its open tabs across visits: what it keeps, read fresh each time it changes, and
// how a kept value is put back, null where nothing was kept.
interface HostKeptTabs<S> {
  read: () => S;
  restore: (kept: unknown) => void;
}

declare module "vue" {
  export interface GlobalComponents {
    // The three pieces of the console's title bar, which take no props from the screen.
    DeployMark: DefineComponent<Record<string, never>>;
    TodoOpenButton: DefineComponent<Record<string, never>>;
    UsageMeters: DefineComponent<Record<string, never>>;
  }
}

declare global {
  // Keeps a screen's open tabs for the account under the screen's key.
  function useKeptTabs<S>(screen: string, kept: HostKeptTabs<S>): void;
}

export {};
