import { ref } from "vue";

import { refusalText } from "./refusals";

import type { TerminalSignal } from "./terminal-signals";
import type { Ref } from "vue";
import type { Translate } from "bmo-ui/shared/wording";

// The screen's reads of the session list (docs/screen.md, 「Tabs」): each read, what failed where one did, and the
// events that read it again. A read that fails leaves a line saying what failed; a terminal's connection answering
// `ready` after that reads the list again, as does one closed on a session the service no longer holds, and a read
// that succeeds clears the line. Nothing reads on a clock.

interface FetchFailure {
  status?: unknown;
  statusCode?: unknown;
  data?: unknown;
}

/** The words for a failed read of the list: the refusal's code, else the answer's status, else that nothing answered. */
export function listFailureText(t: Translate, error: unknown): string {
  const failure = (error ?? {}) as FetchFailure;
  const refused = refusalText(t, failure.data);

  if (refused !== null) return t("remote.error.terminals_refused", { reason: refused });

  const status = typeof failure.status === "number" ? failure.status : typeof failure.statusCode === "number" ? failure.statusCode : null;

  return status === null ? t("remote.error.terminals_unreached") : t("remote.error.terminals_status", { status: String(status) });
}

export interface SessionListReads {
  // What failed on the last read, or "" where it succeeded or none has failed.
  failure: Ref<string>;
  read: () => Promise<void>;
  // What a terminal's connection said of the service, handed over by the screen while it stands
  // (`onTerminalSignal`): a ready connection reads the list again where the last read failed, and a session the
  // service no longer holds always does.
  heard: (signal: TerminalSignal) => void;
}

/**
 * Reads the list with `fetchList` and hands each page to `apply`. A read asked while one is out follows it once, so
 * a burst of signals reads the list once more, not once each.
 */
export function sessionListReads<Page>(t: Translate, fetchList: () => Promise<Page>, apply: (page: Page) => void): SessionListReads {
  const failure = ref("");
  let reading: Promise<void> | null = null;
  let again = false;

  async function readOnce(): Promise<void> {
    do {
      again = false;

      try {
        apply(await fetchList());
        failure.value = "";
      } catch (error) {
        failure.value = listFailureText(t, error);
      }
    } while (again);
  }

  function read(): Promise<void> {
    if (reading !== null) {
      again = true;

      return reading;
    }

    reading = readOnce().finally(() => {
      reading = null;
    });

    return reading;
  }

  function heard(signal: TerminalSignal): void {
    if (signal === "gone" || failure.value !== "") void read();
  }

  return { failure, read, heard };
}
