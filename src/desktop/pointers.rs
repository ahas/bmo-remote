//! The desktop's pointer, read out of the server's stream (`docs/remote.md`, 「The pointer」).
//!
//! The web client release in use turns the server's pointer off in its own configuration and offers no way
//! to turn it on, so it drops every pointer update and the browser shows its own arrow over the whole
//! desktop. The relay reads the pointer updates as they pass and the page sets the shape itself. What is read
//! here is the fast-path pointer updates: which shape, from the pointer cache or new, and a new shape's
//! pixels as RGBA, top row first.

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use ironrdp_pdu::fast_path::{FastPathUpdate, UpdateCode};
use ironrdp_pdu::pointer::{Point16, PointerUpdateData};
use serde::{Serialize, Serializer};

// The biggest shape a browser takes as a cursor.
const LARGEST_SIDE: u16 = 384;

// The colour depth of a colour pointer update, which names none.
const COLOR_POINTER_BPP: u16 = 24;

/// One pointer shape, as the page's pointer socket carries it (`docs/api.md`,
/// 「`/api/remote/desktop/pointer`」).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum PointerShape {
  Hidden,
  Default,
  Cached {
    index: u16,
  },
  Image {
    index: u16,
    width: u16,
    height: u16,
    x: u16,
    y: u16,
    #[serde(serialize_with = "base64_text")]
    rgba: Vec<u8>,
  },
}

fn base64_text<S: Serializer>(bytes: &[u8], serializer: S) -> Result<S::Ok, S::Error> {
  serializer.serialize_str(&STANDARD.encode(bytes))
}

/// Bytes of one scanline, padded to a two-byte boundary as every pointer mask is.
fn scanline(width: usize, bpp: usize) -> usize {
  (width * bpp).div_ceil(16) * 2
}

/// A mask bit, the highest bit of a byte first.
fn bit(mask: &[u8], line_at: usize, column: usize) -> bool {
  (mask[line_at + (column >> 3)] >> (7 - (column & 7))) & 1 == 1
}

/// The shape's pixels from its XOR and AND masks, both stored bottom row first. A pixel the AND mask keeps
/// with a colour in the XOR mask inverts the screen under it; a browser cursor cannot, so it is drawn black,
/// as the web client itself draws it.
pub fn pointer_pixels(width: u16, height: u16, bpp: u16, xor: &[u8], and: &[u8]) -> Option<Vec<u8>> {
  let (width, height, bpp) = (usize::from(width), usize::from(height), usize::from(bpp));
  let xor_line = scanline(width, bpp);
  let and_line = scanline(width, 1);

  if !matches!(bpp, 1 | 24 | 32) || xor.len() < xor_line * height {
    return None;
  }

  let has_and = and.len() >= and_line * height;
  let mut rgba = vec![0; width * height * 4];
  // A 32-bit shape with any alpha of its own is drawn by that alpha, its AND mask left aside.
  let alpha_seen =
    bpp == 32 && (0..height).any(|row| (0..width).any(|column| xor[row * xor_line + column * 4 + 3] != 0));

  for row in 0..height {
    let source = height - 1 - row;

    for column in 0..width {
      let kept = has_and && bit(and, source * and_line, column);
      let (mut red, mut green, mut blue);
      let mut alpha = 255;

      if bpp == 1 {
        let level = if bit(xor, source * xor_line, column) { 255 } else { 0 };

        (red, green, blue) = (level, level, level);
      } else {
        let at = source * xor_line + column * (bpp / 8);

        (blue, green, red) = (xor[at], xor[at + 1], xor[at + 2]);

        if alpha_seen {
          alpha = xor[at + 3];
        }
      }

      let coloured = red != 0 || green != 0 || blue != 0;

      if !alpha_seen && kept {
        if coloured {
          (red, green, blue) = (0, 0, 0);
        } else {
          alpha = 0;
        }
      }

      let out = (row * width + column) * 4;

      rgba[out..out + 4].copy_from_slice(&[red, green, blue, alpha]);
    }
  }

  Some(rgba)
}

/// A new shape from its attribute: refused where a side is none or larger than a cursor takes, or its masks
/// cannot be drawn. The hot spot is kept inside the shape.
fn image(
  index: u16,
  hot_spot: Point16,
  width: u16,
  height: u16,
  bpp: u16,
  xor: &[u8],
  and: &[u8],
) -> Option<PointerShape> {
  if width == 0 || height == 0 || width > LARGEST_SIDE || height > LARGEST_SIDE {
    return None;
  }

  let rgba = pointer_pixels(width, height, bpp, xor, and)?;

  Some(PointerShape::Image {
    index,
    width,
    height,
    x: hot_spot.x.min(width - 1),
    y: hot_spot.y.min(height - 1),
    rgba,
  })
}

/// One fast-path update read as a pointer shape, or none where it is not one or cannot be read. Only the
/// pointer update codes are decoded, so no bitmap or surface update is read here.
pub fn read_pointer_update(code: UpdateCode, data: &[u8]) -> Option<PointerShape> {
  if !matches!(
    code,
    UpdateCode::HiddenPointer
      | UpdateCode::DefaultPointer
      | UpdateCode::ColorPointer
      | UpdateCode::CachedPointer
      | UpdateCode::NewPointer
      | UpdateCode::LargePointer
  ) {
    return None;
  }

  let FastPathUpdate::Pointer(pointer) = FastPathUpdate::decode_with_code(data, code).ok()? else {
    return None;
  };

  match pointer {
    PointerUpdateData::SetHidden => Some(PointerShape::Hidden),
    PointerUpdateData::SetDefault => Some(PointerShape::Default),
    PointerUpdateData::Cached(cached) => Some(PointerShape::Cached {
      index: cached.cache_index,
    }),
    PointerUpdateData::Color(color) => image(
      color.cache_index,
      color.hot_spot,
      color.width,
      color.height,
      COLOR_POINTER_BPP,
      color.xor_mask,
      color.and_mask,
    ),
    PointerUpdateData::New(new) => {
      let color = new.color_pointer;

      image(
        color.cache_index,
        color.hot_spot,
        color.width,
        color.height,
        new.xor_bpp,
        color.xor_mask,
        color.and_mask,
      )
    }
    PointerUpdateData::Large(large) => image(
      large.cache_index,
      large.hot_spot,
      large.width,
      large.height,
      large.xor_bpp,
      large.xor_mask,
      large.and_mask,
    ),
    PointerUpdateData::SetPosition(_) => None,
  }
}

/// A shape as the text message the page's pointer socket carries, the pixels of a new one in base64.
pub fn pointer_message(shape: &PointerShape) -> String {
  serde_json::to_string(shape).expect("a pointer shape is always JSON")
}
