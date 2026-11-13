import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import vue from "@vitejs/plugin-vue";
import { consoleBundle } from "bmo-ui/bundle/console-bundle.js";
import AutoImport from "unplugin-auto-import/vite";
import Components from "unplugin-vue-components/vite";
import { defineConfig } from "vite";

import type { ConsoleWords } from "bmo-ui/shared/console-manifest";
import type { ComponentResolver } from "unplugin-vue-components";
import type { Plugin } from "vite";

// The served module's build, on bmo-ui's bundle build (docs/api.md, "The console plugin bundle"): the
// screen's pages built for the browser as one ECMAScript module, its stylesheet, its words and the layer it
// was built on beside it in dist/, which the service answers through its console face. What Nuxt gives the
// pages by name is imported here by the package's own path; bmo-ui's plugin leaves the libraries the console
// shares unbundled, so the console resolves each to its own copy.
const here = dirname(fileURLToPath(import.meta.url));
const host = join(here, "module/host.ts");

// What a Nuxt host makes importable by name, each from the package that holds it.
const NUXT_IMPORTS = ["useRoute", "useRouter", "useHead", "useRuntimeConfig", "useAppConfig"];

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

  return undefined;
};

// The bundle's words as the service answers them: each language file's tree under its locale's code.
function readWords(): ConsoleWords {
  const folder = join(here, "i18n");
  const all: ConsoleWords = {};

  for (const file of readdirSync(folder).filter((name) => name.endsWith(".json"))) {
    all[basename(file, ".json")] = JSON.parse(readFileSync(join(folder, file), "utf8")) as Record<string, unknown>;
  }

  return all;
}

const WORDS = readWords();

const words: Plugin = {
  name: "bmo-remote-words",
  generateBundle() {
    this.emitFile({ type: "asset", fileName: "words.json", source: `${JSON.stringify(WORDS)}\n` });
  }
};

export default defineConfig({
  root: here,
  plugins: [
    consoleBundle({ name: "remote", words: WORDS }),
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
      // Library mode inlines every asset, so the stylesheet is the one asset the build writes.
      output: { chunkFileNames: "chunks/[name]-[hash].js", assetFileNames: "[name][extname]" }
    }
  }
});
