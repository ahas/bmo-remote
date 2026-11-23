import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";

// The screen's language packs (docs/api.md, 「The console plugin bundle」): Korean, English, Japanese and
// Simplified Chinese, each holding every key the others hold, in the same order, each word carrying the
// placeholders the Korean one does.

const FOLDER = new URL("../i18n/", import.meta.url);
const LOCALES = ["en", "ja", "ko", "zh-CN"];

type Tree = { [key: string]: string | Tree };

function leaves(tree: Tree, prefix = ""): Map<string, string> {
  return new Map(
    Object.entries(tree).flatMap(([key, value]) =>
      typeof value === "string" ? [[`${prefix}${key}`, value] as const] : [...leaves(value, `${prefix}${key}.`)]
    )
  );
}

const packs = new Map(
  readdirSync(FOLDER)
    .filter((file) => file.endsWith(".json"))
    .map((file) => [file.slice(0, -".json".length), leaves(JSON.parse(readFileSync(new URL(file, FOLDER), "utf8")) as Tree)])
);

const placeholders = (word: string): string[] => [...word.matchAll(/\{(\w+)\}/g)].map((found) => found[1]!).sort();

test("the screen speaks Korean, English, Japanese and Simplified Chinese", () => {
  expect([...packs.keys()].sort()).toEqual(LOCALES);
});

test("every pack holds the same keys, in the same order, each a word", () => {
  const keys = [...packs.get("ko")!.keys()];

  for (const [locale, pack] of packs) {
    expect({ locale, keys: [...pack.keys()] }).toEqual({ locale, keys });
    for (const [key, word] of pack) expect({ locale, key, empty: word.trim() === "" }).toEqual({ locale, key, empty: false });
  }
});

test("every word carries the placeholders the Korean one does", () => {
  const korean = packs.get("ko")!;

  for (const [locale, pack] of packs) {
    for (const [key, word] of pack) {
      expect({ locale, key, placeholders: placeholders(word) }).toEqual({ locale, key, placeholders: placeholders(korean.get(key)!) });
    }
  }
});
