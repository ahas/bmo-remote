// A picture pasted into the terminal (docs/remote.md, 「The terminal interface」): the first picture a paste holds is
// the one kept, a paste of words holds none, and the kept file's path is pasted as words.
import { expect, test } from "bun:test";

import { pastedPath, pastedPicture } from "../app/domain/remote/terminal-clipboard";

function held(kind: string, type: string, file: File | null = null) {
  return { kind, type, getAsFile: () => file };
}

test("the first picture a paste holds is the one kept", () => {
  const first = new File(["a"], "one.png", { type: "image/png" });
  const second = new File(["b"], "two.jpg", { type: "image/jpeg" });

  expect(pastedPicture([held("string", "text/plain"), held("file", "image/png", first), held("file", "image/jpeg", second)])).toBe(first);
});

test("a paste of words, of a file that is no picture, or of nothing holds none", () => {
  expect(pastedPicture([held("string", "text/plain"), held("string", "text/html")])).toBeNull();
  expect(pastedPicture([held("file", "application/pdf", new File(["a"], "a.pdf", { type: "application/pdf" }))])).toBeNull();
  expect(pastedPicture([held("string", "image/png")])).toBeNull();
  expect(pastedPicture([held("file", "image/png", null)])).toBeNull();
  expect(pastedPicture(null)).toBeNull();
  expect(pastedPicture(undefined)).toBeNull();
});

test("a kept file's path is pasted as words, quoted where it holds a blank", () => {
  expect(pastedPath("/data/pastes/t-abc/paste-1.png")).toBe("/data/pastes/t-abc/paste-1.png ");
  expect(pastedPath("/data/my pastes/paste-1.png")).toBe("'/data/my pastes/paste-1.png' ");
  expect(pastedPath("/data/it's here/paste 1.png")).toBe("'/data/it'\\''s here/paste 1.png' ");
});
