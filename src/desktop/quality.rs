//! The qualities a desktop connection is drawn at, named by the desktop socket's `quality` query
//! (`docs/remote.md`, 「Connection settings」). The screen keeps its own list of the same names for its menu.

/// One quality, and the RDP performance flags it puts into the logon packet in place of the client's own.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Quality {
  Fast,
  Balanced,
  Sharp,
}

// TS_INFO_PACKET's performance flags (MS-RDPBCGR 2.2.1.11.1.1.1).
const DISABLE_WALLPAPER: u32 = 0x01;
const DISABLE_FULL_WINDOW_DRAG: u32 = 0x02;
const DISABLE_MENU_ANIMATIONS: u32 = 0x04;
const DISABLE_THEMING: u32 = 0x08;
const DISABLE_CURSOR_SHADOW: u32 = 0x20;
const DISABLE_CURSOR_SETTINGS: u32 = 0x40;
const ENABLE_FONT_SMOOTHING: u32 = 0x80;
const ENABLE_DESKTOP_COMPOSITION: u32 = 0x100;

impl Quality {
  /// The quality a query names, or none where it names none of the three.
  pub fn named(name: &str) -> Option<Self> {
    match name {
      "fast" => Some(Self::Fast),
      "balanced" => Some(Self::Balanced),
      "sharp" => Some(Self::Sharp),
      _ => None,
    }
  }

  /// The performance flags the logon packet is given at this quality.
  pub fn performance_flags(self) -> u32 {
    match self {
      // Everything that costs drawing is left out.
      Self::Fast => {
        DISABLE_WALLPAPER
          | DISABLE_FULL_WINDOW_DRAG
          | DISABLE_MENU_ANIMATIONS
          | DISABLE_THEMING
          | DISABLE_CURSOR_SHADOW
          | DISABLE_CURSOR_SETTINGS
      }
      // The wallpaper, the animations and the cursor shadow are left out.
      Self::Balanced => DISABLE_WALLPAPER | DISABLE_MENU_ANIMATIONS | DISABLE_CURSOR_SHADOW,
      // Everything is drawn, with smoothed fonts and composition.
      Self::Sharp => ENABLE_FONT_SMOOTHING | ENABLE_DESKTOP_COMPOSITION,
    }
  }
}
