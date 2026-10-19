import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Nuxt } from "@nuxt/schema";

// The remote screen as a layer a console extends (docs/api.md, "The console plugin bundle"). It extends the
// bmo-ui layer and adds the screen's pages, components, domain modules and the terminal's own faces; the
// host brings its i18n module and language pack, the console's title-bar components and the kept tabs the
// screen asks of it, and hands the screen's routes and sockets on to the service.
const here = dirname(fileURLToPath(import.meta.url));

export default defineNuxtConfig({
  extends: ["bmo-ui"],
  css: [join(here, "app/assets/css/terminal-fonts.css")],
  modules: [
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
  compatibilityDate: "2025-09-01",
  devtools: { enabled: false }
});
