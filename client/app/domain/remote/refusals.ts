import type { Translate } from "bmo-ui/shared/wording";

// The service answers a refusal with a kebab-case code and an English sentence, and a terminal socket's
// error message names its cause under `reason` where the code says one (docs/api.md, 「Refusals」 and 「The
// terminal socket」). The screen says it in the bundle's language pack: under `remote.error.` by its code,
// but for the terminal client letting go while its session stands, which is a status rather than an error.

const STATUS_CODES: ReadonlySet<string> = new Set(["terminal-disconnected"]);

interface Refusal {
  code?: unknown;
  reason?: unknown;
}

// The words for a refusal's body, or null where it carries no code.
export function refusalText(t: Translate, body: unknown): string | null {
  const refusal = (body ?? {}) as Refusal;

  if (typeof refusal.code !== "string" || refusal.code === "") return null;

  const group = STATUS_CODES.has(refusal.code) ? "status" : "error";
  const reason = typeof refusal.reason === "string" ? refusal.reason : "";

  return t(`remote.${group}.${refusal.code}`, { reason });
}

// The words for a failed request to the service's routes, or `fallback` where its answer named no code.
export function failureText(t: Translate, failure: unknown, fallback: string): string {
  return refusalText(t, (failure as { data?: unknown }).data) ?? fallback;
}
