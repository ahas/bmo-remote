// What a terminal's connection says of the service for the rest of the screen (docs/screen.md, 「Tabs」): `ready`
// when the service has answered a connection, and `gone` when it closed one because it holds no such session. The
// session list listens, so a list that could not be read is read again the moment the service is reached.

export type TerminalSignal = "ready" | "gone";

type Listener = (signal: TerminalSignal) => void;

const listeners = new Set<Listener>();

/** Listens to every terminal's signals until the returned function is called. */
export function onTerminalSignal(listener: Listener): () => void {
  listeners.add(listener);

  return () => {
    listeners.delete(listener);
  };
}

export function signalTerminal(signal: TerminalSignal): void {
  for (const listener of listeners) listener(signal);
}
