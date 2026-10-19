// The browser's half of the remote desktop's H.264 decoding (docs/remote.md, 「How it is reached」).
// The WebAssembly client hands over each AVC420 picture of the RDP graphics pipeline; WebCodecs
// decodes it and the regions it updates are read back as RGBA. The client waits for every picture
// before it reads the next command, so a decoder has to hand each picture out as soon as it is
// decoded. The build copies this file into the IronRDP checkout beside the module that imports it.

// High profile at level 5.1 covers every desktop size the console asks for.
const PROBE_CODEC = "avc1.640033";

// How long a stream's first picture may take before the decoder is taken to be holding pictures back.
const FIRST_PICTURE_WAIT_MS = 1000;

// RDP's YCbCr pictures are BT.709 at full range over sRGB pixels (MS-RDPEGFX, YUV420p conversion).
const COLOR_SPACE = { primaries: "bt709", transfer: "iec61966-2-1", matrix: "bt709", fullRange: true };

const RGBA = { format: "RGBA", colorSpace: "srgb" };

// Once a decode has failed in this page, the next connection offers no H.264 and draws as before.
let failed = false;

export async function avc420Supported(width, height) {
  if (failed || typeof VideoDecoder === "undefined" || typeof EncodedVideoChunk === "undefined") return false;

  try {
    const { supported } = await VideoDecoder.isConfigSupported({
      codec: PROBE_CODEC,
      codedWidth: width,
      codedHeight: height,
      optimizeForLatency: true,
    });

    return supported === true;
  } catch {
    return false;
  }
}

export class Avc420Decoder {
  #streams = new Map();
  #settings;

  constructor({ firstPictureWaitMs = FIRST_PICTURE_WAIT_MS } = {}) {
    this.#settings = { acceleration: "no-preference", prompt: false, firstPictureWaitMs };
  }

