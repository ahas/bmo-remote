// The qualities a desktop connection draws at (docs/remote.md, 「Connection settings」), as the relay reads
// a socket's `quality` query.

export const REMOTE_DESKTOP_QUALITIES = ["fast", "balanced", "sharp"] as const;

export type RemoteDesktopQuality = (typeof REMOTE_DESKTOP_QUALITIES)[number];

export function isRemoteDesktopQuality(value: unknown): value is RemoteDesktopQuality {
  return typeof value === "string" && (REMOTE_DESKTOP_QUALITIES as readonly string[]).includes(value);
}
