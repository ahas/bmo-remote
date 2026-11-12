// What the screen's pages take by name and no console gives them (docs/api.md, "The console plugin bundle"): a
// console loading the module registers nothing for it, so the module stands these in itself.
import { onMounted, watch } from "vue";

// What a screen keeps of its open tabs across visits: what it keeps, read fresh each time it changes, and
// how a kept value is put back, null where nothing was kept.
interface KeptTabs<S> {
  read: () => S;
  restore: (kept: unknown) => void;
}

// The prefix of the browser's storage key the module keeps a screen's tabs under.
const KEPT_TABS = "bmo-remote:kept-tabs:";

function keptValue(key: string): unknown {
  try {
    const kept = localStorage.getItem(key);

    return kept === null ? null : (JSON.parse(kept) as unknown);
  } catch {
    return null;
  }
}

// Keeps a screen's open tabs in this browser under the screen's key. Nothing is written before the kept tabs
// have been put back, or the first draw would overwrite them.
export function useKeptTabs<S>(screen: string, kept: KeptTabs<S>): void {
  const key = `${KEPT_TABS}${screen}`;
  let restored = false;
  const keep = (value: S): void => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // A browser that keeps nothing leaves the tabs to the session list, which is all a failure costs.
    }
  };

  onMounted(() => {
    kept.restore(keptValue(key));
    restored = true;
    keep(kept.read());
  });

  watch(
    kept.read,
    (next) => {
      if (restored) keep(next);
    },
    { deep: true }
  );
}

// A page's layout stands on its route's meta in the module's routes; the pages' own hint has nothing to do.
export function definePageMeta(_meta: Record<string, unknown>): void {}
