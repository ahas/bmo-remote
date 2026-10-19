// What the on-screen keyboard types, put into the connection's own stream (docs/remote.md, 「The
// on-screen keyboard」). A character other than Hangul goes as a Unicode event, which the server turns
// into a key where the session's keymap has one. Hangul goes as the 두벌식 keys that compose it, with
// the desktop's input method turned to Hangul around them by its own trigger key, typed in the same
// stream so the change lands in order with the keys.

import { hangulKeys } from "./rdp-hangul";
import { KEY_CODES, chordEvents, fastPathInput, unicodeEvents } from "./rdp-input";

import type { InputEvent, ModifierName } from "./rdp-input";
import type { InputMethod, KeyChord } from "./remote-input-method";

export type KeysMessage = { type: "text"; text: string } | { type: "key"; key: KeyChord; count: number };

// How much one message may type, so a page cannot hold the desktop typing for minutes.
const TEXT_MAX = 4096;
const REPEAT_MAX = 500;
// A key or a chord: modifiers joined in front of the key's physical code by `+`.
const CHORD = /^(?:(?:ctrl|alt|shift|meta)\+)*[A-Za-z0-9]{1,24}$/;

// A key or chord as the page names it, or null where it names a key the relay does not type.
export function readChord(name: string): KeyChord | null {
  if (!CHORD.test(name)) return null;

  const parts = name.split("+");
  const code = parts.at(-1)!;

  if (!KEY_CODES.has(code)) return null;

  return { code, modifiers: [...new Set(parts.slice(0, -1) as ModifierName[])] };
}

// A message from the page, or null where it is not one the keys socket takes.
export function readKeysMessage(text: string): KeysMessage | null {
  let value: unknown;

  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }

  const message = value as { type?: unknown; text?: unknown; key?: unknown; count?: unknown } | null;

  if (message?.type === "text" && typeof message.text === "string" && message.text !== "" && message.text.length <= TEXT_MAX) {
    return { type: "text", text: message.text };
  }

  if (message?.type === "key" && typeof message.key === "string") {
    const key = readChord(message.key);
    const count = message.count === undefined ? 1 : message.count;

    if (key === null || typeof count !== "number" || !Number.isInteger(count) || count < 1 || count > REPEAT_MAX) return null;

    return { type: "key", key, count };
  }

  return null;
}

function chord(key: KeyChord): InputEvent[] {
  return chordEvents(KEY_CODES.get(key.code)!, key.modifiers);
}

// One 두벌식 key, written as the Latin letter on it, upper-case where Shift is held.
function letterKey(letter: string): InputEvent[] {
  const target = KEY_CODES.get(`Key${letter.toUpperCase()}`)!;

  return letter === letter.toLowerCase() ? chordEvents(target) : chordEvents(target, ["shift"]);
}

// What a message types, stroke by stroke: each stroke is one key or character, pressed and released,
// and goes as one PDU. `toggled` says whether the input method's mode was changed on the way.
export interface Strokes {
  strokes: InputEvent[][];
  toggled: boolean;
}

// The strokes of a text. Hangul is typed with the mode on and everything else with it off; the text
// ends with the mode off, which commits what is being composed, and turned back on where it was on.
// A lone jamo is kept from joining the Hangul beside it by turning the mode off and on between them.
export function textStrokes(text: string, method: InputMethod): Strokes {
  const strokes: InputEvent[][] = [];

  if (method.state === "none" || method.trigger === null) {
    for (const character of text) strokes.push(unicodeEvents(character));

    return { strokes, toggled: false };
  }

  const toggle = chord(method.trigger);
  let on = method.state === "on";
  let toggled = false;
  // The Hangul just typed, which a jamo after it may still join: whether it was a lone jamo.
  let open: { lone: boolean } | null = null;

  function flip(): void {
    strokes.push(toggle);
    on = !on;
    toggled = true;
  }

  for (const character of text) {
    const hangul = hangulKeys(character);

    if (hangul === null) {
      if (on) flip();

      open = null;
      strokes.push(unicodeEvents(character));
      continue;
    }

    if (!on) flip();
    else if (open && (open.lone || hangul.lone)) {
      flip();
      flip();
    }

    for (const letter of hangul.keys) strokes.push(letterKey(letter));

    open = { lone: hangul.lone };
  }

  if (on && open !== null) flip();
  if (on !== (method.state === "on")) flip();

  return { strokes, toggled };
}

// The strokes of a key or chord pressed a number of times.
export function keyStrokes(key: KeyChord, count: number): Strokes {
  return { strokes: Array.from({ length: count }, () => chord(key)), toggled: false };
}

export interface TypistTiming {
  // Between two strokes, so the session reads each before the next (ms).
  keyMs: number;
  // After a message that changed the mode, before the next one asks the input method its state (ms).
  settleMs: number;
}

export const TYPIST_TIMING: TypistTiming = { keyMs: 8, settleMs: 150 };

export interface TypistDeps {
  // Puts one PDU into the client's stream at its next boundary.
  send: (pdu: Uint8Array) => void;
  inputMethod: () => Promise<InputMethod>;
  wait?: (ms: number) => Promise<void>;
  timing?: TypistTiming;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// One connection's typist: messages are typed one after another in the order they came, and nothing
// after it has been stopped.
export function createDesktopTypist(deps: TypistDeps) {
  const wait = deps.wait ?? sleep;
  const timing = deps.timing ?? TYPIST_TIMING;
  let queue = Promise.resolve();
  let stopped = false;

  async function run(message: KeysMessage): Promise<void> {
    const { strokes, toggled } = message.type === "key" ? keyStrokes(message.key, message.count) : textStrokes(message.text, await deps.inputMethod());

    for (const [index, stroke] of strokes.entries()) {
      if (stopped) return;
      if (index > 0) await wait(timing.keyMs);
      if (stopped) return;

      deps.send(fastPathInput(stroke));
    }

    if (toggled) await wait(timing.settleMs);
  }

  return {
    type(message: KeysMessage): Promise<void> {
      queue = queue.then(() => (stopped ? undefined : run(message))).catch(async () => undefined);

      return queue;
    },
    stop(): void {
      stopped = true;
    }
  };
}
