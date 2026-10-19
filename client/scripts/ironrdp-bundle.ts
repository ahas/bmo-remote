// What the IronRDP build's bundle needs before the console's own build can take it (docs/remote.md,
// 「How it is reached」). The bundle inlines its WebAssembly as a data URL handed to `new URL` with
// `import.meta.url` as the base; a data URL is absolute and never reads the base, but the base is what
// makes the console's bundler scan the whole literal for an asset, and a literal of megabytes overflows
// the stack of that scan. So the base is dropped.
const INLINED_WASM = /new URL\(("data:application\/wasm;base64,[A-Za-z0-9+/=]*")\s*,\s*import\.meta\.url\s*\)/g;

export function unbaseInlinedWasm(bundle: string): string {
  return bundle.replace(INLINED_WASM, "new URL($1)");
}
