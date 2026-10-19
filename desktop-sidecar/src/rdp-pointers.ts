// The desktop's pointer, read out of the server's stream (docs/remote.md, 「The pointer」).
//
// The web client release in use turns the server's pointer off in its own configuration and offers
// no way to turn it on, so it drops every pointer update and the browser shows its own arrow over
// the whole desktop. The relay reads the pointer updates as they pass and the page sets the shape
// itself. What is read here is the fast-path pointer updates: which shape, from the pointer cache or
// new, and a new shape's pixels as RGBA, top row first.

const FASTPATH_UPDATE_PTR_NULL = 0x5;
const FASTPATH_UPDATE_PTR_DEFAULT = 0x6;
const FASTPATH_UPDATE_COLOR = 0x9;
const FASTPATH_UPDATE_CACHED = 0xa;
const FASTPATH_UPDATE_POINTER = 0xb;
const FASTPATH_UPDATE_LARGE_POINTER = 0xc;

// The biggest shape a browser takes as a cursor.
const LARGEST_SIDE = 384;

export type PointerShape =
  | { type: "hidden" }
  | { type: "default" }
  | { type: "cached"; index: number }
  | { type: "image"; index: number; width: number; height: number; x: number; y: number; rgba: Uint8Array };

// Bytes of one scanline, padded to a two-byte boundary as every pointer mask is.
function scanline(width: number, bpp: number): number {
  return Math.ceil((width * bpp) / 16) * 2;
}

// The shape's pixels from its XOR and AND masks, both stored bottom row first. A pixel the AND mask
// keeps with a colour in the XOR mask inverts the screen under it; a browser cursor cannot, so it
// is drawn black, as the web client itself draws it.
export function pointerPixels(width: number, height: number, bpp: number, xor: Uint8Array, and: Uint8Array): Uint8Array | null {
  const xorLine = scanline(width, bpp);
  const andLine = scanline(width, 1);

  if (![1, 24, 32].includes(bpp) || xor.length < xorLine * height) return null;

  const hasAnd = and.length >= andLine * height;
  const rgba = new Uint8Array(width * height * 4);
  let alphaSeen = false;

  if (bpp === 32) {
    for (let row = 0; row < height && !alphaSeen; row += 1) {
      for (let column = 0; column < width; column += 1) {
        if (xor[row * xorLine + column * 4 + 3]! !== 0) {
          alphaSeen = true;
          break;
        }
      }
    }
  }

  for (let row = 0; row < height; row += 1) {
    const source = height - 1 - row;

    for (let column = 0; column < width; column += 1) {
      const kept = hasAnd ? (and[source * andLine + (column >> 3)]! >> (7 - (column & 7))) & 1 : 0;
      let red: number;
      let green: number;
      let blue: number;
      let alpha = 255;

      if (bpp === 1) {
        const bit = (xor[source * xorLine + (column >> 3)]! >> (7 - (column & 7))) & 1;

        red = green = blue = bit ? 255 : 0;
      } else {
        const at = source * xorLine + column * (bpp / 8);

        blue = xor[at]!;
        green = xor[at + 1]!;
        red = xor[at + 2]!;

        if (alphaSeen) alpha = xor[at + 3]!;
      }

      const coloured = red !== 0 || green !== 0 || blue !== 0;

      if (!alphaSeen && kept) {
        if (coloured) red = green = blue = 0;
        else alpha = 0;
      }

      const out = (row * width + column) * 4;

      rgba[out] = red;
      rgba[out + 1] = green;
      rgba[out + 2] = blue;
      rgba[out + 3] = alpha;
    }
  }

  return rgba;
}

// TS_COLORPOINTERATTRIBUTE, or the large pointer's own layout with four-byte mask lengths.
function readAttribute(view: DataView, bytes: Uint8Array, at: number, bpp: number, large: boolean): PointerShape | null {
  const head = large ? 18 : 14;

  if (at + head > bytes.length) return null;

  const index = view.getUint16(at, true);
  const x = view.getUint16(at + 2, true);
  const y = view.getUint16(at + 4, true);
  const width = view.getUint16(at + 6, true);
  const height = view.getUint16(at + 8, true);
  const andLength = large ? view.getUint32(at + 10, true) : view.getUint16(at + 10, true);
  const xorLength = large ? view.getUint32(at + 14, true) : view.getUint16(at + 12, true);
  const xorAt = at + head;

  if (width === 0 || height === 0 || width > LARGEST_SIDE || height > LARGEST_SIDE) return null;
  if (xorAt + xorLength + andLength > bytes.length) return null;

  const rgba = pointerPixels(width, height, bpp, bytes.subarray(xorAt, xorAt + xorLength), bytes.subarray(xorAt + xorLength, xorAt + xorLength + andLength));

  return rgba ? { type: "image", index, width, height, x: Math.min(x, width - 1), y: Math.min(y, height - 1), rgba } : null;
}

// One fast-path update read as a pointer shape, or null where it is not one or cannot be read.
export function readPointerUpdate(code: number, data: Uint8Array): PointerShape | null {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

  switch (code) {
    case FASTPATH_UPDATE_PTR_NULL:
      return { type: "hidden" };
    case FASTPATH_UPDATE_PTR_DEFAULT:
      return { type: "default" };
    case FASTPATH_UPDATE_CACHED:
      return data.length >= 2 ? { type: "cached", index: view.getUint16(0, true) } : null;
    case FASTPATH_UPDATE_COLOR:
      return readAttribute(view, data, 0, 24, false);
    case FASTPATH_UPDATE_POINTER:
      return data.length >= 2 ? readAttribute(view, data, 2, view.getUint16(0, true), false) : null;
    case FASTPATH_UPDATE_LARGE_POINTER:
      return data.length >= 2 ? readAttribute(view, data, 2, view.getUint16(0, true), true) : null;
    default:
      return null;
  }
}

// A shape as the text message the page's pointer socket carries.
export function pointerMessage(shape: PointerShape): string {
  if (shape.type !== "image") return JSON.stringify(shape);

  return JSON.stringify({ ...shape, rgba: Buffer.from(shape.rgba).toString("base64") });
}
