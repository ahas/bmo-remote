import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Nuxt } from "@nuxt/schema";

// The remote screen as a layer a console extends (docs/api.md, "The console plugin bundle"). It extends the
// bmo-ui layer and adds the screen's pages, components, domain modules, language pack and the terminal's own
// faces; the host brings its i18n module and the words every screen shares, the console's title-bar
// components and the kept tabs the screen asks of it, and hands the screen's routes and sockets on to the
// service.
const here = dirname(fileURLToPath(import.meta.url));

export default defineNuxtConfig({
  extends: ["bmo-ui"],
  css: [join(here, "app/assets/css/terminal-fonts.css")],
  modules: [
    // Where the bundle is the project being prepared it stands as the host does, one unprefixed locale by
    // default, ahead of the i18n module that reads it; a host extending the bundle keeps its own choice.
    (_options: unknown, nuxt: Nuxt) => {
      if (nuxt.options.rootDir === here) {
        nuxt.options.i18n = { ...nuxt.options.i18n, strategy: "no_prefix", defaultLocale: "ko" };
      }
    },
    "@nuxtjs/i18n",
    // What the host owes is declared under host/ for the bundle's own typecheck alone: where the bundle is
    // the project being prepared, those declarations are read with the screen; a host extending the bundle
    // reads none of them and keeps its own components' and functions' types.
    (_options: unknown, nuxt: Nuxt) => {
      if (nuxt.options.rootDir === here) {
        nuxt.hook("prepare:types", ({ tsConfig }) => {
          tsConfig.include = [...(tsConfig.include ?? []), "../host/**/*.d.ts"];
        });
      }
    }
  ],
  // The screen's own words, one file to a language under i18n/locales/, registered as the host registers its
  // own locales; the host's i18n module reads them as part of its locale of the same code, its own pack
  // standing where both hold a key.
  i18n: {
    locales: [
      { code: "ko", language: "ko-KR", file: "ko.yaml" },
      { code: "en", language: "en-US", file: "en.yaml" }
    ]
  },
  compatibilityDate: "2025-09-01",
  devtools: { enabled: false }
});
