// The screen's reads of the session list (docs/screen.md, 「Tabs」): a read that fails says what failed, and the
// next terminal connection that answers `ready` reads the list again and clears it. Nothing reads on a clock.
import { expect, test } from "bun:test";

import { listFailureText, sessionListReads } from "../app/domain/remote/session-list";
import { onTerminalSignal, signalTerminal } from "../app/domain/remote/terminal-signals";

// The pack's words as their keys and parameters, so a test reads which words were chosen.
const t = (key: string, params: Record<string, unknown> = {}) => (Object.keys(params).length === 0 ? key : `${key} ${JSON.stringify(params)}`);

// A list that fails as long as `failing` holds what it throws, and otherwise answers its page.
function standInList() {
  const stand = { failing: null as unknown, reads: 0, applied: [] as string[][] };
  const reads = sessionListReads(
    t,
    async () => {
      stand.reads += 1;

      if (stand.failing !== null) throw stand.failing;

      return ["s-1", "s-2"];
    },
    (page) => stand.applied.push(page)
  );
  // The screen hands the terminals' signals over while it stands.
  const stop = onTerminalSignal(reads.heard);

  return { stand, reads, stop };
}

const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

test("a failed read is cleared by the next ready socket", async () => {
  const { stand, reads, stop } = standInList();

  stand.failing = { statusCode: 502 };
  await reads.read();
  expect(reads.failure.value).toBe('remote.error.terminals_status {"status":"502"}');

  stand.failing = null;
  signalTerminal("ready");
  await settled();

  expect(reads.failure.value).toBe("");
  expect(stand.applied).toEqual([["s-1", "s-2"]]);
  expect(stand.reads).toBe(2);
  stop();
});

test("a ready socket reads nothing while the last read stood, and a session the service lost always reads", async () => {
  const { stand, reads, stop } = standInList();

  await reads.read();
  signalTerminal("ready");
  await settled();
  expect(stand.reads).toBe(1);

  signalTerminal("gone");
  await settled();
  expect(stand.reads).toBe(2);
  stop();

  signalTerminal("gone");
  await settled();
  expect(stand.reads).toBe(2);
});

test("a burst of signals while a read is out reads once more, not once each", async () => {
  const { stand, reads, stop } = standInList();

  stand.failing = new Error("down");
  await reads.read();
  stand.failing = null;
  for (let i = 0; i < 5; i += 1) signalTerminal("ready");
  await settled();
  await settled();

  expect(stand.reads).toBe(3);
  expect(reads.failure.value).toBe("");
  stop();
});

test("what failed is said by the refusal's code, else the answer's status, else that nothing answered", () => {
  expect(listFailureText(t, { status: 403, data: { code: "forbidden" } })).toBe(`remote.error.terminals_refused ${JSON.stringify({ reason: 'remote.error.forbidden {"reason":""}' })}`);
  expect(listFailureText(t, { status: 503, data: "<html>" })).toBe('remote.error.terminals_status {"status":"503"}');
  expect(listFailureText(t, new TypeError("fetch failed"))).toBe("remote.error.terminals_unreached");
});
