// What is done with the shown view, and where each stands (docs/screen.md, 「The view's menu」). The view's
// menu offers the whole-window view while the view stands in the page, and a window of its own always; in the
// whole-window view the way back out of it stands at the left end of its row and never in the menu.
import type { BarAction } from "bmo-ui/app/domain/tabs";

type Translate = (key: string) => string;

export interface ViewHandlers {
  setFull: (full: boolean) => void;
  openWindow: () => void;
}

export interface ViewActions {
  // What the view's menu offers first, above the view's own settings.
  menu: BarAction[];
  // The way back out of the whole-window view; none while the view stands in the page.
  back: BarAction | null;
}

export function viewActions(t: Translate, full: boolean, on: ViewHandlers): ViewActions {
  const ownWindow: BarAction = { id: "window", label: t("remote.action.open_window"), icon: "i-material-symbols-open-in-new", onSelect: on.openWindow };

  if (full) {
    return {
      menu: [ownWindow],
      back: { id: "back", label: t("remote.action.exit_fullscreen"), icon: "i-material-symbols-arrow-back", onSelect: () => on.setFull(false) }
    };
  }

  return {
    menu: [{ id: "full", label: t("remote.action.fullscreen"), icon: "i-material-symbols-fullscreen", onSelect: () => on.setFull(true) }, ownWindow],
    back: null
  };
}
