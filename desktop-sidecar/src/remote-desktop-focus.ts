import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { createInterface } from "node:readline";

import { sessionBus } from "./remote-input-method";

// Whether a text field on the desktop holds focus, as the desktop session itself says (docs/remote.md,
// 「A text field taking focus」). The focus watcher runs in the account's session while anybody
// listens, and each answer it settles on goes to every listener.

export type FocusListener = (editable: boolean) => void;

// Starts the watcher, handing each line it writes to `line` and its end to `ended`; returns what stops it.
export type StartWatcher = (line: (text: string) => void, ended: () => void) => () => void;

// The watcher lives beside the console in whichever tree runs it; the console always runs with its
// own directory as the working directory.
export function focusWatcherPath(): string {
  return resolve(process.cwd(), "remote", "desktop-focus.py");
}

// One line of the watcher's, or null where it says nothing the page reads.
export function readFocusLine(text: string): boolean | null {
  try {
    const message = JSON.parse(text) as { focus?: unknown } | null;

    return typeof message?.focus === "boolean" ? message.focus : null;
  } catch {
    return null;
  }
}

// The watcher as a child of the console: its standard input stays open for as long as it is wanted, and
// closing it, or the console going, ends it.
export const startFocusWatcher: StartWatcher = (line, ended) => {
  const child = spawn("python3", ["-I", focusWatcherPath()], {
    env: { ...process.env, DBUS_SESSION_BUS_ADDRESS: sessionBus() },
    stdio: ["pipe", "pipe", "ignore"]
  });

  createInterface({ input: child.stdout }).on("line", line);
  child.on("error", ended);
  child.on("exit", ended);

  return () => {
    child.stdin.end();
    child.kill();
  };
};

export function createFocusSource(start: StartWatcher = startFocusWatcher) {
  const listeners = new Set<FocusListener>();
  // The running watcher, where one runs.
  let running: { stop: () => void } | null = null;

  function hand(text: string): void {
    const editable = readFocusLine(text);

    if (editable !== null) for (const listener of listeners) listener(editable);
  }

  function ensureRunning(): void {
    if (running !== null) return;

    const run = { stop: () => {}, ended: false };

    run.stop = start(hand, () => {
      run.ended = true;
      if (running === run) running = null;
    });
    running = run.ended ? null : run;
  }

  return {
    // Listens until what it returns is called; a watcher that is not running is started.
    subscribe(listener: FocusListener): () => void {
      listeners.add(listener);
      ensureRunning();

      return () => {
        listeners.delete(listener);

        if (listeners.size > 0 || running === null) return;

        const stopping = running;

        running = null;
        stopping.stop();
      };
    }
  };
}
