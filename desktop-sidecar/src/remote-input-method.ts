import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ModifierName } from "./rdp-input";

// The desktop session's input method, as the on-screen keyboard's typing needs it (docs/remote.md,
// 「The on-screen keyboard」): fcitx5, which composes Hangul from 두벌식 keys. What state it is in is
// asked of fcitx5 itself over the account's session bus; the key that turns it on and off, and the
// layout its Hangul engine reads keys by, are read from its configuration.

// "none" where no input context has focus or fcitx5 cannot be asked or reads another layout; "off"
// and "on" for the Hangul mode of the focused one.
export type InputMethodState = "none" | "off" | "on";

// A key the relay presses, by the browser's name for it, with the modifiers held around it.
export interface KeyChord {
  code: string;
  modifiers: ModifierName[];
}

export interface InputMethod {
  state: InputMethodState;
  // The key that switches the mode, where the configuration names one the relay can type.
  trigger: KeyChord | null;
}

// fcitx5's names for the keys and modifiers a trigger may be made of, as the relay can type them.
// The Hangul key is not among them: gnome-remote-desktop hands the session no Hangul keysym for its
// scancode, so fcitx5 never sees it pressed.
const FCITX_KEYS: Record<string, string> = { Alt_R: "AltRight", space: "Space" };
const FCITX_MODIFIERS: Record<string, ModifierName> = { Control: "ctrl", Alt: "alt", Shift: "shift", Super: "meta" };
// fcitx5's own trigger keys where its configuration names none.
const DEFAULT_TRIGGERS = ["Control+space"];
// The layout the relay types Hangul in, and fcitx5-hangul's name for it; the engine reads it where
// its configuration names none.
const DUBEOLSIK = "Dubeolsik";

// One trigger as fcitx5 writes it — modifiers and a key joined by `+` — or null where the relay
// cannot type it.
export function readTrigger(spec: string): KeyChord | null {
  const parts = spec.split("+");
  const code = FCITX_KEYS[parts.at(-1) ?? ""];
  const modifiers = parts.slice(0, -1).map((part) => FCITX_MODIFIERS[part]);

  if (!code || modifiers.some((one) => one === undefined)) return null;

  return { code, modifiers: modifiers as ModifierName[] };
}

// The values of one section of an fcitx5 configuration file, in the order they stand.
function sectionValues(text: string, section: string): string[] {
  const values: string[] = [];
  let inside = false;

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    const header = /^\[(.+)\]$/.exec(trimmed);

    if (header) {
      inside = header[1] === section;
      continue;
    }

    const entry = inside && !trimmed.startsWith("#") ? /^[^=]+=(.*)$/.exec(trimmed) : null;

    if (entry) values.push(entry[1]!);
  }

  return values;
}

// The first trigger key the configuration names that the relay can type.
export function triggerOf(config: string | null): KeyChord | null {
  const named = config === null ? [] : sectionValues(config, "Hotkey/TriggerKeys");

  for (const spec of named.length > 0 ? named : DEFAULT_TRIGGERS) {
    const chord = readTrigger(spec);

    if (chord) return chord;
  }

  return null;
}

// Whether the Hangul engine reads keys by 두벌식.
export function readsDubeolsik(config: string | null): boolean {
  const layout = config === null ? null : /^Keyboard=(.*)$/m.exec(config)?.[1]?.trim();

  return (layout ?? DUBEOLSIK) === DUBEOLSIK;
}

// What `fcitx5-remote` prints for the focused input context: 0 where none has focus, 1 inactive, 2 active.
export function stateOf(answer: string | null): InputMethodState {
  const code = answer?.trim();

  return code === "2" ? "on" : code === "1" ? "off" : "none";
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

// The account's session bus, where its desktop session's services answer.
export function sessionBus(): string {
  const runtime = process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.() ?? 0}`;

  return process.env.DBUS_SESSION_BUS_ADDRESS ?? `unix:path=${runtime}/bus`;
}

// Asks fcitx5 over the session bus and waits for its answer; null where it could not be asked.
async function askFcitx(): Promise<string | null> {
  try {
    const child = Bun.spawn(["fcitx5-remote"], {
      env: { ...process.env, DBUS_SESSION_BUS_ADDRESS: sessionBus() },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore"
    });
    const [answer, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);

    return code === 0 ? answer : null;
  } catch {
    return null;
  }
}

export async function readInputMethod(): Promise<InputMethod> {
  const root = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "fcitx5");
  const trigger = triggerOf(readText(join(root, "config")));

  if (trigger === null || !readsDubeolsik(readText(join(root, "conf", "hangul.conf")))) return { state: "none", trigger };

  return { state: stateOf(await askFcitx()), trigger };
}
