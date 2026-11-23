import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Nuxt } from "@nuxt/schema";

// The remote screen's sources as a Nuxt project on bmo-ui, which `nuxi prepare` and the typecheck read
// (docs/api.md, "The console plugin bundle"). A console loads none of it: it attaches the module
// module.config.ts builds from the same sources by the manifest the service answers.
const here = dirname(fileURLToPath(import.meta.url));

export default defineNuxtConfig({
  extends: ["bmo-ui"],
  css: [join(here, "app/assets/css/terminal-fonts.css")],
  modules: [
    "@nuxtjs/i18n",
    // What the served module stands in for the pages is declared under host/, and is read with the screen,
    // with the module's entry under module/ and its build.
    (_options: unknown, nuxt: Nuxt) => {
      nuxt.hook("prepare:types", ({ tsConfig, nodeTsConfig }) => {
        tsConfig.include = [...(tsConfig.include ?? []), "../host/**/*.d.ts", "../module/**/*"];
        nodeTsConfig.include = [...(nodeTsConfig.include ?? []), "../module.config.ts"];
      });
    }
  ],
  // The screen's own words, one JSON file to a language under i18n/, one unprefixed locale by default.
  i18n: {
    strategy: "no_prefix",
    defaultLocale: "ko",
    langDir: ".",
    locales: [
      { code: "ko", language: "ko-KR", file: "ko.json" },
      { code: "en", language: "en-US", file: "en.json" },
      { code: "ja", language: "ja-JP", file: "ja.json" },
      { code: "zh-CN", language: "zh-CN", file: "zh-CN.json" }
    ]
  },
  compatibilityDate: "2025-09-01",
  devtools: { enabled: false }
});