  // `bitstream` and `regions` are views of the WebAssembly memory, valid only until it next grows,
  // so both are copied before anything is awaited. `regions` holds x, y, width and height of each
  // region the picture updates; the picture covers its surface from the top-left corner.
  async decode(surfaceId, bitstream, key, codec, regions) {
    const data = bitstream.slice();
    const rects = Array.from(regions);

    try {
      let stream = this.#streams.get(surfaceId);

      if (!stream) {
        stream = new SurfaceStream(this.#settings);
        this.#streams.set(surfaceId, stream);
      }

      const picture = await stream.decode(data, key, codec);

      try {
        return await readRegions(picture, rects);
      } finally {
        picture.close();
      }
    } catch (error) {
      failed = true;
      throw error;
    }
  }

  close() {
    for (const stream of this.#streams.values()) stream.close();
    this.#streams.clear();
  }
}

// One surface's H.264 stream, decoded in order by a decoder of its own.
class SurfaceStream {
  #settings;
  #decoder = null;
  #config = null;
  #waiting = [];
  #timestamp = 0;

  constructor(settings) {
    this.#settings = settings;
  }

  async decode(data, key, codec) {
    if (key && codec) this.#configure(codec);
    if (!this.#config) throw new Error("H.264 stream does not start with a key picture");
    if (key && !this.#settings.prompt) return this.#decodeCheckingHold(data);

    return this.#decodeChunk(data, key);
  }

  close() {
    this.#reject(new Error("H.264 stream closed"));
    if (this.#decoder && this.#decoder.state !== "closed") this.#decoder.close();
  }

  // A decoder that keeps pictures for reordering hands this one out only after later ones, which
  // never come while the desktop stands still. RDP's pictures need no reordering, so such a
  // decoder's picture is flushed out and the stream goes on with the browser's software decoder,
  // which hands each picture out at once, starting again from the same key picture.
  async #decodeCheckingHold(data) {
    const picture = this.#decodeChunk(data, true);
    const prompt = await Promise.race([picture.then(() => true), delay(this.#settings.firstPictureWaitMs).then(() => false)]);

    if (prompt) {
      this.#settings.prompt = true;
      return picture;
    }

    if (this.#settings.acceleration === "prefer-software") throw new Error("H.264 decoder holds pictures back");

    await this.#decoder.flush();

    const held = await picture;

    try {
      this.#settings.acceleration = "prefer-software";
      this.#configure(this.#config.codec);
      (await this.#decodeCheckingHold(data)).close();
    } catch (error) {
      held.close();
      throw error;
    }

    return held;
  }

  #configure(codec) {
    const config = {
      codec,
      optimizeForLatency: true,
      hardwareAcceleration: this.#settings.acceleration,
      colorSpace: COLOR_SPACE,
    };

    if (this.#config && sameConfig(this.#config, config) && this.#decoder.state === "configured") return;

    this.#reject(new Error("H.264 stream configured again"));

    if (!this.#decoder || this.#decoder.state === "closed") {
      this.#decoder = new VideoDecoder({ output: (frame) => this.#output(frame), error: (error) => this.#fail(error) });
    }

    this.#decoder.configure(config);
    this.#config = config;
  }

  #decodeChunk(data, key) {
    return new Promise((resolve, reject) => {
      this.#decoder.decode(new EncodedVideoChunk({ type: key ? "key" : "delta", timestamp: this.#timestamp++, data }));
      this.#waiting.push({ resolve, reject });
    });
  }

  #output(frame) {
    const waiter = this.#waiting.shift();

    if (waiter) waiter.resolve(frame);
    else frame.close();
  }

  #fail(error) {
    this.#config = null;
    this.#reject(error);
  }

  #reject(error) {
    for (const waiter of this.#waiting.splice(0)) waiter.reject(error);
  }
}

function sameConfig(a, b) {
  return a.codec === b.codec && a.hardwareAcceleration === b.hardwareAcceleration;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readRegions(picture, rects) {
  let total = 0;

  for (let i = 0; i < rects.length; i += 4) total += rects[i + 2] * rects[i + 3] * 4;

  const pixels = new Uint8Array(total);
  let offset = 0;

  for (let i = 0; i < rects.length; i += 4) {
    const rect = { x: rects[i], y: rects[i + 1], width: rects[i + 2], height: rects[i + 3] };
    const target = pixels.subarray(offset, offset + rect.width * rect.height * 4);

    const retagged = await inRdpColours(picture, rect);
    const source = retagged ?? picture;
    const sourceRect = retagged ? undefined : rect;

    try {
      if (copiesAsRgba()) await source.copyTo(target, { rect: sourceRect, ...RGBA });
      else readThroughCanvas(source, sourceRect ?? { x: 0, y: 0, width: rect.width, height: rect.height }, target);
    } finally {
      retagged?.close();
    }

    offset += target.length;
  }

  return pixels;
}

// A decoder tags its pictures with the colour space the stream signals, or a default of its own
// where the stream signals none, whatever the configuration names. RDP's
// pictures are BT.709 at full range whatever they signal, so a region of a picture tagged otherwise
// is copied out in its own planes and read again under that colour space. A picture whose planes
// cannot be read is converted as it is tagged.
async function inRdpColours(picture, rect) {
  const tagged = picture.colorSpace;

  if (tagged.matrix === COLOR_SPACE.matrix && tagged.fullRange === COLOR_SPACE.fullRange) return null;
  if (!picture.format) return null;

  const planes = new Uint8Array(picture.allocationSize({ rect }));
  const layout = await picture.copyTo(planes, { rect });

  return new VideoFrame(planes, {
    format: picture.format,
    codedWidth: rect.width,
    codedHeight: rect.height,
    timestamp: picture.timestamp,
    layout,
    colorSpace: COLOR_SPACE,
  });
}

// Whether VideoFrame.copyTo converts to RGBA. A browser that does not know the option ignores it and
// copies the picture's own planes, so the size it asks for a tiny 4:2:0 picture tells the two apart.
let rgbaCopy;

function copiesAsRgba() {
  if (rgbaCopy === undefined) {
    const probe = new VideoFrame(new Uint8Array(6), { format: "I420", codedWidth: 2, codedHeight: 2, timestamp: 0 });

    try {
      rgbaCopy = probe.allocationSize(RGBA) === 16;
    } catch {
      rgbaCopy = false;
    } finally {
      probe.close();
    }
  }

  return rgbaCopy;
}

let canvas;

function readThroughCanvas(picture, rect, target) {
  canvas ??= typeof OffscreenCanvas === "undefined" ? document.createElement("canvas") : new OffscreenCanvas(1, 1);
  if (canvas.width < rect.width) canvas.width = rect.width;
  if (canvas.height < rect.height) canvas.height = rect.height;

  const context = canvas.getContext("2d", { willReadFrequently: true });

  context.drawImage(picture, rect.x, rect.y, rect.width, rect.height, 0, 0, rect.width, rect.height);
  target.set(context.getImageData(0, 0, rect.width, rect.height).data);
}
