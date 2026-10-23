// A desktop that does not answer is tried again by the page itself, within a window the service's settings
// name (docs/remote.md, 「A desktop that does not answer」). The desktop is the machine the service runs on,
// so what wakes it is the next connection: the system daemon starts a login screen for each one afresh, and
// each carries the routing token the relay still holds. This module holds the rule alone, with its clock and
// its waiting handed in, so the hub drives it with the browser's and a test with a stand-in's.
import type { IronError } from "@devolutions/iron-remote-desktop";

// The first wait after a failure, and the longest any wait grows to by doubling (ms).
export const FIRST_WAIT_MS = 1000;
export const LONGEST_WAIT_MS = 8000;

// IronRDP's error kinds that say the desktop answered and refused: a wrong password, a refused logon,
// access denied.
const REFUSED_KINDS = new Set([1, 2, 3]);
// The relay's RDCleanPath error kind, and the HTTP statuses it answers a refusal with rather than a desktop
// that did not answer: a request it cannot read, and credentials the desktop refused.
const RDCLEANPATH_KIND = 4;
const REFUSED_STATUSES = new Set([400, 401]);

export interface WakePolicy {
  // How long, from the first try, a desktop that does not answer is tried again (ms).
  windowMs: number;
  firstWaitMs: number;
  longestWaitMs: number;
}

export function wakePolicy(windowSeconds: number): WakePolicy {
  return { windowMs: Math.max(0, windowSeconds) * 1000, firstWaitMs: FIRST_WAIT_MS, longestWaitMs: LONGEST_WAIT_MS };
}

// Whether a failed connection is one the desktop did not answer, which another try may reach, rather than
// one it refused.
export function retryable(error: unknown): boolean {
  const failure = error as Partial<IronError> | undefined;
  const kind = typeof failure?.kind === "function" ? failure.kind() : undefined;

  if (kind === undefined) return true;
  if (REFUSED_KINDS.has(kind)) return false;

  if (kind === RDCLEANPATH_KIND) {
    const status = typeof failure?.rdcleanpathDetails === "function" ? failure.rdcleanpathDetails()?.httpStatusCode : undefined;

    return status === undefined || !REFUSED_STATUSES.has(status);
  }

  return true;
}

// What the page says while it waits: the try it is on, and the seconds passed of the window.
export interface WakeProgress {
  tries: number;
  seconds: number;
  window: number;
}

export type WakeOutcome<T> =
  | { kind: "connected"; value: T; tries: number }
  // The last failure, and how many tries again came before it; tries above 0 means the window was spent.
  | { kind: "failed"; error: unknown; tries: number }
  // The waiting was ended from outside: the connection is no longer wanted.
  | { kind: "dropped" };

export interface WakeClock {
  now(): number;
  // Waits before the next try; resolves false where the connection is no longer wanted.
  wait(ms: number, progress: WakeProgress): Promise<boolean>;
}

// The wait before try `tries + 1`, or null where it would end past the window begun at `startedAt`.
export function nextWait(policy: WakePolicy, startedAt: number, tries: number, now: number): number | null {
  const wait = Math.min(policy.firstWaitMs * 2 ** tries, policy.longestWaitMs);

  return now - startedAt + wait > policy.windowMs ? null : wait;
}

export function wakeProgress(policy: WakePolicy, startedAt: number, tries: number, now: number): WakeProgress {
  return {
    tries,
    seconds: Math.min(Math.floor((now - startedAt) / 1000), Math.floor(policy.windowMs / 1000)),
    window: Math.floor(policy.windowMs / 1000)
  };
}

// Dials until the desktop answers, refuses, or the window is spent.
export async function keepTrying<T>(dial: () => Promise<T>, policy: WakePolicy, clock: WakeClock): Promise<WakeOutcome<T>> {
  const startedAt = clock.now();
  let tries = 0;

  for (;;) {
    try {
      return { kind: "connected", value: await dial(), tries };
    } catch (error) {
      const wait = retryable(error) ? nextWait(policy, startedAt, tries, clock.now()) : null;

      if (wait === null) return { kind: "failed", error, tries };

      tries += 1;

      if (!(await clock.wait(wait, wakeProgress(policy, startedAt, tries, clock.now())))) return { kind: "dropped" };
    }
  }
}
