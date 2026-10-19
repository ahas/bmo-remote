// The parts of the remote screen's shapes the service answers in (docs/api.md, 「Terminal sessions」 and
// 「The desktop sockets」), held by the bundle itself.

export const REMOTE_DESKTOP_QUALITIES = ["fast", "balanced", "sharp"] as const;

export type RemoteDesktopQuality = (typeof REMOTE_DESKTOP_QUALITIES)[number];

export function isRemoteDesktopQuality(value: unknown): value is RemoteDesktopQuality {
  return typeof value === "string" && (REMOTE_DESKTOP_QUALITIES as readonly string[]).includes(value);
}

// One terminal session of the remote screen, as tmux holds it (docs/remote.md).
export interface RemoteTerminalInfo {
  id: string;
  label: string;
  // Milliseconds since the epoch.
  createdAt: number;
  attached: number;
}
