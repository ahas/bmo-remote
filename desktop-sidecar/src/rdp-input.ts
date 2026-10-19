// Input the relay types into the client's stream itself (docs/remote.md, 「The login screen」 and 「The
// on-screen keyboard」), as fast-path input PDUs (MS-RDPBCGR 2.2.8.1.2): a header byte carrying the
// number of events, the PDU's length, then the events.

const FASTPATH_INPUT_EVENT_SCANCODE = 0x0;
const FASTPATH_INPUT_EVENT_UNICODE = 0x4;
const FASTPATH_INPUT_KBDFLAGS_RELEASE = 0x01;
const FASTPATH_INPUT_KBDFLAGS_EXTENDED = 0x02;

// A key as RDP names it: its set-1 scancode, and whether it is one of the extended keys.
export interface Scancode {
  code: number;
  extended: boolean;
}

// One event, as its bytes within a PDU.
export type InputEvent = number[];

export function fastPathInput(events: InputEvent[]): Uint8Array {
  const body = events.flat();
  // One length byte where the PDU fits under 0x80, else two with the top bit set.
  const short = body.length + 2 < 0x80;
  const length = body.length + (short ? 2 : 3);
  const head = short ? [events.length << 2, length] : [events.length << 2, 0x80 | (length >> 8), length & 0xff];

  return new Uint8Array([...head, ...body]);
}

export function scancodeEvent(key: Scancode, release: boolean): InputEvent {
  const flags = (release ? FASTPATH_INPUT_KBDFLAGS_RELEASE : 0) | (key.extended ? FASTPATH_INPUT_KBDFLAGS_EXTENDED : 0);

  return [(FASTPATH_INPUT_EVENT_SCANCODE << 5) | flags, key.code];
}

export function unicodeEvent(unit: number, release: boolean): InputEvent {
  return [(FASTPATH_INPUT_EVENT_UNICODE << 5) | (release ? FASTPATH_INPUT_KBDFLAGS_RELEASE : 0), unit & 0xff, unit >> 8];
}

const key = (code: number, extended = false): Scancode => ({ code, extended });

// The modifiers a chord names, as the left-hand keys.
export const MODIFIER_KEYS = {
  ctrl: key(0x1d),
  alt: key(0x38),
  shift: key(0x2a),
  meta: key(0x5b, true)
} as const satisfies Record<string, Scancode>;

export type ModifierName = keyof typeof MODIFIER_KEYS;

// Each row of letters, with the scancode of its first key.
const LETTER_ROWS: readonly [string, number][] = [
  ["QWERTYUIOP", 0x10],
  ["ASDFGHJKL", 0x1e],
  ["ZXCVBNM", 0x2c]
];

// The keys the relay types, by the physical code a browser names them with (UI Events KeyboardEvent
// code values). The names are the browser's, so this is a table of an outside standard's keys.
export const KEY_CODES: ReadonlyMap<string, Scancode> = new Map<string, Scancode>([
  ...LETTER_ROWS.flatMap(([row, first]) => [...row].map((letter, at): [string, Scancode] => [`Key${letter}`, key(first + at)])),
  ...[..."1234567890"].map((digit, at): [string, Scancode] => [`Digit${digit}`, key(0x02 + at)]),
  ["Escape", key(0x01)],
  ["Backspace", key(0x0e)],
  ["Tab", key(0x0f)],
  ["Enter", key(0x1c)],
  ["Space", key(0x39)],
  ["Home", key(0x47, true)],
  ["ArrowUp", key(0x48, true)],
  ["PageUp", key(0x49, true)],
  ["ArrowLeft", key(0x4b, true)],
  ["ArrowRight", key(0x4d, true)],
  ["End", key(0x4f, true)],
  ["ArrowDown", key(0x50, true)],
  ["PageDown", key(0x51, true)],
  ["Delete", key(0x53, true)],
  ["AltRight", key(0x38, true)]
]);

// One key pressed and released with its modifiers held around it.
export function chordEvents(target: Scancode, modifiers: readonly ModifierName[] = []): InputEvent[] {
  const held = modifiers.map((name) => MODIFIER_KEYS[name]);

  return [
    ...held.map((one) => scancodeEvent(one, false)),
    scancodeEvent(target, false),
    scancodeEvent(target, true),
    ...held.toReversed().map((one) => scancodeEvent(one, true))
  ];
}

// A character as Unicode events, pressed and released, one pair per UTF-16 unit.
export function unicodeEvents(text: string): InputEvent[] {
  const events: InputEvent[] = [];

  for (let at = 0; at < text.length; at += 1) {
    const unit = text.charCodeAt(at);

    events.push(unicodeEvent(unit, false), unicodeEvent(unit, true));
  }

  return events;
}
