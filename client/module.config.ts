import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import vue from "@vitejs/plugin-vue";
import AutoImport from "unplugin-auto-import/vite";
import Components from "unplugin-vue-components/vite";
import { defineConfig } from "vite";

import type { ConsoleWords } from "bmo-ui/shared/console-manifest";
import type { ComponentResolver } from "unplugin-vue-components";
import type { Plugin } from "vite";

// The served module's build (docs/api.md, "The console plugin bundle"): the screen's pages built for the
// browser as one ECMAScript module, its stylesheet and its words beside it in dist/, which the service
// answers. What Nuxt gives the pages by name is imported here by the package's own path, and every path of
// the libraries the console shares is left unbundled, so the console resolves each to its own copy.
const here = dirname(fileURLToPath(import.meta.url));
const host = join(here, "module/host.ts");

// The libraries a console shares with every bundle it loads (bmo-ui's console plugin contract, "What a
// bundle is").
const SHARED = /^(?:vue|vue-router|vue-i18n|nuxt\/app|@nuxt\/ui|bmo-ui)(?:\/|$)/;

// What a Nuxt host makes importable by name, each from the package that holds it.
const NUXT_IMPORTS = ["useRoute", "useRouter", "useHead", "useRuntimeConfig", "useAppConfig"];

// The console's title-bar pieces the screen draws, which the module stands in itself (module/host.ts).
const HOST_PIECES = ["DeployMark", "TodoOpenButton", "UsageMeters"];

// A component library's component by the name Nuxt registers it under: Nuxt UI's under its `U` prefix, and
// bmo-ui's by its file's own name.
const libraryComponents: ComponentResolver = (name) => {
  const nuxtUi = name.startsWith("U") ? name.slice(1) : null;

  if (nuxtUi !== null && existsSync(join(here, "node_modules/@nuxt/ui/dist/runtime/components", `${nuxtUi}.vue`))) {
    return { name: "default", from: `@nuxt/ui/components/${nuxtUi}.vue` };
  }

  if (existsSync(join(here, "node_modules/bmo-ui/app/components", `${name}.vue`))) {
    return { name: "default", from: `bmo-ui/app/components/${name}.vue` };
  }

  return HOST_PIECES.includes(name) ? { name, from: host } : undefined;
};

// The bundle's words as the service answers them: each language file's tree under its locale's code.
const words: Plugin = {
  name: "bmo-remote-words",
  generateBundle() {
    const folder = join(here, "i18n");
    const all: ConsoleWords = {};

    for (const file of readdirSync(folder).filter((name) => name.endsWith(".json"))) {
      all[basename(file, ".json")] = JSON.parse(readFileSync(join(folder, file), "utf8")) as Record<string, unknown>;
    }

    this.emitFile({ type: "asset", fileName: "words.json", source: `${JSON.stringify(all)}\n` });
  }
};

export default defineConfig({
  root: here,
  plugins: [
    vue(),
    tailwindcss(),
    AutoImport({
      imports: ["vue", { "nuxt/app": NUXT_IMPORTS }, { "vue-i18n": ["useI18n"] }, { [host]: ["useKeptTabs", "definePageMeta"] }],
      dts: false
    }),
    Components({ dirs: ["app/components"], resolvers: [libraryComponents], dts: false }),
    words
  ],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    copyPublicDir: false,
    lib: { entry: join(here, "module/main.ts"), formats: ["es"], fileName: () => "remote.js", cssFileName: "remote" },
    rollupOptions: {
      external: (id) => SHARED.test(id),
      // Library mode inlines every asset, so the stylesheet is the one asset the build writes.
      output: { chunkFileNames: "chunks/[name]-[hash].js", assetFileNames: "[name][extname]" }
    }
  }
});
