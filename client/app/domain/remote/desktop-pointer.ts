// The desktop's pointer shape on the page (docs/remote.md, 「The pointer」). The web client drops the
// server's pointer, so the relay reads the shapes out of the stream and sends them over a socket of
// their own; this turns each one into the CSS cursor the desktop's canvas shows.

// The largest cursor a browser shows everywhere: a bigger one falls back to the system arrow near the
// window's edges, so a bigger shape is scaled down to this, as the web client itself does.
const CURSOR_SIDE = 32;

export type PointerMessage =
  | { type: "hidden" }
  | { type: "default" }
  | { type: "cached"; index: number }
  | { type: "image"; index: number; width: number; height: number; x: number; y: number; rgba: string };

// A PNG data URL of the pixels; the page's canvas makes it, a test its own stand-in.
export type Rasterise = (rgba: Uint8ClampedArray<ArrayBuffer>, width: number, height: number, side: { width: number; height: number }) => string;

export function readPointerMessage(text: unknown): PointerMessage | null {
  if (typeof text !== "string") return null;

  try {
    const message = JSON.parse(text) as Partial<PointerMessage> & Record<string, unknown>;

    switch (message.type) {
      case "hidden":
      case "default":
        return { type: message.type };
      case "cached":
        return typeof message.index === "number" ? { type: "cached", index: message.index } : null;
      case "image":
        return [message.index, message.width, message.height, message.x, message.y].every((one) => typeof one === "number") && typeof message.rgba === "string"
          ? (message as PointerMessage)
          : null;
      default:
        return null;
    }
  } catch {
    return null;
  }
}

// Keeps the shapes by their cache index and answers each message with the cursor to show: a CSS
// cursor value, or null for the page's default arrow. An index never seen gives the default arrow.
export function createPointerShapes(rasterise: Rasterise) {
  const shapes = new Map<number, string>();

  return (message: PointerMessage): string | null => {
    switch (message.type) {
      case "hidden":
        return "none";
      case "default":
        return null;
      case "cached":
        return shapes.get(message.index) ?? null;
      case "image": {
        const scale = Math.min(1, CURSOR_SIDE / Math.max(message.width, message.height));
        const side = { width: Math.max(1, Math.round(message.width * scale)), height: Math.max(1, Math.round(message.height * scale)) };
        const bytes = Uint8ClampedArray.from(atob(message.rgba), (char) => char.charCodeAt(0));

        if (bytes.length !== message.width * message.height * 4) return null;

        const css = `url(${rasterise(bytes, message.width, message.height, side)}) ${Math.floor(message.x * scale)} ${Math.floor(message.y * scale)}, default`;

        shapes.set(message.index, css);

        return css;
      }
    }
  };
}

// The browser's own rasteriser: the pixels on a canvas, scaled to the side asked for.
export const canvasRasterise: Rasterise = (rgba, width, height, side) => {
  const source = document.createElement("canvas");

  source.width = width;
  source.height = height;
  source.getContext("2d")!.putImageData(new ImageData(rgba, width, height), 0, 0);

  if (side.width === width && side.height === height) return source.toDataURL("image/png");

  const scaled = document.createElement("canvas");
  const context = scaled.getContext("2d")!;

  scaled.width = side.width;
  scaled.height = side.height;
  context.imageSmoothingQuality = "high";
  context.drawImage(source, 0, 0, side.width, side.height);

  return scaled.toDataURL("image/png");
};

// A pointer channel's name for one connection.
export function pointerChannelId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(12)), (byte) => byte.toString(36).padStart(2, "0")).join("").slice(0, 24);
}
