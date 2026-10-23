// A desktop that does not answer (docs/remote.md, 「A desktop that does not answer」), held against a stand-in
// desktop on a stand-in clock: it does not answer until it wakes, each try taking the time a relay's dial
// takes, and the page's waits move the clock instead of the browser's timers.
import { describe, expect, test } from "bun:test";

import { FIRST_WAIT_MS, LONGEST_WAIT_MS, keepTrying, retryable, wakePolicy } from "../app/domain/remote/desktop-wake";

import type { WakeClock, WakeProgress } from "../app/domain/remote/desktop-wake";

// What IronRDP rejects a connection with, by its error kind and the relay's RDCleanPath details.
function ironError(kind: number, details?: { httpStatusCode?: number; wsaErrorCode?: number }) {
  return { kind: () => kind, rdcleanpathDetails: () => details, backtrace: () => "" };
}

const TIMED_OUT = ironError(4, { wsaErrorCode: 10060 });
const REFUSED_CREDENTIALS = ironError(4, { httpStatusCode: 401 });
const WRONG_PASSWORD = ironError(1);

// A clock the waits move, which keeps every wait and what the page said during it.
function standInClock(letGo: (progress: WakeProgress) => boolean = () => false) {
  let now = 0;
  const waits: number[] = [];
  const said: WakeProgress[] = [];
  const clock: WakeClock = {
    now: () => now,
    wait: async (ms, progress) => {
      waits.push(ms);
      said.push(progress);
      now += ms;

      return !letGo(progress);
    }
  };

  return { clock, waits, said, advance: (ms: number) => (now += ms), now: () => now };
}

// A desktop that answers once the clock reaches `wakesAt`, never where it is null; each try takes `dialMs`.
function standInDesktop(at: ReturnType<typeof standInClock>, wakesAt: number | null, dialMs: number, failure: unknown = TIMED_OUT) {
  let tries = 0;

  return {
    tries: () => tries,
    dial: async () => {
      tries += 1;
      at.advance(dialMs);

      if (wakesAt === null || at.now() < wakesAt) throw failure;

      return "session";
    }
  };
}

describe("a desktop that does not answer", () => {
  test("is reached by one press once it wakes, the waits doubling to the longest", async () => {
    const at = standInClock();
    const desktop = standInDesktop(at, 20_000, 500);
    const outcome = await keepTrying(desktop.dial, wakePolicy(90), at.clock);

    expect(outcome).toEqual({ kind: "connected", value: "session", tries: 5 });
    expect(desktop.tries()).toBe(6);
    expect(at.waits).toEqual([FIRST_WAIT_MS, 2000, 4000, LONGEST_WAIT_MS, LONGEST_WAIT_MS]);
    expect(at.now()).toBeLessThan(90_000);
  });

  test("whose word of a redirection was lost is reached by the next try, a second later", async () => {
    const at = standInClock();
    const desktop = standInDesktop(at, 1000, 300, ironError(0));
    const outcome = await keepTrying(desktop.dial, wakePolicy(90), at.clock);

    expect(outcome.kind).toBe("connected");
    expect(at.waits).toEqual([FIRST_WAIT_MS]);
  });

  test("that never answers fails once the window is spent, and no wait ends past it", async () => {
    const at = standInClock();
    const desktop = standInDesktop(at, null, 8000);
    const outcome = await keepTrying(desktop.dial, wakePolicy(90), at.clock);

    expect(outcome.kind).toBe("failed");
    expect(outcome.kind === "failed" && outcome.tries).toBeGreaterThan(0);
    expect(outcome.kind === "failed" && outcome.error).toBe(TIMED_OUT);

    let waited = 0;

    for (const [index, wait] of at.waits.entries()) {
      waited += wait;
      // Each wait ends inside the window, counting every try before it.
      expect(waited + (index + 1) * 8000).toBeLessThanOrEqual(90_000);
    }

    // The failure shows at most one try's length after the window.
    expect(at.now()).toBeGreaterThan(90_000 - LONGEST_WAIT_MS - 8000);
    expect(at.now()).toBeLessThanOrEqual(90_000 + 8000);
  });

  test("says the try it is on and the seconds passed of the window", async () => {
    const at = standInClock();
    const desktop = standInDesktop(at, 10_000, 1000);

    await keepTrying(desktop.dial, wakePolicy(90), at.clock);

    expect(at.said.map((one) => one.tries)).toEqual([1, 2, 3]);
    expect(at.said.map((one) => one.seconds)).toEqual([1, 3, 6]);
    expect(at.said.every((one) => one.window === 90)).toBe(true);
  });

  test("is let go of when the page no longer wants it", async () => {
    const at = standInClock((progress) => progress.tries === 2);
    const desktop = standInDesktop(at, null, 500);

    expect(await keepTrying(desktop.dial, wakePolicy(90), at.clock)).toEqual({ kind: "dropped" });
    expect(desktop.tries()).toBe(2);
  });

  test("with a window of 0 is tried once", async () => {
    const at = standInClock();
    const desktop = standInDesktop(at, null, 500);
    const outcome = await keepTrying(desktop.dial, wakePolicy(0), at.clock);

    expect(outcome).toEqual({ kind: "failed", error: TIMED_OUT, tries: 0 });
    expect(desktop.tries()).toBe(1);
  });
});

describe("a desktop that refuses", () => {
  for (const [name, failure] of [
    ["the relay's refused credentials", REFUSED_CREDENTIALS],
    ["a wrong password", WRONG_PASSWORD],
    ["a refused logon", ironError(2)],
    ["access denied", ironError(3)],
    ["a request the relay cannot read", ironError(4, { httpStatusCode: 400 })]
  ] as const) {
    test(`is not tried again: ${name}`, async () => {
      const at = standInClock();
      const desktop = standInDesktop(at, null, 500, failure);
      const outcome = await keepTrying(desktop.dial, wakePolicy(90), at.clock);

      expect(outcome).toEqual({ kind: "failed", error: failure, tries: 0 });
      expect(at.waits).toEqual([]);
    });
  }

  test("is told apart from one that did not answer", () => {
    expect(retryable(TIMED_OUT)).toBe(true);
    expect(retryable(ironError(4, { wsaErrorCode: 10061 }))).toBe(true);
    expect(retryable(ironError(5))).toBe(true);
    expect(retryable(ironError(6))).toBe(true);
    expect(retryable(new Error("socket closed"))).toBe(true);
    expect(retryable(REFUSED_CREDENTIALS)).toBe(false);
    expect(retryable(WRONG_PASSWORD)).toBe(false);
  });
});
