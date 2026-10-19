import { sidecarToken } from "./settings";

// What a desktop websocket must show before the sidecar upgrades it (docs/api.md, 「The desktop sidecar」):
// the bearer the service was given it with. The sign-in and the page's `Origin` are checked by the console in
// front of the service, and the service checks its own token before it hands an upgrade on.

interface UpgradeLike {
  url: string;
  headers: Headers;
}

// Refusals are thrown as responses, which is how the socket hooks are told not to upgrade.
export async function guardUpgrade(request: UpgradeLike): Promise<void> {
  if (request.headers.get("authorization") !== `Bearer ${sidecarToken()}`) {
    throw new Response("Unauthorized", { status: 401 });
  }
}
