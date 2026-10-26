// TEMPORARY PROBE: what the page's input path receives, sent to the server as control frames of type
// `probe`, which the server's own probe writes to its journal and otherwise ignores. Nothing typed is
// carried: control bytes as hex, escape sequences as they are, and every other run as its length.
// What the page saw last before it went away is kept in the tab's session storage and sent by the
// page after it, so a reload shows both sides.

const KEPT = "bmo-remote-probe";
const LOAD = Math.random().toString(16).slice(2, 8);

interface Note {
  at: number;
  load: string;
  tag: string;
  detail: string;
}

const waiting: Note[] = [];
const seen: Note[] = [];
let sendNow: ((note: Note) => boolean) | null = null;

export function probeShape(data: string): string {
  let shape = "";
  let run = 0;
  const flush = () => {
    if (run > 0) shape += `[${run}]`;
    run = 0;
  };

  for (let index = 0; index < data.length; index += 1) {
    const code = data.charCodeAt(index);

    if (code === 0x1b && data[index + 1] === "[") {
      flush();
      let end = index + 2;

      while (end < data.length && !/[\x40-\x7e]/.test(data[end]!)) end += 1;

      shape += `ESC${data.slice(index + 1, end + 1)}`;
      index = end;
    } else if (code < 0x20 || code === 0x7f) {
      flush();
      shape += `<${code.toString(16).padStart(2, "0")}>`;
    } else {
      run += 1;
    }
  }

  flush();

  return shape;
}

export function probeNote(tag: string, detail = ""): void {
  const note = { at: Date.now(), load: LOAD, tag, detail };

  seen.push(note);
  if (seen.length > 40) seen.shift();

  if (!sendNow?.(note)) waiting.push(note);
}

// The socket the notes go out on, once it answers `ready`. Notes made before wait for it.
export function probeThrough(send: ((note: Note) => boolean) | null): void {
  sendNow = send;
  if (!send) return;

  while (waiting.length > 0 && send(waiting[0]!)) waiting.shift();
}

let started = false;

export function startProbe(): void {
  if (started) return;
  started = true;

  try {
    const before = sessionStorage.getItem(KEPT);

    sessionStorage.removeItem(KEPT);

    for (const note of before ? (JSON.parse(before) as Note[]) : []) {
      probeNote(`before:${note.tag}`, `${note.load} ${note.at} ${note.detail}`);
    }
  } catch {
    // No storage: the page before is not shown.
  }

  const navigation = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;

  probeNote("load", `${navigation?.type ?? "?"} discarded=${String((document as { wasDiscarded?: boolean }).wasDiscarded ?? "?")}`);

  const keep = (tag: string) => () => {
    probeNote(tag, document.visibilityState);

    try {
      sessionStorage.setItem(KEPT, JSON.stringify(seen.slice(-25)));
    } catch {
      // No storage.
    }
  };

  addEventListener("pagehide", keep("pagehide"));
  addEventListener("beforeunload", keep("beforeunload"));
  document.addEventListener("visibilitychange", keep("visibility"));
}

function keyName(event: KeyboardEvent): string {
  return event.key.length === 1 ? "char" : event.key;
}

// The keyboard's own board: what it holds when the terminal opens and what each event does to it.
export function probeTextarea(textarea: HTMLTextAreaElement | undefined): () => void {
  if (!textarea) return () => {};

  probeNote("textarea", `value=${probeShape(textarea.value)} focused=${String(document.activeElement === textarea)}`);

  const listeners: [string, (event: Event) => void][] = [
    ["keydown", (event) => {
      const key = event as KeyboardEvent;
      probeNote("keydown", `${keyName(key)} code=${key.code} keyCode=${key.keyCode} composing=${String(key.isComposing)} repeat=${String(key.repeat)}`);
    }],
    ["keyup", (event) => {
      const key = event as KeyboardEvent;
      if (key.key === "Enter" || key.keyCode === 13) probeNote("keyup", `${keyName(key)} keyCode=${key.keyCode}`);
    }],
    ["beforeinput", (event) => {
      const input = event as InputEvent;
      probeNote("beforeinput", `${input.inputType} data=${probeShape(input.data ?? "")} composing=${String(input.isComposing)}`);
    }],
    ["input", (event) => {
      const input = event as InputEvent;
      probeNote("input", `${input.inputType} data=${probeShape(input.data ?? "")} value=${probeShape(textarea.value)}`);
    }],
    ["compositionstart", () => probeNote("compositionstart", `value=${probeShape(textarea.value)}`)],
    ["compositionend", (event) => probeNote("compositionend", `data=${probeShape((event as CompositionEvent).data ?? "")}`)],
    ["focus", () => probeNote("focus", `value=${probeShape(textarea.value)}`)],
    ["blur", () => probeNote("blur")]
  ];

  // Heard on the window before anything below can stop the event: the IME takes some at the host.
  const heard = listeners.map(([type, listener]) => {
    const only = (event: Event) => {
      if (event.target === textarea) listener(event);
    };

    addEventListener(type, only, true);

    return () => removeEventListener(type, only, true);
  });

  return () => {
    for (const forget of heard) forget();
  };
}
